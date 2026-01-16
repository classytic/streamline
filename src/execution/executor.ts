import { StepContextImpl, WaitSignal } from './context.js';
import { deriveRunStatus } from '../core/status.js';
import { isConditionalStep, shouldSkipStep } from '../features/conditional.js';
import { calculateRetryDelay } from '../utils/helpers.js';
import { TIMING, RETRY } from '../config/constants.js';
import { StepNotFoundError, WorkflowNotFoundError, InvalidStateError } from '../utils/errors.js';
import { buildStepUpdateOps, applyStepUpdates, toPlainRun } from './step-updater.js';
import type { WorkflowRun, StepState, StepHandler } from '../core/types.js';
import type { WorkflowRegistry } from '../workflow/registry.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import type { WorkflowEventBus } from '../core/events.js';
import type { WorkflowCache } from '../storage/cache.js';

/**
 * Cancelled is the only externally-forced terminal state.
 * 'done' and 'failed' are reached through normal execution flow.
 * We only guard against 'cancelled' to prevent race conditions where
 * a cancelled workflow gets updated by an in-flight handler.
 */
const CANCELLED_GUARD = { status: { $ne: 'cancelled' } };

/**
 * Type-safe interface for WaitSignal data payload.
 * Used when steps call ctx.wait(), ctx.sleep(), or ctx.waitFor().
 */
interface WaitSignalData {
  /** Resume time for timer-based waits (ctx.sleep) */
  resumeAt?: Date;
  /** Event name for event-based waits (ctx.waitFor) */
  eventName?: string;
  /** Additional user-provided data */
  [key: string]: unknown;
}

/**
 * Executor for workflow steps.
 *
 * Handles step execution with support for:
 * - Conditional execution (skip steps based on conditions)
 * - Atomic claiming (prevents duplicate execution in multi-worker setups)
 * - Retry with exponential backoff
 * - Timeout handling
 * - Wait states (sleep, human input, events)
 */
