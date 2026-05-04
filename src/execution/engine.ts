import { assertAndClaim } from '@classytic/primitives/state-machine';
import { TIMING } from '../config/constants.js';
import type { StreamlineContainer } from '../core/container.js';
import { globalEventBus, type WorkflowEventBus } from '../core/events.js';
import { isTerminalState, RUN_MACHINE } from '../core/status.js';
import type {
  StepState,
  WorkflowDefinition,
  WorkflowEventPayload,
  WorkflowHandlers,
  WorkflowRun,
} from '../core/types.js';
import type { WorkflowCache } from '../storage/cache.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import { runSet } from '../storage/update-builders.js';
import {
  InvalidStateError,
  StepNotFoundError,
  toError,
  WorkflowNotFoundError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { WorkflowRegistry } from '../workflow/registry.js';
import { StepExecutor } from './executor.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  SmartScheduler,
  type SmartSchedulerConfig,
} from './smart-scheduler.js';

// ============================================================================
// Hook Registry (inlined from hook-registry.ts)
// ============================================================================

/**
 * Registry mapping runId to the engine managing that run.
 * Enables resumeHook() to find the correct engine for resuming.
 */
class HookRegistry {
  private engines = new Map<string, WeakRef<WorkflowEngine<unknown>>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  register(runId: string, engine: WorkflowEngine<unknown>): void {
    this.engines.set(runId, new WeakRef(engine));

    // Lazily start cleanup interval on first registration
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => this.cleanup(), TIMING.HOOK_CLEANUP_INTERVAL_MS);
      this.cleanupInterval.unref();
    }
  }

  unregister(runId: string): void {
    this.engines.delete(runId);
  }

  getEngine(runId: string): WorkflowEngine<unknown> | undefined {
    const ref = this.engines.get(runId);
    if (!ref) return undefined;

    const engine = ref.deref();
    if (!engine) {
      this.engines.delete(runId);
      return undefined;
    }

    return engine;
  }

  private cleanup(): void {
    for (const [runId, ref] of this.engines) {
      if (!ref.deref()) {
        this.engines.delete(runId);
      }
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.engines.clear();
  }
}

/** Global hook registry instance */
export const hookRegistry = new HookRegistry();

// ============================================================================
// Workflow Registry (for child workflow lookup by workflowId)
// ============================================================================

/**
 * Global registry mapping workflowId → engine.
 * Populated by createWorkflow(). Enables ctx.startChildWorkflow() to find
 * and start child workflows by ID without the caller needing a reference.
 */
class WorkflowRegistryGlobal {
  private engines = new Map<string, WeakRef<WorkflowEngine<unknown>>>();

  register(workflowId: string, engine: WorkflowEngine<unknown>): void {
    this.engines.set(workflowId, new WeakRef(engine));
  }

  getEngine(workflowId: string): WorkflowEngine<unknown> | undefined {
    const ref = this.engines.get(workflowId);
    if (!ref) return undefined;
    const engine = ref.deref();
    if (!engine) {
      this.engines.delete(workflowId);
      return undefined;
    }
    return engine;
  }
}

export const workflowRegistry = new WorkflowRegistryGlobal();

// ============================================================================
// Inline Utilities
// ============================================================================

/**
 * Clean up all event listeners for a specific workflow.
 *
 * Listeners fall into three key shapes:
 *   - `<runId>:<event>`              → container event-bus listener
 *   - `global:<runId>:<event>`       → globalEventBus listener (same fn wrapped)
 *   - `signal:<runId>:<event>`       → SignalStore unsub closure
 */
function cleanupEventListeners(
  runId: string,
  listeners: Map<string, { listener: (...args: unknown[]) => void; eventName: string }>,
  eventBus: WorkflowEventBus,
): void {
  const prefixes = [`${runId}:`, `global:${runId}:`, `signal:${runId}:`];
  const keysToRemove = Array.from(listeners.keys()).filter((key) =>
    prefixes.some((p) => key.startsWith(p)),
  );

  for (const key of keysToRemove) {
    const entry = listeners.get(key);
    if (!entry) continue;

    if (key.startsWith('signal:')) {
      // Signal store unsub: the listener IS the unsub closure — call it.
      entry.listener();
    } else if (key.startsWith('global:')) {
      // Remove from globalEventBus (shared across all containers).
      globalEventBus.off(entry.eventName, entry.listener);
    } else {
      // Container event bus listener.
      eventBus.off(entry.eventName, entry.listener);
    }
    listeners.delete(key);
  }
}

/**
 * Handle short delay (< 5s) inline or schedule for later
 */
async function handleShortDelayOrSchedule(
  runId: string,
  targetTime: Date,
  scheduleLongDelay: () => void,
  repository: WorkflowRunRepository,
  cache: WorkflowCache,
): Promise<boolean> {
  const delayMs = targetTime.getTime() - Date.now();

  if (delayMs > 0 && delayMs <= TIMING.SHORT_DELAY_THRESHOLD_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const remaining = targetTime.getTime() - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining + 10));
    }
  }

  if (delayMs <= TIMING.SHORT_DELAY_THRESHOLD_MS) {
    // Status-transition CAS — `assertAndClaim` runs `RUN_MACHINE.assertTransition`
    // (sync, in-memory) before the Mongo CAS. An illegal `waiting → running`
    // would be a programmer bug; the sync throw surfaces it before the
    // round-trip. The CAS itself still rejects concurrent writers via null.
    const claimed = await assertAndClaim(RUN_MACHINE, repository, runId, {
      from: 'waiting',
      to: 'running',
      where: { paused: { $ne: true } },
      patch: { lastHeartbeat: new Date(), updatedAt: new Date() },
      options: { bypassTenant: true },
    });

    if (claimed) {
      cache.delete(runId);
      return true;
    }

    return false;
  }

  scheduleLongDelay();
  return false;
}

