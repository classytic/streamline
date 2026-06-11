import { assertAndClaim } from '@classytic/primitives/state-machine';
import type { StreamlineContainer } from '../core/container.js';
import { globalEventBus } from '../core/events.js';
import { isTerminalState, RUN_MACHINE } from '../core/status.js';
import type {
  StepState,
  WorkflowDefinition,
  WorkflowEventPayload,
  WorkflowHandlers,
  WorkflowRun,
} from '../core/types.js';
import { makeWaitTimeout } from '../features/wait-resolution.js';
import { computeNextOccurrence } from '../scheduling/recurrence.js';
import { runSet } from '../storage/update-builders.js';
import {
  InvalidStateError,
  StepNotFoundError,
  toError,
  WorkflowNotFoundError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { WorkflowRegistry } from '../workflow/registry.js';
import { handleChildWorkflowWait } from './child-workflow.js';
import { StepExecutor } from './executor.js';
import {
  cancelBranchChildren,
  handleBranchJoinWait,
  writeBranchJoinFailure,
} from './parallel-steps.js';
import {
  cleanupEventListeners,
  handleShortDelayOrSchedule,
  hookRegistry,
  workflowRegistry,
} from './registries.js';
import {
  recoverCompensation as recoverCompensationImpl,
  runCompensation as runCompensationImpl,
} from './saga.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  SmartScheduler,
  type SmartSchedulerConfig,
} from './smart-scheduler.js';

// The hook + workflow registries and the listener/short-delay helpers were
// extracted to `./registries.js`; the child-workflow wait machinery to
// `./child-workflow.js`; and the durable-saga compensation walk to `./saga.js`.
// They are re-exported here so the public `@classytic/streamline` entry's
// `hookRegistry` / `workflowRegistry` exports (sourced from this module) keep
// working without a path change.
export { hookRegistry, workflowRegistry } from './registries.js';