export class StepExecutor<TContext = Record<string, unknown>> {
  /** Track active AbortControllers by runId for cancellation support */
  private activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly registry: WorkflowRegistry<TContext>,
    private readonly repository: WorkflowRunRepository,
    private readonly eventBus: WorkflowEventBus,
    private readonly cache: WorkflowCache
  ) {}

  /**
   * Abort any in-flight step execution for a workflow.
   * Called by engine.cancel() to stop long-running handlers.
   *
   * **Multi-worker limitation**: This only aborts handlers running in this process.
   * If another worker is executing the step, the abort signal won't reach it.
   * However, DB-level guards prevent cancelled workflows from being updated,
   * so the other worker's updates will be rejected and the workflow stays cancelled.
   */
  abortWorkflow(runId: string): void {
    const controller = this.activeControllers.get(runId);
    if (controller) {
      controller.abort(new Error('Workflow cancelled'));
      this.activeControllers.delete(runId);
    }
  }

  // ============ Helper Methods ============

  /**
   * Find a step by ID in a workflow run, throwing if not found
   */
  private findStepOrThrow(
    run: WorkflowRun<TContext>,
    stepId: string
  ): { step: StepState; index: number } {
    const index = run.steps.findIndex((s) => s.stepId === stepId);
    if (index === -1) {
      const availableSteps = run.steps.map((s) => s.stepId);
      throw new StepNotFoundError(stepId, run.workflowId, availableSteps);
    }
    return { step: run.steps[index], index };
  }

  /**
   * Check if step should be skipped due to conditions.
   * Returns updated run if skipped, null otherwise.
   */
  private async checkConditionalSkip(
    run: WorkflowRun<TContext>,
    stepId: string,
    step: import('../core/types.js').Step
  ): Promise<WorkflowRun<TContext> | null> {
    if (!isConditionalStep(step)) {
      return null;
    }

    const skip = await shouldSkipStep(step, run.context, run);
    if (!skip) {
      return null;
    }

    run = await this.updateStepState(run, stepId, {
      status: 'skipped',
      endedAt: new Date(),
    });
    this.eventBus.emit('step:skipped', { runId: run._id, stepId });
    return await this.moveToNextStep(run);
  }

  /**
   * Check if step is waiting for retry backoff.
   * Returns updated run if waiting, null otherwise.
   */
  private async checkRetryBackoff(
    run: WorkflowRun<TContext>,
    currentStepState: StepState
  ): Promise<WorkflowRun<TContext> | null> {
    if (!currentStepState.retryAfter || new Date() >= currentStepState.retryAfter) {
      return null;
    }

    // Too early to retry - ensure workflow is waiting so scheduler handles it
    if (run.status !== 'waiting') {
      const now = new Date();
      const result = await this.repository.updateOne(
        { _id: run._id, ...CANCELLED_GUARD },
        { status: 'waiting', updatedAt: now },
        { bypassTenant: true }
      );
      // Only update in-memory if DB accepted the update
      if (result.modifiedCount > 0) {
        run.status = 'waiting';
        run.updatedAt = now;
      } else {
        // DB rejected update (workflow cancelled) - invalidate cache for consistency
        this.cache.delete(run._id);
      }
    }
    return run;
  }

  /**
   * Check if step is already running by another worker.
   * Returns refreshed run if already running, null otherwise.
   */
  private async checkAlreadyRunning(
    run: WorkflowRun<TContext>,
    currentStepState: StepState
  ): Promise<WorkflowRun<TContext> | null> {
    if (currentStepState.status !== 'running') {
      return null;
    }

    // Refresh from DB to get latest state (worker may have already completed it)
    const refreshed = await this.repository.getById(run._id);
    if (!refreshed) {
      throw new WorkflowNotFoundError(run._id);
    }
    return refreshed as WorkflowRun<TContext>;
  }

  /**
   * Main execution method for a single step.
   * Orchestrates conditional checks, atomic claiming, and handler execution.
   */
  async executeStep(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>> {
    const stepId = run.currentStepId!;
    const step = this.registry.getStep(stepId);
    const handler = this.registry.getHandler(stepId);

    if (!step || !handler) {
      const availableSteps = this.registry.definition.steps.map(s => s.id);
      throw new StepNotFoundError(stepId, run.workflowId, availableSteps);
    }

    // 1. Check conditional skip
    const skippedRun = await this.checkConditionalSkip(run, stepId, step);
    if (skippedRun) return skippedRun;

    // 2. Check retry backoff
    const currentStepState = run.steps.find((s) => s.stepId === stepId)!;
    const waitingRun = await this.checkRetryBackoff(run, currentStepState);
    if (waitingRun) return waitingRun;

    // 3. Check if already running
    const runningRun = await this.checkAlreadyRunning(run, currentStepState);
    if (runningRun) return runningRun;

    // 4. Claim step for execution (atomic)
    const claimedRun = await this.claimStepExecution(run, stepId, currentStepState);
    if (!claimedRun) {
      // Another worker claimed it - refresh and return
      const refreshed = await this.repository.getById(run._id);
      if (!refreshed) throw new WorkflowNotFoundError(run._id);
      return refreshed as WorkflowRun<TContext>;
    }

    // 5. Execute the step handler
    return await this.executeStepHandler(claimedRun, stepId, step, handler);
  }

  /**
   * Atomically claim a step for execution.
   * Uses MongoDB atomic update to prevent duplicate execution in multi-worker setups.
   * Returns updated run if claim succeeded, null if another worker claimed it.
   */
  private async claimStepExecution(
    run: WorkflowRun<TContext>,
    stepId: string,
    currentStepState: StepState
  ): Promise<WorkflowRun<TContext> | null> {
    const stepIndex = run.steps.findIndex((s) => s.stepId === stepId);
    if (stepIndex === -1) {
      const availableSteps = this.registry.definition.steps.map(s => s.id);
      throw new StepNotFoundError(stepId, run.workflowId, availableSteps);
    }

    const newAttempts = currentStepState.attempts + 1;
    const now = new Date();

    // Atomic claim with conditional filter (includes cancellation guard)
    const claimResult = await this.repository.updateOne(
      {
        _id: run._id,
        ...CANCELLED_GUARD,
        [`steps.${stepIndex}.status`]: { $in: ['pending', 'failed'] },
        $or: [
          { [`steps.${stepIndex}.retryAfter`]: { $exists: false } },
          { [`steps.${stepIndex}.retryAfter`]: { $lte: now } },
        ],
      },
      {
        $set: {
          [`steps.${stepIndex}.status`]: 'running',
          [`steps.${stepIndex}.startedAt`]: now,
          [`steps.${stepIndex}.attempts`]: newAttempts,
          lastHeartbeat: now,
        },
        $unset: {
          [`steps.${stepIndex}.error`]: '',
          [`steps.${stepIndex}.waitingFor`]: '',
          [`steps.${stepIndex}.retryAfter`]: '',
        },
      },
      { bypassTenant: true }
    );

    if (claimResult.modifiedCount === 0) {
      return null; // Another worker claimed it
    }

    // Update in-memory state to match DB
    run = await this.updateStepState(run, stepId, {
      status: 'running',
      startedAt: now,
      attempts: newAttempts,
      error: undefined,
      waitingFor: undefined,
      retryAfter: undefined,
    });
    run.lastHeartbeat = now;

    this.eventBus.emit('step:started', { runId: run._id, stepId });
    return run;
  }

  /**
   * Execute the step handler and handle the result.
   * Handles success, wait signals, and failures.
   */
  private async executeStepHandler(
    run: WorkflowRun<TContext>,
    stepId: string,
    step: import('../core/types.js').Step,
    handler: StepHandler<unknown, TContext>
  ): Promise<WorkflowRun<TContext>> {
    const abortController = new AbortController();

    // Register controller for cancellation support
    this.activeControllers.set(run._id, abortController);

    try {
      const stepState = run.steps.find((s) => s.stepId === stepId)!;
      const ctx = new StepContextImpl(
        run._id,
        stepId,
        run.context,
        run.input,
        stepState.attempts,
        run,
        this.repository,
        this.eventBus,
        abortController.signal
      );

      const output = await this.executeWithTimeout(
        handler,
        ctx,
        step.timeout || this.registry.definition.defaults?.timeout,
        run._id,
        abortController
      );

      // Success - update step and move to next
      run = await this.updateStepState(run, stepId, {
        status: 'done',
        endedAt: new Date(),
        output,
        error: undefined,
        waitingFor: undefined,
        retryAfter: undefined,
      });

      this.eventBus.emit('step:completed', { runId: run._id, stepId, data: output });
      return await this.moveToNextStep(run);
    } catch (error) {
      if (error instanceof WaitSignal) {
        return await this.handleWait(run, stepId, error);
      } else if (error instanceof InvalidStateError) {
        // Workflow was cancelled - don't treat as retriable failure, just rethrow
        throw error;
      } else {
        return await this.handleFailure(run, stepId, error as Error);
      }
    } finally {
      // Unregister controller when step completes (success, failure, or wait)
      this.activeControllers.delete(run._id);
    }
  }

  private async executeWithTimeout<T>(
    handler: StepHandler<T, TContext>,
    ctx: StepContextImpl<TContext>,
    timeout?: number,
    runId?: string,
    abortController?: AbortController
  ): Promise<T> {
    // Start periodic heartbeat to prevent long-running steps from being marked stale
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (runId) {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.repository.updateOne(
            { _id: runId },
            { lastHeartbeat: new Date() },
            { bypassTenant: true } // Internal operation - already scoped by _id
          );
        } catch {
          // Ignore heartbeat errors - step execution continues
        }
      }, TIMING.HEARTBEAT_INTERVAL_MS);
    }

    const cleanup = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    try {
      if (!timeout) {
        const result = await handler(ctx);
        cleanup();
        return result;
      }

      const result = await Promise.race([
        handler(ctx),
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Abort the signal to cancel any operations using it
            if (abortController) {
              abortController.abort(new Error(`Step timeout after ${timeout}ms`));
            }
            reject(new Error(`Step timeout after ${timeout}ms`));
          }, timeout);
        }),
      ]);
      cleanup();
      return result;
    } catch (error) {
      cleanup();
      // Abort if not already aborted (e.g., handler threw before timeout)
      if (abortController && !abortController.signal.aborted) {
        abortController.abort(error);
      }
      throw error;
    }
  }

  /**
   * Handle a wait signal from a step handler.
   * Updates step state to waiting and emits events.
   */
  private async handleWait(
    run: WorkflowRun<TContext>,
    stepId: string,
    signal: WaitSignal
  ): Promise<WorkflowRun<TContext>> {
    const signalData = signal.data as WaitSignalData | undefined;
    const stepState = await this.updateStepState(run, stepId, {
      status: 'waiting',
      waitingFor: {
        type: signal.type,
        reason: signal.reason,
        resumeAt: signalData?.resumeAt,
        eventName: signalData?.eventName,
        data: signal.data,
      },
    });

    this.eventBus.emit('step:waiting', { runId: run._id, stepId, data: signal.data });
    this.eventBus.emit('workflow:waiting', { runId: run._id, data: signal.data });

    return stepState;
  }

  /**
   * Handle step failure with retry logic.
   * Implements exponential backoff with jitter for retries.
   * If all retries exhausted, marks step as failed.
   */
  private async handleFailure(
    run: WorkflowRun<TContext>,
    stepId: string,
    error: Error
  ): Promise<WorkflowRun<TContext>> {
    const step = this.registry.getStep(stepId);
    const stepState = run.steps.find((s) => s.stepId === stepId)!;
    const maxRetries = step?.retries ?? this.registry.definition.defaults?.retries ?? 3;

    // Check if error has retriable flag set to false (user explicitly disabled retries)
    const errorWithRetriable = error as Error & { retriable?: boolean };
    const isRetriable = errorWithRetriable.retriable !== false;

    // Check if we can retry (attempts is already incremented in executeStep)
    if (isRetriable && stepState.attempts < maxRetries) {
      // Calculate exponential backoff with jitter to prevent thundering herd
      const delayMs = calculateRetryDelay(
        TIMING.RETRY_BASE_DELAY_MS,
        stepState.attempts - 1,
        TIMING.RETRY_MULTIPLIER,
        TIMING.MAX_RETRY_DELAY_MS,
        RETRY.JITTER_FACTOR
      );
      const retryAfter = new Date(Date.now() + delayMs);

      // Set step to pending with retry info AND workflow to waiting
      // This allows scheduler to pick it up for retry
      // Note: Retries use retryAfter field, NOT waitingFor (which is for sleep/wait)
      const stepIndex = run.steps.findIndex((s) => s.stepId === stepId);
      const retryResult = await this.repository.updateOne(
        { _id: run._id, ...CANCELLED_GUARD },
        {
          $set: {
            status: 'waiting', // Workflow waits for retry timer
            updatedAt: new Date(),
            [`steps.${stepIndex}.status`]: 'pending',
            [`steps.${stepIndex}.retryAfter`]: retryAfter,
            [`steps.${stepIndex}.error`]: {
              message: error.message,
              retriable: true,
              stack: error.stack,
            },
          },
          $unset: {
            [`steps.${stepIndex}.waitingFor`]: '', // Clear any previous waitingFor
          },
        },
        { bypassTenant: true }
      );

      // Only update in-memory and emit events if DB accepted the update
      if (retryResult.modifiedCount > 0) {
        run.status = 'waiting';
        run.steps[stepIndex].status = 'pending';
        run.steps[stepIndex].retryAfter = retryAfter;
        run.steps[stepIndex].error = { message: error.message, retriable: true, stack: error.stack };
        run.steps[stepIndex] = { ...run.steps[stepIndex], waitingFor: undefined };

        this.eventBus.emit('step:retry-scheduled', {
          runId: run._id,
          stepId,
          data: { attempt: stepState.attempts, maxRetries, retryAfter },
        });
      } else {
        // DB rejected update (workflow cancelled) - invalidate cache for consistency
        this.cache.delete(run._id);
      }

      return run;
    }

    // Preserve error code if present
    const errorWithCode = error as Error & { code?: string };
    const failedRun = await this.updateStepState(run, stepId, {
      status: 'failed',
      endedAt: new Date(),
      error: {
        message: error.message,
        code: errorWithCode.code,
        retriable: false,
        stack: error.stack,
      },
    });

    this.eventBus.emit('step:failed', { runId: run._id, stepId, data: { error } });
    this.eventBus.emit('workflow:failed', { runId: run._id, data: { error } });

    return failedRun;
  }

  /**
   * Update a step's state and derive new workflow status.
   * Atomically updates both in-memory and database state.
   */
  private async updateStepState(
    run: WorkflowRun<TContext>,
    stepId: string,
    updates: Partial<StepState>
  ): Promise<WorkflowRun<TContext>> {
    // Convert Mongoose document to plain object if needed
    run = toPlainRun(run);

    const { index: stepIndex } = this.findStepOrThrow(run, stepId);

    // Derive new workflow status
    const newStatus = deriveRunStatus({ ...run, steps: applyStepUpdates(stepId, run.steps, updates) });

    // Build MongoDB update operators
    const updateOps = buildStepUpdateOps(stepIndex, updates, { includeStatus: newStatus });

    // Apply updates to in-memory state
    run.steps = applyStepUpdates(stepId, run.steps, updates);
    run.updatedAt = new Date();
    run.status = newStatus;

    // Execute atomic update via repository (rejects if workflow was cancelled)
    const result = await this.repository.updateOne(
      { _id: run._id, ...CANCELLED_GUARD },
      updateOps,
      { bypassTenant: true }
    );

    // If update was rejected and workflow is cancelled, invalidate cache and throw error
    if (result.modifiedCount === 0) {
      this.cache.delete(run._id); // Force re-fetch on next access
      const current = await this.repository.getById(run._id);
      if (current?.status === 'cancelled') {
        throw new InvalidStateError(
          'update step',
          'cancelled',
          ['running', 'waiting', 'draft'],
          { runId: run._id, stepId }
        );
      }
    }

    return run;
  }

  /**
   * Move workflow to the next step or mark as complete.
   * If no more steps, marks workflow as done and sets final output.
   */
  private async moveToNextStep(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>> {
    const nextStep = this.registry.getNextStep(run.currentStepId!);

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (nextStep) {
      run.currentStepId = nextStep.id;
      run.status = 'running';
      updates.currentStepId = nextStep.id;
      updates.status = 'running';
    } else {
      // Workflow completed - set final output from last step
      const lastStep = run.steps.find((s) => s.stepId === run.currentStepId);
      run.output = lastStep?.output;

      run.currentStepId = null;
      run.status = 'done';
      run.endedAt = new Date();

      updates.output = run.output;
      updates.currentStepId = null;
      updates.status = 'done';
      updates.endedAt = run.endedAt;

      this.eventBus.emit('workflow:completed', { runId: run._id, data: run.output });
    }

    run.updatedAt = updates.updatedAt as Date;

    // Atomic update via repository (rejects if workflow was cancelled)
    const result = await this.repository.updateOne(
      { _id: run._id, ...CANCELLED_GUARD },
      updates,
      { bypassTenant: true }
    );

    // If update was rejected and workflow is cancelled, invalidate cache and throw error
    if (result.modifiedCount === 0) {
      this.cache.delete(run._id); // Force re-fetch on next access
      const current = await this.repository.getById(run._id);
      if (current?.status === 'cancelled') {
        throw new InvalidStateError(
          'move to next step',
          'cancelled',
          ['running', 'waiting'],
          { runId: run._id }
        );
      }
    }

    return run;
  }

  /**
   * Resume a waiting step with payload.
   * Marks the step as done and continues to next step.
   * 
   * @param run - Workflow run to resume
   * @param payload - Data to pass as step output
   * @returns Updated workflow run
   * @throws {InvalidStateError} If step is not in waiting state
   */
  async resumeStep(run: WorkflowRun<TContext>, payload: unknown): Promise<WorkflowRun<TContext>> {
    const stepId = run.currentStepId!;
    const { step: stepState } = this.findStepOrThrow(run, stepId);

    if (stepState.status !== 'waiting') {
      const { InvalidStateError } = await import('../utils/errors.js');
      throw new InvalidStateError('resume step', stepState.status, ['waiting'], { runId: run._id, stepId });
    }

    // Mark step as done with the payload as output, then move to next step
    let updatedRun = await this.updateStepState(run, stepId, {
      status: 'done',
      endedAt: new Date(),
      output: payload,
      waitingFor: undefined,
    });

    this.eventBus.emit('workflow:resumed', { runId: run._id, stepId, data: payload });

    // Move to next step
    updatedRun = await this.moveToNextStep(updatedRun);

    return updatedRun;
  }
}