export interface WorkflowEngineOptions {
  /** Auto-execute workflow after start (default: true) */
  autoExecute?: boolean;
  /** Custom scheduler configuration */
  scheduler?: Partial<SmartSchedulerConfig>;
  /**
   * Compensation handlers for saga pattern rollback.
   * Keyed by stepId. Called in reverse order when a later step fails.
   */
  compensationHandlers?: WorkflowHandlers<unknown>;
}

/**
 * Core workflow execution engine.
 *
 * Manages workflow lifecycle: start, execute, pause, resume, cancel.
 * Handles waiting states, retries, and crash recovery automatically.
 *
 * @typeParam TContext - Type of workflow context
 *
 * @example
 * ```typescript
 * const engine = new WorkflowEngine(definition, handlers, container);
 * const run = await engine.start({ orderId: '123' });
 * ```
 */
export class WorkflowEngine<TContext = Record<string, unknown>> {
  private readonly executor: StepExecutor<TContext>;
  private scheduler: SmartScheduler; // Mutable: reconfigured in updateSchedulerConfig()
  private readonly registry: WorkflowRegistry<TContext>;
  private readonly options: WorkflowEngineOptions;
  private readonly eventListeners = new Map<
    string,
    { listener: (...args: unknown[]) => void; eventName: string }
  >();

  /** Exposed for hook registry and external access */
  readonly container: StreamlineContainer;

  constructor(
    definition: WorkflowDefinition<TContext>,
    public readonly handlers: WorkflowHandlers<TContext>,
    container: StreamlineContainer,
    options: WorkflowEngineOptions = {},
  ) {
    this.container = container;
    this.registry = new WorkflowRegistry(definition, handlers);
    this.executor = new StepExecutor(
      this.registry,
      container.repository,
      container.eventBus,
      container.cache,
      container.signalStore,
    );

    const schedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      ...options.scheduler,
    };

    this.scheduler = new SmartScheduler(
      container.repository,
      async (runId) => {
        await this.resume(runId);
      },
      schedulerConfig,
      container.eventBus,
    );

    // Register in global workflow registry for child workflow lookup
    workflowRegistry.register(definition.id, this as unknown as WorkflowEngine<unknown>);

    // Set stale recovery callback for crashed workflows
    this.scheduler.setStaleRecoveryCallback(async (runId, thresholdMs) => {
      return this.recoverStale(runId, thresholdMs);
    });

    // Set retry callback for exponential backoff retries
    this.scheduler.setRetryCallback(async (runId) => {
      return this.executeRetry(runId);
    });

    // Smart start: Only start polling if workflows exist
    this.scheduler.startIfNeeded().catch((err) => {
      this.container.eventBus.emit('engine:error', {
        runId: undefined,
        error: err,
        context: 'scheduler-start',
      });
    });

    // Strict-concurrency slot release: when a run reaches terminal state,
    // read its `meta.concurrencyCounterId` and decrement the counter. The
    // listener stays for the engine's lifetime; it's a no-op for runs
    // without the meta marker (best-effort or non-concurrency-gated runs).
    //
    // Why on the bus and not in the executor's terminal write paths:
    // there are 4 distinct terminal-write sites (executor success path,
    // executor failed path, engine.cancel, engine.failCorruption); event
    // emission is the single fan-in. Listening here means we never miss
    // a release no matter which path produced the terminal state.
    const releaseSlotOnTerminal = async (payload: { runId?: string }) => {
      if (!payload.runId) return;
      try {
        const run = await this.container.repository.getById(payload.runId);
        const counterId = (run?.meta as Record<string, unknown> | undefined)
          ?.concurrencyCounterId as string | undefined;
        if (counterId) {
          await this.container.concurrencyCounterRepository.releaseSlot(counterId);
        }
      } catch (err) {
        // Release failures are diagnostic — the counter will drift +1 until
        // reconciled. Don't crash the event-bus listener loop.
        this.container.eventBus.emit('engine:error', {
          runId: payload.runId,
          error: err instanceof Error ? err : new Error(String(err)),
          context: 'concurrency-counter-release',
        });
      }
    };
    this.container.eventBus.on('workflow:completed', releaseSlotOnTerminal);
    this.container.eventBus.on('workflow:failed', releaseSlotOnTerminal);
    this.container.eventBus.on('workflow:cancelled', releaseSlotOnTerminal);