export interface WorkflowEngineOptions {
  /** Auto-execute workflow after start (default: true) */
  autoExecute?: boolean;
  /** Custom scheduler configuration */
  scheduler?: Partial<SmartSchedulerConfig>;
  /**
   * Ring-buffer cap for persisted `stepLogs` (ctx.log()) on the run doc.
   * `flushLogs` writes with `$push: { $slice: -maxStepLogs }`, keeping only
   * the most recent N entries so a long/high-volume workflow can't grow the
   * inline array toward Mongo's 16MB doc limit. Default {@link LIMITS.MAX_STEP_LOGS}
   * (1000). NOTE: the engine also bounds per-step `outputHistory`, but cannot
   * bound arbitrary `context` / step `output` / `checkpoint` payloads (also
   * inline on the run doc) — store a reference/handle for large blobs.
   */
  maxStepLogs?: number;
  /**
   * Opt-in HARD cap (bytes, JSON-approximated) for a single step output or
   * `ctx.checkpoint()` payload — exceeding it fails the step NON-retriably.
   * Unset (default) = warn-only over 1MB. See `WorkflowConfig.maxPayloadBytes`.
   */
  maxPayloadBytes?: number;
  /**
   * Observability-only step middleware chain (v2.6) — beforeStep / afterStep /
   * onStepError / onWait hooks awaited around every step execution. Hook
   * errors are logged and SWALLOWED (middleware can never veto or fail a
   * step). See `StepMiddleware`.
   */
  middleware?: ReadonlyArray<import('../core/types.js').StepMiddleware>;
  /**
   * Compensation handlers for saga pattern rollback.
   * Keyed by stepId. Called in reverse order when a later step fails.
   */
  compensationHandlers?: WorkflowHandlers<unknown>;
  /**
   * Per-step compensation retry config (durable saga, v2.4). Keyed by stepId.
   * Absent → 1 attempt (no compensation retry). Threaded from
   * `StepConfig.compensateRetries`/`compensateRetryDelay`/`compensateRetryBackoff`.
   */
  compensationConfigs?: Record<
    string,
    {
      retries?: number;
      retryDelay?: number;
      retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
    }
  >;
  /**
   * Optional migration hook for in-flight runs whose `definitionVersion`
   * doesn't match this engine AND whose original-version engine is not
   * registered. The host inspects the run and returns a partial run
   * payload that is merged into the existing document; the engine then
   * continues executing under its own version.
   *
   * Return `null` / `undefined` to fall through (the engine will fail
   * the run with `VERSION_MISMATCH` if the step graph diverged — same
   * pre-v2.3.3 behaviour).
   *
   * Common patterns:
   *   - Map a removed step's `currentStepId` onto the new step graph.
   *   - Backfill new context fields the v2 step graph requires.
   *   - Rewrite `steps[]` to align with the new shape.
   *
   * @example
   * ```ts
   * createWorkflow('billing', {
   *   version: '2.0.0',
   *   migrateRun: async (run) => {
   *     if (run.definitionVersion === '1.0.0' && run.currentStepId === 'old-charge') {
   *       return { currentStepId: 'charge', context: { ...run.context, currency: 'USD' } };
   *     }
   *     return null;
   *   },
   *   steps: { ... },
   * });
   * ```
   */
  migrateRun?: (
    run: WorkflowRun<unknown>,
  ) =>
    | Partial<WorkflowRun<unknown>>
    | null
    | undefined
    | Promise<Partial<WorkflowRun<unknown>> | null | undefined>;
  /**
   * Register the strict-concurrency slot-release listeners on the bus.
   *
   * The engine's 5 lifecycle listeners (`workflow:completed` / `:failed` /
   * `:cancelled` / `:compensated` / `:compensation_failed`) exist ONLY to
   * decrement the atomic counter for `concurrency.strict` workflows. They
   * are a provable no-op for any run WITHOUT a `meta.concurrencyCounterId`
   * — and that marker is stamped exclusively by the strict-concurrency
   * claim path in `define.ts`. So a non-strict workflow's listeners do a
   * `repository.getById` on every terminal event and then discard it.
   *
   * `createWorkflow` sets this to `true` only when the workflow declares
   * `concurrency.strict`. Default `false` ⇒ no listeners registered.
   *
   * Why the gate matters on a SHARED bus (`createContainer({ eventBus:
   * 'global' })`): without it, EVERY engine registers all 5 listeners on
   * the one bus, so N workflows put N listeners on each of those 5 event
   * names — crossing Node's 10-listener-per-event soft cap and emitting a
   * `MaxListenersExceededWarning` at boot. Worse, each terminal event then
   * fans out to an O(N) `getById` storm that every non-owning engine
   * immediately drops on the `run.workflowId !== this.definition.id`
   * guard. Registering only for strict workflows keeps the overwhelmingly
   * common (non-strict) case at ZERO engine bus listeners and zero
   * wasted reads.
   */
  usesStrictConcurrency?: boolean;
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
  /**
   * Engine options. Public-readonly (not private) so the extracted
   * `./saga.js` compensation helpers can read `compensationHandlers` /
   * `compensationConfigs` through the `SagaEngine` view. Not part of the
   * documented public API — internal collaborators only.
   */
  readonly options: WorkflowEngineOptions;
  /**
   * Per-run event-listener bookkeeping. Public-readonly so the extracted
   * child-workflow / saga helpers and `cleanupEventListeners` operate on the
   * same map. Internal collaborators only.
   */
  readonly eventListeners = new Map<
    string,
    { listener: (...args: unknown[]) => void; eventName: string }
  >();

  /**
   * Run ids whose strict-concurrency slot has already been released. Guarantees
   * a run's slot is decremented AT MOST ONCE across the multiple terminal-ish
   * events it can emit (e.g. `failed` → `compensated`, or a re-emit after
   * crash recovery). See the `releaseSlotOnTerminal` listener.
   */
  private readonly releasedSlots = new Set<string>();

  /** Teardown for the 5 `releaseSlotOnTerminal` bus listeners; invoked by `shutdown()`. */
  private removeSlotReleaseListeners?: () => void;

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
      options.maxStepLogs,
      options.maxPayloadBytes,
      options.middleware as
        | ReadonlyArray<import('../core/types.js').StepMiddleware<TContext>>
        | undefined,
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
      // v2.4.0 distributed-correctness fix: scope every scheduler pickup query
      // to THIS engine's workflowId so a per-engine scheduler in a
      // multi-workflow deployment never claims/executes a foreign workflow's run.
      definition.id,
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

    // Set compensation recovery callback for crashed saga rollbacks (v2.4)
    this.scheduler.setCompensationRecoveryCallback(async (runId, thresholdMs) => {
      return this.recoverCompensation(runId, thresholdMs);
    });

