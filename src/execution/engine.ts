import { StepExecutor } from './executor.js';
import {
  SmartScheduler,
  DEFAULT_SCHEDULER_CONFIG,
  type SmartSchedulerConfig,
} from './smart-scheduler.js';
import { WorkflowRegistry } from '../workflow/registry.js';
import { isTerminalState } from '../core/status.js';
import { TIMING } from '../config/constants.js';
import { WorkflowNotFoundError, InvalidStateError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowHandlers,
  WorkflowEventPayload,
  StepState,
} from '../core/types.js';
import type { StreamlineContainer } from '../core/container.js';
import type { WorkflowEventBus } from '../core/events.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import type { WorkflowCache } from '../storage/cache.js';

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
// Inline Utilities
// ============================================================================

/**
 * Clean up all event listeners for a specific workflow
 */
function cleanupEventListeners(
  runId: string,
  listeners: Map<string, { listener: (...args: unknown[]) => void; eventName: string }>,
  eventBus: WorkflowEventBus
): void {
  const prefix = `${runId}:`;
  const keysToRemove = Array.from(listeners.keys()).filter(key => key.startsWith(prefix));

  for (const key of keysToRemove) {
    const entry = listeners.get(key);
    if (entry) {
      eventBus.off(entry.eventName, entry.listener);
      listeners.delete(key);
    }
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
  cache: WorkflowCache
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
    const claimed = await repository.updateOne(
      {
        _id: runId,
        status: 'waiting',
        paused: { $ne: true },
      },
      { status: 'running', updatedAt: new Date(), lastHeartbeat: new Date() },
      { bypassTenant: true }
    );

    if (claimed.modifiedCount > 0) {
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
  private executor: StepExecutor<TContext>;
  private scheduler: SmartScheduler;
  private registry: WorkflowRegistry<TContext>;
  private options: WorkflowEngineOptions;
  private eventListeners: Map<string, { listener: (...args: unknown[]) => void; eventName: string }>;

  /** Exposed for hook registry and external access */
  readonly container: StreamlineContainer;

  constructor(
    definition: WorkflowDefinition<TContext>,
    public readonly handlers: WorkflowHandlers<TContext>,
    container: StreamlineContainer,
    options: WorkflowEngineOptions = {}
  ) {
    this.container = container;
    this.registry = new WorkflowRegistry(definition, handlers);
    this.executor = new StepExecutor(
      this.registry,
      container.repository,
      container.eventBus,
      container.cache
    );
    this.eventListeners = new Map();

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
      container.eventBus
    );

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
   * @param meta - Optional metadata (userId, tags, etc.)
   * @returns The created workflow run
   */
  async start(input: unknown, meta?: Record<string, unknown>): Promise<WorkflowRun<TContext>> {
    const run = this.registry.createRun(input, meta);
    run.status = 'running';
    run.startedAt = new Date();

    await this.container.repository.create(run);
    this.container.cache.set(run);

    // Register this engine for the run so resumeHook() can find it
    hookRegistry.register(run._id, this as unknown as WorkflowEngine<unknown>);

    this.container.eventBus.emit('workflow:started', { runId: run._id });

    // Auto-execute if enabled (default: true)
    if (this.options.autoExecute) {
      setImmediate(() =>
        this.execute(run._id).catch((err) => {
          this.container.eventBus.emit('engine:error', {
            runId: run._id,
            error: err,
            context: 'auto-execution',
          });
        })
      );
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
          run = (await this.get(runId))!;
        }

        // Handle terminal states
        if (isTerminalState(run.status)) {
          cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
          break;
        }
      }
    } catch (error) {
      // Handle cancellation gracefully - workflow was cancelled during execution
      if (error instanceof InvalidStateError) {
        // Refresh from DB to get the cancelled state
        const cancelled = await this.get(runId);
        if (cancelled) {
          run = cancelled;
        }
        // Fall through to cleanup below
      } else {
        throw error; // Re-throw non-cancellation errors
      }
    }

    // Clean up on terminal states
    if (isTerminalState(run.status)) {
      cleanupEventListeners(runId, this.eventListeners, this.container.eventBus);
      hookRegistry.unregister(runId);
    }

    return run;
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
    run: WorkflowRun<TContext>
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
    prevStepStatus: string | undefined
  ): boolean {
    const currentStep = run.steps.find((s) => s.stepId === run.currentStepId);
    const isRetryPending = currentStep?.status === 'pending' && currentStep?.retryAfter;

    return (
      run.currentStepId === prevStepId &&
      currentStep?.status === prevStepStatus &&
      !isRetryPending
    );
  }

  /**
   * Handle different waiting states (event, retry, timer, human input)
   * @returns true if execution should continue, false to break
   */
  private async handleWaitingState(
    runId: string,
    run: WorkflowRun<TContext>
  ): Promise<boolean> {
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
    run: WorkflowRun<TContext>
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
      { status: 'failed', updatedAt: now, endedAt: now, error: errorPayload },
      { bypassTenant: true }
    );

    run.status = 'failed';
    run.updatedAt = now;
    run.endedAt = now;
    run.error = errorPayload;

    this.container.eventBus.emit('workflow:failed', { runId, data: { error: errorPayload } });
    return run;
  }

  /**
   * Register event listener for event-based waits
   * IMPORTANT: Paused workflows will NOT be resumed by events until explicitly resumed by user
   */
  private handleEventWait(runId: string, eventName: string): void {
    const listenerKey = `${runId}:${eventName}`;

    if (this.eventListeners.has(listenerKey)) return;

    const listener = async (...args: unknown[]) => {
      const payload = args[0] as WorkflowEventPayload | undefined;
      try {
        // Warn about unintentional broadcasts
        if (payload && !payload.runId && !payload.broadcast) {
          logger.warn(
            `Event '${eventName}' emitted without runId or broadcast flag. ` +
              `This will resume ALL workflows waiting on '${eventName}'.`,
            { runId, eventName }
          );
        }

        // Resume if: no payload, runId matches, or explicit broadcast
        if (!payload || payload.runId === runId || payload.broadcast === true) {
          // Check if workflow is paused before resuming
          const run = await this.get(runId);
          if (run?.paused) {
            // Workflow is paused - ignore event but keep listener active
            return;
          }

          const entry = this.eventListeners.get(listenerKey);
          if (entry) {
            this.container.eventBus.off(entry.eventName, entry.listener);
            this.eventListeners.delete(listenerKey);
          }
          await this.resume(runId, payload?.data);
        }
      } catch (err) {
        this.container.eventBus.emit('engine:error', {
          runId,
          error: err as Error,
          context: 'event-handler',
        });
      }
    };

    this.container.eventBus.on(eventName, listener);
    this.eventListeners.set(listenerKey, { listener, eventName });
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
      this.container.cache
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
      this.container.cache
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

    // Clear paused flag
    if (run.paused) {
      run.paused = false;
      run.updatedAt = new Date();
      await this.container.repository.update(runId, run, { bypassTenant: true });
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
    payload?: unknown
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

    // Otherwise, just continue execution (pending step or retry backoff)
    run.status = 'running';
    run.lastHeartbeat = new Date();
    await this.container.repository.update(runId, run, { bypassTenant: true });
    this.container.cache.set(run);
    return this.execute(runId);
  }

  /**
   * Recover a stale 'running' workflow (crashed mid-execution)
   * Uses atomic claim to prevent multiple servers from recovering the same workflow
   */
  async recoverStale(
    runId: string,
    staleThresholdMs: number
  ): Promise<WorkflowRun<TContext> | null> {
    const staleTime = new Date(Date.now() - staleThresholdMs);

    // Atomic claim: Only recover if status is 'running' AND heartbeat is stale
    const claimResult = await this.container.repository.updateOne(
      {
        _id: runId,
        status: 'running',
        $or: [{ lastHeartbeat: { $lt: staleTime } }, { lastHeartbeat: { $exists: false } }],
      },
      { lastHeartbeat: new Date(), updatedAt: new Date() },
      { bypassTenant: true }
    );

    if (claimResult.modifiedCount === 0) {
      return null;
    }

    // We successfully claimed the stale workflow, now re-execute it
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

    // First, try to claim a retry workflow (status: waiting)
    let claimResult = await this.container.repository.updateOne(
      {
        _id: runId,
        status: 'waiting',
        paused: { $ne: true },
        steps: {
          $elemMatch: {
            status: 'pending',
            retryAfter: { $lte: now },
          },
        },
      },
      {
        $set: {
          status: 'running',
          updatedAt: now,
          lastHeartbeat: now,
        },
      },
      { bypassTenant: true }
    );

    // If no retry workflow found, try to claim a scheduled workflow (status: draft)
    if (claimResult.modifiedCount === 0) {
      claimResult = await this.container.repository.updateOne(
        {
          _id: runId,
          status: 'draft',
          'scheduling.executionTime': { $lte: now },
          paused: { $ne: true },
        },
        {
          $set: {
            status: 'running',
            updatedAt: now,
            lastHeartbeat: now,
            startedAt: now,
          },
        },
        { bypassTenant: true }
      );
    }

    if (claimResult.modifiedCount === 0) {
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
    await this.container.repository.update(runId, rewoundRun, { bypassTenant: true });
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

    const cancelledRun: WorkflowRun<TContext> = {
      ...run,
      status: 'cancelled',
      endedAt: new Date(),
      updatedAt: new Date(),
    };

    await this.container.repository.update(runId, cancelledRun, { bypassTenant: true });

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

    const pausedRun: WorkflowRun<TContext> = {
      ...run,
      paused: true,
      updatedAt: new Date(),
    };

    await this.container.repository.update(runId, pausedRun, { bypassTenant: true });
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
        this.container.eventBus
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

    // Clean up all event listeners
    for (const [, entry] of this.eventListeners.entries()) {
      this.container.eventBus.off(entry.eventName, entry.listener);
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