    this.options = { autoExecute: true, ...options };
  }

  /** Get the workflow definition */
  get definition(): WorkflowDefinition<TContext> {
    return this.registry.definition;
  }

  /**
   * Start a new workflow run.
   *
   * @param input - Input data for the workflow
   * @param options - Optional: meta, idempotencyKey, priority, concurrencyKey, cancelOn, startAsDraft
   * @returns The created workflow run (or existing run if idempotencyKey matches)
   */
  async start(
    input: unknown,
    options?: {
      meta?: Record<string, unknown>;
      idempotencyKey?: string;
      priority?: number;
      concurrencyKey?: string;
      startAsDraft?: boolean;
      /**
       * Schedule this run to fire at a future time. Forces the run to start
       * as a draft with `scheduling.executionTime` set; the smart scheduler's
       * scheduled-draft pickup path transitions it to running when the time
       * passes. Used by throttle/debounce gates in `define.ts`.
       */
      scheduledExecutionTime?: Date;
      cancelOn?: Array<{ event: string }>;
      /**
       * Tenant context forwarded to `repository.create` (and the idempotency
       * lookup). Required when the repository was constructed with
       * `multiTenant.strict: true`; the tenant-filter plugin throws on
       * `before:create` / `before:getOne` if missing. Single-tenant or
       * `staticTenantId` deployments can omit.
       */
      tenantId?: string;
      bypassTenant?: boolean;
    },
  ): Promise<WorkflowRun<TContext>> {
    const run = this.registry.createRun(input, options?.meta);

    // Set distributed primitive fields
    if (options?.idempotencyKey) run.idempotencyKey = options.idempotencyKey;
    if (options?.priority) run.priority = options.priority;
    if (options?.concurrencyKey) run.concurrencyKey = options.concurrencyKey;

    const tenantOpts = {
      ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options?.bypassTenant ? { bypassTenant: true } : {}),
    };

    // Idempotency: if a non-terminal run with this key exists, return it.
    // Terminal runs (done/failed/cancelled) don't block — the key is reusable.
    // Tenant-scoped lookup — strict mode requires explicit context.
    if (options?.idempotencyKey) {
      const existing = await this.container.repository.findActiveByIdempotencyKey(
        options.idempotencyKey,
        tenantOpts,
      );
      if (existing) return existing as WorkflowRun<TContext>;
    }

    // Scheduled execution (throttle/debounce gates): force draft with a
    // future executionTime. SchedulingInfo's other fields are required by
    // the schema, so we synthesize sensible UTC defaults — the only field
    // the scheduler actually queries is executionTime.
    if (options?.scheduledExecutionTime) {
      const fireAt = options.scheduledExecutionTime;
      run.status = 'draft';
      run.scheduling = {
        executionTime: fireAt,
        scheduledFor: fireAt.toISOString(),
        timezone: 'UTC',
        localTimeDisplay: fireAt.toISOString(),
        isDSTTransition: false,
      };
    } else if (options?.startAsDraft) {
      // Concurrency-limited: start as draft (scheduler will promote when slot opens)
      run.status = 'draft';
    } else {
      run.status = 'running';
      run.startedAt = new Date();
    }

    // Tenant context forwarded — strict-mode `before:create` hook fires
    // here and demands `tenantId` (or `bypassTenant: true`); single-tenant
    // / `staticTenantId` deployments pass nothing and the plugin no-ops.
    await this.container.repository.create(run, tenantOpts);

    this.container.cache.set(run);
    hookRegistry.register(run._id, this as unknown as WorkflowEngine<unknown>);

    // Register cancelOn event listeners
    if (options?.cancelOn) {
      for (const trigger of options.cancelOn) {
        const cancelListener = (payload: unknown) => {
          const p = payload as { runId?: string } | undefined;
          // Cancel if: no runId filter, or runId matches, or broadcast
          if (!p?.runId || p.runId === run._id) {
            this.cancel(run._id).catch(() => {});
          }
        };
        this.container.eventBus.on(trigger.event, cancelListener);
        this.eventListeners.set(`${run._id}:cancelOn:${trigger.event}`, {
          listener: cancelListener as (...args: unknown[]) => void,
          eventName: trigger.event,
        });
      }
    }

    this.container.eventBus.emit('workflow:started', { runId: run._id });

    // Auto-execute if enabled and not queued as draft
    if (this.options.autoExecute && run.status === 'running') {
      setImmediate(() =>
        this.execute(run._id).catch((err) => {
          this.container.eventBus.emit('engine:error', {
            runId: run._id,
            error: err,
            context: 'auto-execution',
          });
        }),
      );
    }

    // If queued as draft (concurrency limit), ensure scheduler is running to promote it
    if (run.status === 'draft') {
      this.scheduler.start();
    }

    return run;
  }

  /**
   * Get a workflow run by ID.
   * Returns from cache if available, otherwise fetches from database.
   *
   * @param runId - Workflow run ID
   * @returns The workflow run or null if not found
   */
  async get(runId: string): Promise<WorkflowRun<TContext> | null> {
    const cached = this.container.cache.get<TContext>(runId);
    if (cached) return cached;

    const run = await this.container.repository.getById(runId);
    return run as WorkflowRun<TContext> | null;
  }

  /**
   * Execute a workflow run to completion.
   *
   * Runs steps sequentially until:
   * - All steps complete (status: 'done')
   * - A step fails after retries (status: 'failed')
   * - A step waits for external input (status: 'waiting')
   * - The workflow is cancelled (status: 'cancelled')
   *
   * @param runId - Workflow run ID to execute
   * @returns The updated workflow run
   */
  async execute(runId: string): Promise<WorkflowRun<TContext>> {
    let run = await this.getOrThrow(runId);

    try {
      while (this.shouldContinueExecution(run)) {
        const { run: updatedRun, shouldBreak } = await this.executeNextStep(run);
        run = updatedRun;

        if (shouldBreak) break;

        // Handle waiting state
        if (run.status === 'waiting') {
          const continueExecution = await this.handleWaitingState(runId, run);
          if (!continueExecution) break;
          const refreshed = await this.get(runId);
          if (!refreshed) break;
          run = refreshed;
        }

        // Handle terminal states
        if (isTerminalState(run.status)) {
          cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
          break;
        }
      }
    } catch (error) {
      if (error instanceof InvalidStateError) {
        // Workflow was cancelled during execution — refresh from DB
        const cancelled = await this.get(runId);
        if (cancelled) run = cancelled;
      } else if (error instanceof StepNotFoundError) {
        // Version mismatch: the run has a step that doesn't exist in this code version.
        // This happens when deploying v2 while v1 workflows are still in-flight.
        const stepId = run.currentStepId;
        this.container.eventBus.emit('engine:error', {
          runId,
          error: new Error(
            `Version mismatch: workflow "${run.workflowId}" run has currentStepId="${stepId}" ` +
              `but this engine (v${this.definition.version}) doesn't define it. ` +
              `Register the old version with workflowRegistry or migrate in-flight runs.`,
          ),
          context: 'version-mismatch',
        });

        // Mark as failed with version mismatch error
        const now = new Date();
        await this.container.repository.updateOne(
          { _id: runId },
          runSet({
            status: 'failed',
            endedAt: now,
            error: {
              message: `Step "${stepId}" not found — code version changed while workflow was in-flight`,
              code: 'VERSION_MISMATCH',
            },
          }),
          { bypassTenant: true },
        );

        run.status = 'failed';
        run.endedAt = now;
        run.error = {
          message: `Step "${stepId}" not found — code version changed while workflow was in-flight`,
          code: 'VERSION_MISMATCH',
        };
      } else {
        throw error;
      }
    }

    // Clean up on terminal states
    if (isTerminalState(run.status)) {
      cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
      hookRegistry.unregister(runId);

      // Saga compensation: if workflow failed and compensation handlers exist,
      // run them in reverse order for all completed steps.
      if (run.status === 'failed' && this.options.compensationHandlers) {
        run = await this.runCompensation(run);
      }

      // Promote concurrency-queued drafts immediately when a slot frees up.
      // Don't wait for the scheduler poll cycle (could be 60s+).
      if (run.concurrencyKey) {
        this.promoteConcurrencyDrafts(run.workflowId, run.concurrencyKey);
      }
    }

    return run;
  }

  /**
   * Run saga compensation handlers for completed steps in reverse order.
   * Called automatically when a workflow fails and compensation handlers are registered.
   */
  private async runCompensation(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>> {
    const compensationHandlers = this.options.compensationHandlers;
    if (!compensationHandlers) return run;

    // Get completed steps in reverse order
    const completedSteps = run.steps
      .filter((s) => s.status === 'done' && compensationHandlers[s.stepId])
      .reverse();

    if (completedSteps.length === 0) return run;

    this.container.eventBus.emit('workflow:compensating', {
      runId: run._id,
      data: { steps: completedSteps.map((s) => s.stepId) },
    });

    for (const stepState of completedSteps) {
      const handler = compensationHandlers[stepState.stepId];
      if (!handler) continue;

      try {
        const ctx = new (await import('./context.js')).StepContextImpl(
          run._id,
          stepState.stepId,
          run.context,
          run.input,
          stepState.attempts,
          run,
          this.container.repository,
          this.container.eventBus,
        );

        await (handler as (ctx: unknown) => Promise<unknown>)(ctx);

        this.container.eventBus.emit('step:compensated', {
          runId: run._id,
          stepId: stepState.stepId,
        });
      } catch (err) {
        // Compensation failures are logged but don't block other compensations
        this.container.eventBus.emit('engine:error', {
          runId: run._id,
          error: toError(err),
          context: `compensation-${stepState.stepId}`,
        });
      }
    }

    return run;
  }

  /**
   * Immediately promote concurrency-queued drafts when a slot frees.
   * Fire-and-forget — errors are emitted, not thrown.
   */
  private promoteConcurrencyDrafts(workflowId: string, concurrencyKey: string): void {
    setImmediate(async () => {
      try {
        // Cross-tenant promotion sweep — the engine doesn't know which
        // tenant owns the draft until it inspects each row, so we read
        // unscoped and rely on `_id`-scoped writes downstream
        // (`executeRetry` → `claim` is gated by id + status). In strict
        // multi-tenant mode the read would otherwise throw before any
        // promotion could happen.
        const drafts = await this.container.repository.getConcurrencyDrafts(10, {
          bypassTenant: true,
        });
        const matching = drafts.filter(
          (d) => d.workflowId === workflowId && d.concurrencyKey === concurrencyKey,
        );
        for (const draft of matching) {
          try {
            await this.executeRetry(draft._id);
          } catch (err) {
            // Emit per-draft failure so operators can see stuck promotions.
            // The scheduler still retries on its next poll — this is advisory.
            this.container.eventBus.emit('engine:error', {
              runId: draft._id,
              error: toError(err),
              context: 'promote-concurrency-draft-failure',
            });
          }
        }
      } catch (err) {
        this.container.eventBus.emit('engine:error', {
          error: toError(err),
          context: 'promote-concurrency-drafts',
        });
      }
    });
  }

  // ============ Execute Helpers ============

  private async getOrThrow(runId: string): Promise<WorkflowRun<TContext>> {
    const run = await this.get(runId);
    if (!run) throw new WorkflowNotFoundError(runId);
    return run;
  }

  private shouldContinueExecution(run: WorkflowRun<TContext>): boolean {
    return run.status === 'running' && run.currentStepId !== null;
  }

  private async executeNextStep(
    run: WorkflowRun<TContext>,
  ): Promise<{ run: WorkflowRun<TContext>; shouldBreak: boolean }> {
    const prevStepId = run.currentStepId;
    const prevStepStatus = run.steps.find((s) => s.stepId === prevStepId)?.status;

    const updatedRun = await this.executor.executeStep(run);
    this.container.cache.set(updatedRun);

    // Check for no progress (another worker handling it)
    const shouldBreak = this.checkNoProgress(updatedRun, prevStepId, prevStepStatus);

    return { run: updatedRun, shouldBreak };
  }

  private checkNoProgress(
    run: WorkflowRun<TContext>,
    prevStepId: string | null,
    prevStepStatus: string | undefined,
  ): boolean {
    const currentStep = run.steps.find((s) => s.stepId === run.currentStepId);
    const isRetryPending = currentStep?.status === 'pending' && currentStep?.retryAfter;

    // After ctx.goto(), the target step is reset to 'pending' and currentStepId
    // may be the same as before (goto-to-self for loop patterns). Detect this by
    // checking if the from-step was marked 'skipped' — that means goto happened.
    if (prevStepId) {
      const prevStep = run.steps.find((s) => s.stepId === prevStepId);
      if (prevStep?.status === 'skipped') return false; // goto = progress
    }

    return (
      run.currentStepId === prevStepId && currentStep?.status === prevStepStatus && !isRetryPending
    );
  }

  /**
   * Handle different waiting states (event, retry, timer, human input)
   * @returns true if execution should continue, false to break
   */
  private async handleWaitingState(runId: string, run: WorkflowRun<TContext>): Promise<boolean> {
    const stepState = this.findCurrentStep(run);

    if (!stepState && run.currentStepId) {
      await this.failCorruption(runId, run);
      cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
      return false;
    }

    if (!stepState) return false;

    // Event wait
    if (stepState.waitingFor?.type === 'event' && stepState.waitingFor.eventName) {
      this.handleEventWait(runId, stepState.waitingFor.eventName);
      return false;
    }

    // Retry wait
    if (stepState.status === 'pending' && stepState.retryAfter) {
      return this.handleRetryWait(runId, stepState.retryAfter);
    }

    // Timer wait (sleep)
    if (stepState.waitingFor?.type === 'timer' && stepState.waitingFor.resumeAt) {
      const shouldContinue = await this.handleTimerWait(runId, stepState.waitingFor.resumeAt);
      if (shouldContinue) {
        const refreshedRun = await this.getOrThrow(runId);
        const updatedRun = await this.executor.resumeStep(refreshedRun, undefined);
        this.container.cache.set(updatedRun);
        return true;
      }
      return false;
    }

    // Child workflow wait — auto-start the child and listen for completion
    if (stepState.waitingFor?.type === 'childWorkflow') {
      const data = stepState.waitingFor.data as
        | {
            childWorkflowId: string;
            childInput: unknown;
            parentRunId: string;
            parentStepId: string;
            childRunId?: string;
          }
        | undefined;

      if (data?.childWorkflowId && !data.childRunId) {
        // Look up the child workflow engine by workflowId
        const childEngine = workflowRegistry.getEngine(data.childWorkflowId);

        if (childEngine) {
          // Auto-start the child workflow
          const childRun = await childEngine.start(data.childInput);

          // Store the childRunId in the parent's waitingFor data
          const stepIndex = run.steps.findIndex((s) => s.stepId === run.currentStepId);
          if (stepIndex !== -1) {
            await this.container.repository.updateOne(
              { _id: runId },
              { $set: { [`steps.${stepIndex}.waitingFor.data.childRunId`]: childRun._id } },
              { bypassTenant: true },
            );
          }

          // Listen for child completion and auto-resume parent.
          //
          // Buses to subscribe on:
          //   1. parent's container bus — same-container children fire here
          //   2. child's container bus  — cross-container children fire here
          //      (the executor calls `this.eventBus.emit` against the child
          //      engine's own container, NOT the parent's)
          // Subscribe to both; dedupe by `_resumed` flag so only one fires
          // when buses are the same.
          const sameContainer = childEngine.container.eventBus === this.container.eventBus;
          let resumed = false;

          const cleanup = () => {
            this.container.eventBus.off('workflow:completed', childCompletionHandler);
            this.container.eventBus.off('workflow:failed', childFailHandler);
            if (!sameContainer) {
              childEngine.container.eventBus.off('workflow:completed', childCompletionHandler);
              childEngine.container.eventBus.off('workflow:failed', childFailHandler);
            }
          };

          const childCompletionHandler = async (payload: { runId?: string; data?: unknown }) => {
            if (!payload.runId || payload.runId !== childRun._id) return;
            if (resumed) return;
            resumed = true;
            try {
              const completedChild = await childEngine.get(childRun._id);
              const output = completedChild?.output ?? completedChild?.context;
              await this.resume(runId, output);
            } catch {
              // Parent may have been cancelled or already resumed
            }
            cleanup();
          };

          const childFailHandler = async (payload: { runId?: string; data?: unknown }) => {
            if (!payload.runId || payload.runId !== childRun._id) return;
            if (resumed) return;
            resumed = true;
            try {
              const failedChild = await childEngine.get(childRun._id);
              await this.resume(runId, { __childFailed: true, error: failedChild?.error });
            } catch {
              // Parent may have been cancelled
            }
            cleanup();
          };

          this.container.eventBus.on('workflow:completed', childCompletionHandler);
          this.container.eventBus.on('workflow:failed', childFailHandler);
          if (!sameContainer) {
            childEngine.container.eventBus.on('workflow:completed', childCompletionHandler);
            childEngine.container.eventBus.on('workflow:failed', childFailHandler);
          }
        } else {
          // Child engine not found — emit guidance
          this.container.eventBus.emit('engine:error', {
            runId,
            error: new Error(
              `Child workflow '${data.childWorkflowId}' not registered. ` +
                `Ensure the child workflow is created with createWorkflow() before the parent starts. ` +
                `Or resume the parent manually when the child completes.`,
            ),
            context: 'child-workflow-not-found',
          });
        }
      }

      // Break — child execution handles completion asynchronously
      return false;
    }

    // Human input wait - break and let external resume
    return false;
  }

  private findCurrentStep(run: WorkflowRun<TContext>): StepState | undefined {
    return run.steps.find((s) => s.stepId === run.currentStepId);
  }

  // ============ Wait Handlers ============

  /**
   * Handle data corruption scenario (missing step state)
   */
  private async failCorruption(
    runId: string,
    run: WorkflowRun<TContext>,
  ): Promise<WorkflowRun<TContext>> {
    const errorMsg = `Data corruption: currentStepId '${run.currentStepId}' not found in steps`;

    this.container.eventBus.emit('engine:error', {
      runId,
      error: new Error(errorMsg),
      context: 'data-corruption',
    });

    const now = new Date();
    const errorPayload = { message: errorMsg, code: 'DATA_CORRUPTION' };

    await this.container.repository.updateOne(
      { _id: runId },
      runSet({ status: 'failed', endedAt: now, error: errorPayload }),
      { bypassTenant: true },
    );

    run.status = 'failed';
    run.updatedAt = now;
    run.endedAt = now;
    run.error = errorPayload;

    this.container.eventBus.emit('workflow:failed', { runId, data: { error: errorPayload } });
    return run;
  }

  /**
   * Register event listener for event-based waits (`ctx.waitFor(name)`).
   *
   * Listens on THREE channels so `globalEventBus.emit()`, container-bus
   * emissions, and cross-process `SignalStore` messages all wake the run:
   *
   *   1. The container's own event bus — covers handlers inside the same
   *      container that call `container.eventBus.emit()`.
   *   2. `globalEventBus` — covers callers outside the container (HTTP
   *      routes, workers in other containers, tests) that emit via
   *      `globalEventBus.emit()`. Skipped if the container is already using
   *      globalEventBus to avoid double-delivery.
   *   3. `signalStore` — covers cross-process delivery via Redis/Kafka/etc.
   *
   * Paused workflows ignore events but keep their listeners active.
   */
  private handleEventWait(runId: string, eventName: string): void {
    const listenerKey = `${runId}:${eventName}`;
    if (this.eventListeners.has(listenerKey)) return;

    const listener = async (...args: unknown[]) => {
      const payload = args[0] as WorkflowEventPayload | undefined;
      try {
        // Warn about unintentional broadcasts.
        if (payload && !payload.runId && !payload.broadcast) {
          logger.warn(
            `Event '${eventName}' emitted without runId or broadcast flag. ` +
              `This will resume ALL workflows waiting on '${eventName}'.`,
            { runId, eventName },
          );
        }

        // Resume if: no payload, runId matches, or explicit broadcast.
        if (payload && payload.runId !== runId && payload.broadcast !== true) return;

        // Paused workflows ignore events but keep listeners active until
        // explicit resume.
        const run = await this.get(runId);
        if (run?.paused) return;

        // Tear down every channel for this (run, event) pair before resuming
        // — prevents a second delivery from calling resume() mid-flight.
        cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
        await this.resume(runId, payload?.data);
      } catch (err) {
        this.container.eventBus.emit('engine:error', {
          runId,
          error: err as Error,
          context: 'event-handler',
        });
      }
    };

    // 1. Container event bus.
    this.container.eventBus.on(eventName, listener);
    this.eventListeners.set(listenerKey, { listener, eventName });

    // 2. Global event bus — only if distinct from the container bus, to avoid
    //    double-fire when the user chose `eventBus: 'global'`.
    if (this.container.eventBus !== globalEventBus) {
      globalEventBus.on(eventName, listener);
      this.eventListeners.set(`global:${listenerKey}`, {
        listener: listener as (...args: unknown[]) => void,
        eventName,
      });
    }

    // 3. Cross-process signal store (Redis/Kafka if configured).
    const signalUnsub = this.container.signalStore.subscribe(
      `streamline:event:${eventName}`,
      (data) => {
        const signalPayload = data as WorkflowEventPayload | undefined;
        if (!signalPayload || signalPayload.runId === runId || signalPayload.broadcast) {
          listener(signalPayload);
        }
      },
    );

    this.eventListeners.set(`signal:${listenerKey}`, {
      listener: (() => {
        if (typeof signalUnsub === 'function') signalUnsub();
        else if (signalUnsub instanceof Promise) signalUnsub.then((fn) => fn());
      }) as (...args: unknown[]) => void,
      eventName: `signal:${listenerKey}`,
    });
  }

  /**
   * Handle retry backoff wait with inline execution for short delays
   * @returns true if workflow should continue execution immediately
   */
  private async handleRetryWait(runId: string, retryAfter: Date): Promise<boolean> {
    return handleShortDelayOrSchedule(
      runId,
      retryAfter,
      () => this.scheduler.start(),
      this.container.repository,
      this.container.cache,
    );
  }

  /**
   * Handle timer-based wait (sleep) with inline execution for short delays
   * @returns true if workflow should continue execution immediately
   */
  private async handleTimerWait(runId: string, resumeAt: Date): Promise<boolean> {
    return handleShortDelayOrSchedule(
      runId,
      resumeAt,
      () => {
        this.scheduler.scheduleResume(runId, resumeAt);
      },
      this.container.repository,
      this.container.cache,
    );
  }

  // ============ Public Resume/Control Methods ============

  /**
   * Resume a paused or waiting workflow.
   *
   * For waiting workflows:
   * - If waiting for human input: payload is passed as the step output
   * - If waiting for timer/retry: continues execution from current step
   *
   * @param runId - Workflow run ID to resume
   * @param payload - Data to pass to the waiting step (becomes step output)
   * @returns The updated workflow run
   * @throws {InvalidStateError} If workflow is not in waiting/running state
   */
  async resume(runId: string, payload?: unknown): Promise<WorkflowRun<TContext>> {
    const run = await this.getOrThrow(runId);

    // Atomic claim: clear paused flag with guard to prevent concurrent resume race.
    // Two workers calling resume() simultaneously — only one wins the atomic claim.
    //
    // Uses mongokit 3.13's `Repository.claim()` primitive — the canonical
    // shape for `{ _id, [field]: from } → $set: { [field]: to, ...patch }`
    // atomic state transitions. Goes through `_runOp` → plugin chain
    // (audit, observability) fires; OP_REGISTRY classifies `claim` as
    // `mutates: true / policyKey: 'query'` so multi-tenant scope auto-
    // injects when wired. `bypassTenant: true` here because the call is
    // already _id-scoped from a tenant-trusted caller.
    if (run.paused) {
      const claimed = await this.container.repository.claim(
        runId,
        { field: 'paused', from: true, to: false },
        { updatedAt: new Date() },
        { bypassTenant: true },
      );

      if (!claimed) {
        // Another worker already resumed — refresh and return current state
        const current = await this.getOrThrow(runId);
        return current;
      }

      run.paused = false;
      run.updatedAt = new Date();
      this.container.cache.set(run);
    }

    // If workflow is waiting (explicit wait or retry backoff)
    if (run.status === 'waiting') {
      return this.resumeWaitingWorkflow(run, payload);
    }

    // If already running, just execute
    if (run.status === 'running') {
      return this.execute(runId);
    }

    throw new InvalidStateError('resume workflow', run.status, ['waiting', 'running'], { runId });
  }

  private async resumeWaitingWorkflow(
    run: WorkflowRun<TContext>,
    payload?: unknown,
  ): Promise<WorkflowRun<TContext>> {
    const runId = run._id;
    const currentStepId = run.currentStepId;

    if (currentStepId) {
      const stepState = run.steps.find((s) => s.stepId === currentStepId);

      // If step is 'waiting' (explicit wait/sleep/waitFor), complete it with payload
      if (stepState?.status === 'waiting') {
        cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
        const updatedRun = await this.executor.resumeStep(run, payload);
        this.container.cache.set(updatedRun);
        return this.execute(runId);
      }
    }

    // Otherwise, just continue execution (pending step or retry backoff).
    // Send ONLY the narrow update fields. See `cancel()` for why spreading
    // (or passing the whole hydrated `run`) into updateById poisons the
    // cache via mongoose 9's update-cast subdoc coercion.
    const updates: Partial<WorkflowRun<TContext>> = {
      status: 'running' as WorkflowRun<TContext>['status'],
      lastHeartbeat: new Date(),
    };
    await this.container.repository.updateById(runId, updates, { bypassTenant: true });
    run.status = 'running';
    run.lastHeartbeat = updates.lastHeartbeat as Date;
    this.container.cache.set(run);
    return this.execute(runId);
  }

  /**
   * Recover a stale 'running' workflow (crashed mid-execution)
   * Uses atomic claim to prevent multiple servers from recovering the same workflow
   */
  async recoverStale(
    runId: string,
    staleThresholdMs: number,
  ): Promise<WorkflowRun<TContext> | null> {
    const staleTime = new Date(Date.now() - staleThresholdMs);

    // Atomic claim: Only recover if status is 'running' AND heartbeat is stale.
    // The "stale" check goes in `where:` — `claim()` handles compound filter
    // predicates AND-merged alongside the id+state CAS keys. Status stays
    // 'running' (no transition), the where-guard is what makes this a safe
    // re-claim that can't fire on a healthy worker.
    const claimed = await this.container.repository.claim(
      runId,
      {
        from: 'running',
        to: 'running',
        where: {
          $or: [{ lastHeartbeat: { $lt: staleTime } }, { lastHeartbeat: { $exists: false } }],
        },
      },
      { lastHeartbeat: new Date(), updatedAt: new Date() },
      { bypassTenant: true },
    );

    if (!claimed) {
      return null;
    }

    // We successfully claimed the stale workflow.
    // Reset the current step from 'running' → 'pending' so the executor can re-claim it.
    // Without this, executeStep() sees status='running' and treats it as "another worker
    // owns this", causing the no-progress detector to exit the loop → workflow wedged forever.
    this.container.cache.delete(runId);
    const run = await this.get(runId);
    if (run?.currentStepId) {
      const stepIndex = run.steps.findIndex((s) => s.stepId === run.currentStepId);
      if (stepIndex !== -1 && run.steps[stepIndex]?.status === 'running') {
        await this.container.repository.updateOne(
          { _id: runId },
          {
            $set: {
              [`steps.${stepIndex}.status`]: 'pending',
              [`steps.${stepIndex}.startedAt`]: undefined,
            },
          },
          { bypassTenant: true },
        );
      }
    }

    this.container.cache.delete(runId);
    this.container.eventBus.emit('workflow:recovered', { runId });

    return this.execute(runId);
  }

  /**
   * Execute a retry for a workflow that failed and is waiting for backoff timer
   * Uses atomic claim to prevent multiple servers from retrying the same workflow
   */
  async executeRetry(runId: string): Promise<WorkflowRun<TContext> | null> {
    const now = new Date();

    // All three claim attempts below use `assertAndClaim` — runs
    // `RUN_MACHINE.assertTransition` (sync, in-memory) before each Mongo
    // CAS. Catches programmer bugs (illegal source status) before the
    // round-trip; CAS still rejects concurrent writers via null.

    // First, try to claim a retry workflow (status: waiting)
    // — paused guard + step-level retryAfter elemMatch via `where:`.
    let claimed = await assertAndClaim(RUN_MACHINE, this.container.repository, runId, {
      from: 'waiting',
      to: 'running',
      where: {
        paused: { $ne: true },
        steps: {
          $elemMatch: {
            status: 'pending',
            retryAfter: { $lte: now },
          },
        },
      },
      patch: { lastHeartbeat: now, updatedAt: now },
      options: { bypassTenant: true },
    });

    // If no retry workflow found, try to claim a scheduled workflow (status: draft, has executionTime)
    if (!claimed) {
      claimed = await assertAndClaim(RUN_MACHINE, this.container.repository, runId, {
        from: 'draft',
        to: 'running',
        where: {
          'scheduling.executionTime': { $lte: now },
          paused: { $ne: true },
        },
        patch: { lastHeartbeat: now, startedAt: now, updatedAt: now },
        options: { bypassTenant: true },
      });
    }

    // If no scheduled draft found, try to claim a concurrency-queued draft.
    // Cross-tenant sweep — `executeRetry(runId)` is invoked by the scheduler
    // which doesn't know the row's tenant. The lookup is `_id`-scoped so
    // this is safe; downstream `claim()` is also `_id`-scoped + bypassTenant.
    if (!claimed) {
      const draft = await this.container.repository.getConcurrencyDraft(runId, {
        bypassTenant: true,
      });

      if (draft?.concurrencyKey) {
        // Active-count probe is GLOBAL across the (workflowId, concurrencyKey)
        // bucket — the scheduler counts every tenant's active runs against
        // the limit. Cross-tenant by design; bypass tenant scope.
        const activeCount = await this.container.repository.countActiveByConcurrencyKey(
          draft.workflowId,
          draft.concurrencyKey,
          { bypassTenant: true },
        );

        // Only promote if under the limit (we don't know the limit here,
        // so we check if there's room — at least one slot must be free)
        // The limit was checked at start() time. Here we just check if any slot freed.
        const concurrencyLimit = (draft.meta as Record<string, unknown> | undefined)
          ?.concurrencyLimit as number | undefined;

        if (concurrencyLimit === undefined || activeCount < concurrencyLimit) {
          claimed = await assertAndClaim(RUN_MACHINE, this.container.repository, runId, {
            from: 'draft',
            to: 'running',
            where: { paused: { $ne: true } },
            patch: { lastHeartbeat: now, startedAt: now, updatedAt: now },
            options: { bypassTenant: true },
          });
        }
      }
    }

    if (!claimed) {
      return null;
    }

    // We successfully claimed the workflow, now re-execute it
    this.container.cache.delete(runId);

    // Register with hookRegistry so resumeHook() can find this engine
    // (Critical for scheduled workflows that use ctx.wait() or createHook())
    hookRegistry.register(runId, this as unknown as WorkflowEngine<unknown>);

    this.container.eventBus.emit('workflow:retry', { runId });

    return this.execute(runId);
  }

  /**
   * Rewind a workflow to a previous step.
   * Resets all steps from target step onwards to pending state.
   *
   * @param runId - Workflow run ID
   * @param stepId - Step ID to rewind to
   * @returns The rewound workflow run
   */
  async rewindTo(runId: string, stepId: string): Promise<WorkflowRun<TContext>> {
    const run = await this.getOrThrow(runId);

    const rewoundRun = this.registry.rewindRun(run, stepId);
    await this.container.repository.updateById(runId, rewoundRun, { bypassTenant: true });
    this.container.cache.set(rewoundRun);

    return rewoundRun;
  }

  /**
   * Cancel a running workflow.
   * Cleans up all resources and marks workflow as cancelled.
   *
   * @param runId - Workflow run ID to cancel
   * @returns The cancelled workflow run
   */
  async cancel(runId: string): Promise<WorkflowRun<TContext>> {
    const run = await this.getOrThrow(runId);

    // Abort any in-flight step handlers (fulfills ctx.signal contract)
    this.executor.abortWorkflow(runId);

    // Send ONLY the narrow update fields. Spreading the whole `run` into
    // updateById causes mongoose 9's update-cast to coerce the embedded
    // `steps[]` plain objects into Subdocument instances IN PLACE on the
    // input. The cache then holds the polluted reference, and downstream
    // `findStepOrThrow` on `s.stepId` fails because the spread lost the
    // Subdocument prototype getters. Build the cancelledRun for the
    // return / cache value AFTER the DB write.
    const updates: Partial<WorkflowRun<TContext>> = {
      status: 'cancelled' as WorkflowRun<TContext>['status'],
      endedAt: new Date(),
      updatedAt: new Date(),
    };
    await this.container.repository.updateById(runId, updates, { bypassTenant: true });

    const cancelledRun: WorkflowRun<TContext> = { ...run, ...updates };

    this.scheduler.cancelSchedule(runId);
    cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
    hookRegistry.unregister(runId);
    this.container.cache.delete(runId);
    this.container.eventBus.emit('workflow:cancelled', { runId });

    return cancelledRun;
  }

  /**
   * Pause a workflow run.
   *
   * Sets the `paused` flag to prevent the scheduler from processing this workflow.
   * Paused workflows can be resumed later with `resume()`.
   *
   * @param runId - Workflow run ID to pause
   * @returns The paused workflow run
   */
  async pause(runId: string): Promise<WorkflowRun<TContext>> {
    const run = await this.getOrThrow(runId);

    // Don't pause terminal states
    if (isTerminalState(run.status)) {
      return run;
    }

    // Already paused - no-op
    if (run.paused) {
      return run;
    }

    // Send ONLY the changed fields. See `cancel()` above for why spreading
    // the whole `run` into updateById poisons the cache (mongoose 9 update-
    // cast mutates the embedded `steps[]` array in place into Subdocument
    // instances; the cached reference loses prototype getters and breaks
    // `findStepOrThrow` on the next execute). Build pausedRun for the
    // return/cache after the DB write.
    const updates: Partial<WorkflowRun<TContext>> = {
      paused: true,
      updatedAt: new Date(),
    };
    await this.container.repository.updateById(runId, updates, { bypassTenant: true });
    const pausedRun: WorkflowRun<TContext> = { ...run, ...updates };
    this.scheduler.cancelSchedule(runId);
    this.container.cache.set(pausedRun);

    return pausedRun;
  }

  /**
   * Configure engine options (scheduler settings, etc.)
   */
  configure(options: { scheduler?: Partial<SmartSchedulerConfig> }): void {
    if (options.scheduler) {
      const currentConfig = {
        ...DEFAULT_SCHEDULER_CONFIG,
        ...this.options.scheduler,
        ...options.scheduler,
      };

      // Stop current scheduler and create new one with updated config
      this.scheduler.stop();
      this.scheduler = new SmartScheduler(
        this.container.repository,
        async (runId) => {
          await this.resume(runId);
        },
        currentConfig,
        this.container.eventBus,
      );

      // Re-set callbacks
      this.scheduler.setStaleRecoveryCallback(async (runId, thresholdMs) => {
        return this.recoverStale(runId, thresholdMs);
      });
      this.scheduler.setRetryCallback(async (runId) => {
        return this.executeRetry(runId);
      });

      this.options.scheduler = currentConfig;
    }
  }

  shutdown(): void {
    this.scheduler.stop();

    // Abort all in-flight step executions (stops heartbeat timers + timeouts)
    this.executor.abortAll();

    // Clean up all event listeners — must respect the three key prefixes
    // (container bus / global bus / signal store) or globalEventBus
    // subscriptions survive between tests and leak across engine instances.
    for (const [key, entry] of this.eventListeners.entries()) {
      if (key.startsWith('signal:')) {
        entry.listener();
      } else if (key.startsWith('global:')) {
        globalEventBus.off(entry.eventName, entry.listener);
      } else {
        this.container.eventBus.off(entry.eventName, entry.listener);
      }
    }
    this.eventListeners.clear();
  }

  /**
   * Get scheduler statistics for monitoring
   */
  getSchedulerStats(): ReturnType<SmartScheduler['getStats']> {
    return this.scheduler.getStats();
  }

  /**
   * Check if scheduler is healthy
   */
  isSchedulerHealthy(): boolean {
    return this.scheduler.isHealthy();
  }
}