    // Resume human/webhook waits that hit their `expiresAt` deadline WITH a
    // timeout sentinel, so the next step branches on the timeout. The
    // `waiting → running` claim inside `resume` makes this race-safe against a
    // concurrent `resumeHook`; if the run already moved on (external resume
    // won, or it completed), `resume` throws InvalidStateError — swallow it as
    // a no-op rather than surfacing a scheduler error.
    this.scheduler.setExpiryCallback(async (runId) => {
      try {
        await this.resume(runId, makeWaitTimeout());
      } catch (err) {
        if (err instanceof InvalidStateError) return;
        throw err;
      }
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
    //
    // GATED on `usesStrictConcurrency` (set by `createWorkflow` only for
    // workflows that declare `concurrency.strict`). A non-strict workflow
    // never stamps `meta.concurrencyCounterId`, so these listeners would
    // always early-return — pure overhead. Skipping registration is
    // behavior-preserving and, on a shared/global bus, is what keeps N
    // workflows from crossing Node's per-event listener cap (and from an
    // O(N) getById fan-out per terminal event). See `usesStrictConcurrency`
    // on WorkflowEngineOptions.
    if (options.usesStrictConcurrency) {
      const releaseSlotOnTerminal = async (payload: { runId?: string }) => {
        if (!payload.runId) return;
        try {
          const run = await this.container.repository.getById(payload.runId);
          if (!run) return;

          // (H3) Multi-engine guard: on a SHARED container / global bus, every
          // engine's listener receives every terminal event. Without this guard
          // two engines would both decrement the counter for ONE terminal event
          // (double-release). Only the engine that OWNS the workflow releases.
          if (run.workflowId !== this.definition.id) return;

          // Saga slot timing: a saga run emits `workflow:failed` and then enters
          // `compensating` (which STILL holds its slot — see SLOT_HOLDING_STATUSES).
          // Releasing on `failed` would free the slot mid-rollback and
          // oversubscribe a strict cap. So:
          //   - `failed` releases ONLY when the run will NOT compensate
          //     (no compensation handlers configured). With handlers, the slot
          //     is released later on `compensated`/`compensation_failed`.
          //   - `compensating` never releases (slot held through rollback).
          //   - all other terminal states (done/cancelled/compensated/
          //     compensation_failed) release.
          if (run.status === 'compensating') return;
          if (run.status === 'failed' && this.options.compensationHandlers) return;

          const counterId = (run.meta as Record<string, unknown> | undefined)
            ?.concurrencyCounterId as string | undefined;
          if (!counterId) return;

          // Idempotent per run: a run's slot is released AT MOST ONCE, even
          // though several terminal-ish events can fire for it (failed→compensated,
          // or a re-emit after crash-recovery). releaseSlot itself is guarded
          // (count > 0), but this Set stops a legitimate later run reusing the
          // same counterId bucket from being decremented by THIS run's stale event.
          if (this.releasedSlots.has(payload.runId)) return;
          this.releasedSlots.add(payload.runId);
          // Bound memory on a long-lived engine: a run's terminal events all fire
          // within a short window, so evicting the oldest entries once the Set is
          // large (10k runs) cannot cause a re-release of a still-relevant run.
          if (this.releasedSlots.size > 10_000) {
            const oldest = this.releasedSlots.values().next().value as string | undefined;
            if (oldest !== undefined) this.releasedSlots.delete(oldest);
          }

          await this.container.concurrencyCounterRepository.releaseSlot(counterId);
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
      this.container.eventBus.on('workflow:compensated', releaseSlotOnTerminal);
      this.container.eventBus.on('workflow:compensation_failed', releaseSlotOnTerminal);
      // Store a teardown so shutdown() removes these 5 listeners. Without it,
      // recreating an engine for the same workflowId leaves the OLD engine's
      // listener live on the shared bus — it still matches the H3
      // `run.workflowId === this.definition.id` guard and would double-release a
      // slot for a NEW run, undercounting the strict counter.
      this.removeSlotReleaseListeners = () => {
        this.container.eventBus.off('workflow:completed', releaseSlotOnTerminal);
        this.container.eventBus.off('workflow:failed', releaseSlotOnTerminal);
        this.container.eventBus.off('workflow:cancelled', releaseSlotOnTerminal);
        this.container.eventBus.off('workflow:compensated', releaseSlotOnTerminal);
        this.container.eventBus.off('workflow:compensation_failed', releaseSlotOnTerminal);
      };
    }

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

    // workflowId routing guard (v2.4.0 distributed-correctness fix). The run
    // may belong to a DIFFERENT workflow than this engine (e.g. a manual call,
    // or — pre-scoping — a foreign run a scheduler picked up). Running this
    // engine's step graph against a foreign run causes step-not-found/wrong-
    // handler corruption, so route to the owning engine or no-op. Returns the
    // delegate's result when routed; falls through to local execution when the
    // run is ours (workflowId matches). See `routeForeignRun`.
    const routed = await this.routeForeignRun(run, (engine) => engine.execute(runId));
    if (routed.handled) return routed.result as WorkflowRun<TContext>;

    // Version pinning — if the run was created against a different
    // definition version that's also registered, route execution to that
    // engine instead. The host can swap engines at deploy time without
    // breaking in-flight runs (the canonical "deployed v2 while v1 runs
    // are still walking the step graph" hazard).
    //
    // Resolution order:
    //   1. exact-version pinned engine via `workflowRegistry.lookupVersion`
    //   2. host-supplied `migrateRun(run)` hook (returns a fresh run shape
    //      to apply, OR a workflowId+version to redirect to)
    //   3. fall through to this engine — same back-compat behaviour as
    //      pre-v2.3.3 runs (they have no `definitionVersion` field).
    if (run.definitionVersion && run.definitionVersion !== this.definition.version) {
      const pinned = workflowRegistry.lookupVersion(run.workflowId, run.definitionVersion);
      if (pinned && pinned !== (this as unknown as WorkflowEngine<unknown>)) {
        return (await pinned.execute(runId)) as unknown as WorkflowRun<TContext>;
      }

      const migrated = await this.options.migrateRun?.(run);
      if (migrated) {
        // Migrate-in-place: persist the new shape, then continue with this engine.
        const now = new Date();
        await this.container.repository.updateOne(
          { _id: runId },
          runSet({
            ...migrated,
            definitionVersion: this.definition.version,
            updatedAt: now,
          } as Record<string, unknown>),
          { bypassTenant: true },
        );
        this.container.cache.delete(runId);
        const refreshed = await this.getOrThrow(runId);
        run = refreshed;
      }
      // Else: fall through. The version-mismatch StepNotFoundError catch
      // below already handles "step not in this engine" by failing the
      // run — same behaviour as before this block existed.
    }

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

        // Handle terminal states. Break out of the loop but DEFER cleanup to
        // the post-loop block — for a `failed` run with compensation handlers
        // we must enter the durable `compensating` phase first and only tear
        // down listeners/hooks once a genuinely-terminal compensation outcome
        // (compensated / compensation_failed / cancelled) is reached.
        if (isTerminalState(run.status)) {
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

    // Terminal handling — durable-saga aware.
    //
    // ORDERING INVARIANT (verifier-mandated): cleanupEventListeners /
    // hookRegistry.unregister must fire ONLY on a genuinely-terminal outcome,
    // NEVER while compensation is still pending. So when a run goes `failed`
    // AND has compensation handlers, we enter the durable compensation phase
    // FIRST (it transitions failed → compensating as its first durable action)
    // and only tear down once it settles to compensated / compensation_failed.
    if (run.status === 'failed' && this.options.compensationHandlers) {
      run = await this.runCompensation(run);
    }

    if (isTerminalState(run.status)) {
      cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
      hookRegistry.unregister(runId);

      // Promote concurrency-queued drafts immediately when a slot frees up.
      // Don't wait for the scheduler poll cycle (could be 60s+).
      if (run.concurrencyKey) {
        this.promoteConcurrencyDrafts(run.workflowId, run.concurrencyKey);
      }
    }

    return run;
  }

  /**
   * Durable saga compensation phase (v2.4). Thin delegate — the walk lives in
   * `./saga.js` (`runCompensation`). Inline entry from a freshly-`failed` run:
   * `failed → compensating` CAS as the first durable action, then the walk.
   */
  private async runCompensation(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>> {
    return runCompensationImpl(this, run);
  }

  /**
   * Crash-recovery entrypoint for a run left in `compensating` after a process
   * died mid-rollback. Thin delegate to `./saga.js` (`recoverCompensation`).
   * Wired into the scheduler's poll via `getStaleCompensatingRuns`.
   */
  async recoverCompensation(
    runId: string,
    staleThresholdMs: number,
  ): Promise<WorkflowRun<TContext> | null> {
    return recoverCompensationImpl(this, runId, staleThresholdMs);
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

  /**
   * workflowId routing guard (v2.4.0 distributed-correctness fix).
   *
   * Defense-in-depth companion to the scheduler-query scoping: even a direct
   * or manual call to `execute`/`executeRetry`/`recoverStale`/`resume` with a
   * run that belongs to a DIFFERENT workflow must NOT run this engine's step
   * graph against it. This decides ownership and either delegates to the
   * owning engine or no-ops.
   *
   * Returns `{ handled: false }` when the run is OURS (`workflowId` matches
   * this engine's definition id) — the caller proceeds with local execution.
   *
   * Returns `{ handled: true, result }` when the run is FOREIGN:
   *   - If an engine is registered for the run's `workflowId` (version-pinned
   *     via `lookupVersion(workflowId, definitionVersion)` first, falling back
   *     to the active `getEngine(workflowId)`), delegate to it via `delegate`
   *     and return its result.
   *   - If NO engine is registered for that workflowId, no-op (`result: null`):
   *     we must never execute a foreign run, and there's no correct engine to
   *     hand it to. The scheduler/caller treats `null` as "not mine."
   *
   * Does NOT break legitimate cross-engine child/branchJoin flows: those
   * reconciliation paths only ever invoke `resume` on the PARENT run through
   * the PARENT engine (whose workflowId matches the parent run), and child
   * runs are driven by the child's own engine — so this guard always sees a
   * matching workflowId on those calls and returns `{ handled: false }`.
   */
  private async routeForeignRun(
    run: WorkflowRun<TContext>,
    delegate: (engine: WorkflowEngine<unknown>) => Promise<unknown>,
  ): Promise<{ handled: boolean; result?: unknown }> {
    if (run.workflowId === this.definition.id) {
      return { handled: false };
    }

    // Foreign run — resolve the owning engine, honouring version pinning.
    const owner =
      (run.definitionVersion
        ? workflowRegistry.lookupVersion(run.workflowId, run.definitionVersion)
        : undefined) ?? workflowRegistry.getEngine(run.workflowId);

    if (owner && owner !== (this as unknown as WorkflowEngine<unknown>)) {
      return { handled: true, result: await delegate(owner) };
    }

    // No engine registered for this foreign workflowId (or it resolved back to
    // us, which shouldn't happen given the id mismatch above). Do NOT execute
    // a foreign run on this engine's step graph — no-op.
    return { handled: true, result: null };
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
        const { run: updatedRun } = await this.executor.resumeStep(refreshedRun, undefined);
        this.container.cache.set(updatedRun);
        return true;
      }
      return false;
    }

    // Child workflow wait — auto-start the child (first entry) or reconcile
    // against an already-started child (re-entry, e.g. after a crash). See
    // `handleChildWorkflowWait`.
    if (stepState.waitingFor?.type === 'childWorkflow') {
      await this.handleChildWorkflowWait(runId, run);
      // Break — child completion drives the resume (in-process listener
      // when alive, scheduler reconciliation poll otherwise).
      return false;
    }

    // Branch-join wait — fan out the parallel branch children (first entry)
    // or reconcile their statuses against the join policy (re-entry / crash
    // recovery). Mirrors the childWorkflow wait. See `handleBranchJoinWait`.
    if (stepState.waitingFor?.type === 'branchJoin') {
      await this.handleBranchJoinWait(runId, run);
      // Break — branch completion drives the resume (in-process listener when
      // alive, scheduler branch-join reconciliation poll otherwise).
      return false;
    }

    // Human / webhook wait — break and let an external resume drive it.
    //
    // If the wait carries an `expiresAt` deadline, ensure the scheduler is
    // polling so its expiry sweep can auto-resume the run with a timeout
    // sentinel once the deadline passes. A human wait otherwise never arms the
    // poller (unlike timer/sleep waits, which call `scheduleResume`), so
    // without this an `expiresAt` would silently never fire on a scheduler
    // that booted idle. We deliberately ensure POLLING (the durable DB sweep)
    // rather than arming an in-memory `scheduleResume` timer: that timer
    // resumes with NO payload, which would complete the wait as an empty
    // answer instead of the `{ __waitResolved: 'timeout' }` sentinel.
    if (stepState.waitingFor?.expiresAt) {
      this.scheduler.start();
    }
    return false;
  }

  private findCurrentStep(run: WorkflowRun<TContext>): StepState | undefined {
    return run.steps.find((s) => s.stepId === run.currentStepId);
  }

  /**
   * Handle a `childWorkflow` wait — crash-durable. Thin delegate to
   * `./child-workflow.js` (`handleChildWorkflowWait`). Auto-starts the child
   * on first entry; reconciles against an already-started child on re-entry
   * (crash recovery / scheduler sweep). Both paths resume the parent via
   * `this.resume`, whose `waiting → running` claim makes listener + poll
   * mutually exclusive.
   */
  private async handleChildWorkflowWait(runId: string, run: WorkflowRun<TContext>): Promise<void> {
    return handleChildWorkflowWait(this, runId, run);
  }

  /**
   * Handle a `branchJoin` wait — crash-durable. Thin delegate to
   * `./parallel-steps.js` (`handleBranchJoinWait`). Fans out the branch
   * children on first entry; reconciles their statuses against the join
   * policy on re-entry (crash recovery / scheduler branch-join sweep). Resumes
   * the parent via `this.resume(runId, joinResult)`, whose waiting→running
   * claim makes listener + poll mutually exclusive.
   */
  private async handleBranchJoinWait(runId: string, run: WorkflowRun<TContext>): Promise<void> {
    return handleBranchJoinWait(this, runId, run);
  }

  /**
   * Fail a `branchJoin` step under `policy:'all'` when a branch failed, then
   * drive saga compensation of prior completed steps. Public so
   * `./parallel-steps.js` (`handleBranchJoinWait`) can call it via the
   * `BranchJoinEngine` view.
   *
   * Atomicity: claim `waiting → running` first (so a concurrent listener / a
   * second poller that would resume the same step loses and no-ops), then
   * write step `failed` + run `failed` via narrow `$set`, emit the standard
   * `workflow:failed` event, run compensation, and tear down listeners on a
   * terminal outcome. Returns false when this caller lost the claim.
   */
  async failBranchJoinStep(
    runId: string,
    error: { message: string; code?: string },
  ): Promise<boolean> {
    // The CAS + narrow fail-write (the durable, race-safe portion) lives in
    // `./parallel-steps.js`. It returns false when another driver won the
    // waiting→running claim (no-op). On success we run the SAME terminal
    // handling as `execute()`'s post-loop: drive saga compensation of prior
    // completed steps, then tear down listeners/hooks on a terminal outcome.
    const claimed = await writeBranchJoinFailure(this, runId, error);
    if (!claimed) return false;

    let run = await this.getOrThrow(runId);
    if (run.status === 'failed' && this.options.compensationHandlers) {
      run = await this.runCompensation(run);
    }
    if (isTerminalState(run.status)) {
      cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
      hookRegistry.unregister(runId);
    }
    return true;
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

    // workflowId routing guard (v2.4.0). If this run belongs to a different
    // workflow, delegate to its owning engine (preserving the payload) or
    // no-op — never resume a foreign run on this engine's step graph. NOTE:
    // legitimate cross-engine flows are SAFE here because they only ever call
    // resume on runs of their OWN workflowId: the childWorkflow/branchJoin
    // helpers resume the PARENT run via the parent engine (`engine.resume`),
    // and the parent engine's workflowId == the parent run's workflowId. The
    // CHILD runs are advanced by the child's own engine. So this guard routes
    // only genuinely-foreign calls and leaves parent/child reconciliation
    // untouched.
    const routed = await this.routeForeignRun(run, (engine) => engine.resume(runId, payload));
    if (routed.handled) return routed.result as WorkflowRun<TContext>;

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

      // Child-workflow wait, no payload — this is a crash-durable
      // reconciliation poll (scheduler's child-waiting sweep calls
      // `resume(runId)` with no payload), NOT a completion signal. Routing it
      // through `resumeStep(undefined)` would WRONGLY complete the step with
      // an undefined child result before the child has finished. Instead,
      // reconcile against the child: resume only if the child is terminal,
      // otherwise re-arm listeners + bump the reconcile cadence and stay
      // `waiting`.
      //
      // The in-process listeners and manual `resume(runId, output)` callers
      // DO pass a payload, so they fall through to the normal completion path
      // below. The `waiting → running` claim in `resumeStep` still makes
      // listener-vs-poll mutually exclusive if both somehow drive a resume.
      if (
        stepState?.status === 'waiting' &&
        stepState.waitingFor?.type === 'childWorkflow' &&
        payload === undefined
      ) {
        await this.handleChildWorkflowWait(runId, run);
        // Return current state — reconciliation either already resumed the
        // run (terminal child) or left it waiting (active child).
        return (await this.get(runId)) ?? run;
      }

      // Branch-join wait, no payload — crash-durable reconciliation poll
      // (scheduler's branch-join sweep calls `resume(runId)` with no payload).
      // Re-read all branch children, evaluate the join quorum, and resume only
      // when satisfied; otherwise stay `waiting` and bump the cadence. Routing
      // it through `resumeStep(undefined)` would WRONGLY complete the step with
      // an undefined result before the branches finished. In-process listeners
      // and quorum-met reconciles pass the JoinResult payload and fall through.
      if (
        stepState?.status === 'waiting' &&
        stepState.waitingFor?.type === 'branchJoin' &&
        payload === undefined
      ) {
        await this.handleBranchJoinWait(runId, run);
        return (await this.get(runId)) ?? run;
      }

      // If step is 'waiting' (explicit wait/sleep/waitFor), complete it with payload
      if (stepState?.status === 'waiting') {
        cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
        const { run: updatedRun, won } = await this.executor.resumeStep(run, payload);
        this.container.cache.set(updatedRun);
        // Lost the resume CAS to a concurrent resume — the winner already
        // advanced + drove execution. Do NOT re-drive (would double-execute
        // the next step). Return the freshest persisted state as a no-op.
        if (!won) return updatedRun;
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
    // workflowId routing guard (v2.4.0). Cheap pre-read by id to decide
    // ownership BEFORE the CAS claim — workflowId is immutable, so the pre-read
    // is race-free for the routing decision even though the run's status may
    // change before the claim (the claim's CAS still guards that). Route a
    // foreign run to its owning engine's recoverStale, or no-op if none.
    const peek = await this.container.repository.getById(runId, { bypassTenant: true });
    if (peek) {
      const routed = await this.routeForeignRun(peek as WorkflowRun<TContext>, (engine) =>
        engine.recoverStale(runId, staleThresholdMs),
      );
      if (routed.handled) return routed.result as WorkflowRun<TContext> | null;
    }

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
      {
        $set: { lastHeartbeat: new Date(), updatedAt: new Date() },
        $inc: { recoveryAttempts: 1 },
      },
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
            },
            // `$set: { startedAt: undefined }` is DROPPED by the Mongo driver
            // (undefined is stripped from the update doc), so startedAt would
            // survive and the re-run would compute a wrong durationMs measured
            // from the FIRST attempt. `$unset` actually clears it (matches the
            // sibling reset in executor.claimStepExecution, which re-stamps a
            // fresh startedAt on the next claim).
            $unset: {
              [`steps.${stepIndex}.startedAt`]: '',
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

    // workflowId routing guard (v2.4.0 distributed-correctness fix).
    //
    // executeRetry historically claimed BLIND (by runId only, no workflowId
    // guard), so engine B picking up engine A's retry/scheduled/concurrency
    // draft would CAS-claim it and run B's step graph → A's run fails with
    // step-not-found. We close that with a cheap PRE-READ (getById by runId,
    // bypassTenant) to learn the run's workflowId BEFORE the CAS.
    //
    // Why pre-read rather than claim-then-verify-then-route: claim-then-verify
    // would have ALREADY transitioned the foreign run to `running` under the
    // wrong engine before we noticed — we'd then have to roll it back, a race.
    // The pre-read is safe because `workflowId` is IMMUTABLE: the routing
    // decision can't be invalidated by a concurrent status change. The actual
    // claim below still uses the atomic CAS, so concurrent retriers of the
    // SAME (correct) engine still resolve to exactly one winner.
    const peek = await this.container.repository.getById(runId, { bypassTenant: true });
    if (peek) {
      const routed = await this.routeForeignRun(peek as WorkflowRun<TContext>, (engine) =>
        engine.executeRetry(runId),
      );
      if (routed.handled) return routed.result as WorkflowRun<TContext> | null;
    }

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

      // Recurring schedule: the claim CAS guarantees exactly one worker won
      // this occurrence, so the winner spawns the NEXT occurrence as a new
      // draft. The deterministic idempotency key (`workflowId:recur:<nextISO>`)
      // makes the spawn replay-safe — a crash-recovered or duplicate attempt
      // dedupes against the active draft instead of double-creating.
      if (claimed?.scheduling?.recurrence) {
        await this.spawnNextRecurrence(claimed as WorkflowRun<TContext>).catch((err) => {
          this.container.eventBus.emit('engine:error', {
            runId,
            error: toError(err),
            context: 'recurrence-spawn',
          });
        });
      }
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
   * Create the next occurrence of a recurring scheduled run as a fresh draft.
   *
   * Called by `executeRetry` immediately after winning the scheduled-draft
   * claim (exactly one worker per occurrence). The next draft:
   *   - copies the prior run's `input`, persisted `context` (preserving any
   *     tenant scoping already stamped into it), `priority`, `userId`, `tags`
   *     and `meta`;
   *   - carries `scheduling` advanced by `computeNextOccurrence` (DST-aware,
   *     no catch-up of missed firings, `until`/`count` enforced);
   *   - is deduplicated by a deterministic idempotency key, so replays of
   *     this method can never double-spawn.
   *
   * Returns silently when the chain is finished (`computeNextOccurrence`
   * yields null).
   */
  private async spawnNextRecurrence(prior: WorkflowRun<TContext>): Promise<void> {
    if (!prior.scheduling) return;
    const next = computeNextOccurrence(prior.scheduling);
    if (!next) return;

    const run = this.registry.createRun(prior.input, prior.meta);
    run.status = 'draft';
    // Preserve the persisted context (tenant scope, enrichment) rather than
    // re-deriving from input — the prior run's context is the source of truth.
    run.context = prior.context;
    run.scheduling = next;
    run.idempotencyKey = `${prior.workflowId}:recur:${next.executionTime.toISOString()}`;
    if (prior.priority !== undefined) run.priority = prior.priority;
    if (prior.userId !== undefined) run.userId = prior.userId;
    if (prior.tags !== undefined) run.tags = prior.tags;

    // bypassTenant: the copied context already carries the tenant field; the
    // E11000/idempotency catch inside create() absorbs duplicate spawns.
    await this.container.repository.create(run, { bypassTenant: true });

    // Make sure something is polling to pick the new draft up when due.
    this.scheduler.start();
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

    // `rewindRun` computes the rewound in-memory shape (resetting steps from
    // the target onward; preserving `output`/`outputHistory` on
    // history-enabled steps so a re-success can archive the prior generation).
    const rewoundRun = this.registry.rewindRun(run, stepId);

    // Persist via NARROW per-step $set/$unset, NOT a full-document
    // `updateById(rewoundRun)` spread. The full-doc path triggers mongoose-9's
    // update-cast to coerce the embedded `steps[]` plain objects into
    // Subdocument instances in place, poisoning the cache (invariant #8 — the
    // same hazard `cancel()`/`pause()` avoid). Build the field map from the
    // already-computed rewound steps so history preservation rides the narrow
    // write instead of widening it.
    const targetIndex = this.registry.definition.steps.findIndex((s) => s.id === stepId);
    const set: Record<string, unknown> = {
      currentStepId: rewoundRun.currentStepId,
      status: rewoundRun.status,
      updatedAt: new Date(),
    };
    const unset: Record<string, ''> = {
      output: '',
      endedAt: '',
      error: '',
    };

    rewoundRun.steps.forEach((step, index) => {
      if (index < targetIndex) return; // untouched steps stay as-is
      set[`steps.${index}.status`] = step.status;
      set[`steps.${index}.attempts`] = step.attempts;
      // Reset fields that the fresh state omits.
      unset[`steps.${index}.error`] = '';
      unset[`steps.${index}.startedAt`] = '';
      unset[`steps.${index}.completedAt`] = '';
      unset[`steps.${index}.endedAt`] = '';
      unset[`steps.${index}.durationMs`] = '';
      unset[`steps.${index}.waitingFor`] = '';
      unset[`steps.${index}.retryAfter`] = '';
      // Output + history: preserved by `rewindRun` for history-enabled steps,
      // dropped otherwise. Mirror that exactly with $set (present) / $unset.
      if (step.output !== undefined) set[`steps.${index}.output`] = step.output;
      else unset[`steps.${index}.output`] = '';
      if (step.outputHistory !== undefined)
        set[`steps.${index}.outputHistory`] = step.outputHistory;
      else unset[`steps.${index}.outputHistory`] = '';
      // pinnedVersion is per-generation metadata — clear it on rewind.
      unset[`steps.${index}.pinnedVersion`] = '';
    });

    await this.container.repository.updateOne(
      { _id: runId, status: { $ne: 'cancelled' } },
      { $set: set, $unset: unset },
      { bypassTenant: true },
    );
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

    // If the run is parked on a branchJoin wait, cancel its branch children so
    // cancelling the parent doesn't orphan N still-running child workflows
    // (which burn compute until TTL). Tolerant of already-terminal children.
    await cancelBranchChildren(run);

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
        // Keep the engine-scoping filter on reconfigure (see constructor).
        this.definition.id,
      );

      // Re-set callbacks
      this.scheduler.setStaleRecoveryCallback(async (runId, thresholdMs) => {
        return this.recoverStale(runId, thresholdMs);
      });
      this.scheduler.setRetryCallback(async (runId) => {
        return this.executeRetry(runId);
      });
      this.scheduler.setCompensationRecoveryCallback(async (runId, thresholdMs) => {
        return this.recoverCompensation(runId, thresholdMs);
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

    // Remove the concurrency slot-release listeners (registered once in the
    // constructor; not tracked in `eventListeners`).
    this.removeSlotReleaseListeners?.();
    this.releasedSlots.clear();

    // Remove from the global registry — without this, a v2 engine resuming
    // a v1 run would still route execution to a v1 engine the host has
    // explicitly torn down. The unregister method `ref.deref() === this`
    // guards the active-map slot so we don't accidentally evict a newer
    // engine that took our place under the same workflowId.
    workflowRegistry.unregister(this.definition.id, this as unknown as WorkflowEngine<unknown>);
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
