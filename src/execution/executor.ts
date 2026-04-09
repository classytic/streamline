import { RETRY, TIMING } from '../config/constants.js';
import type { WorkflowEventBus } from '../core/events.js';
import { deriveRunStatus } from '../core/status.js';
import type { StepHandler, StepState, WorkflowRun } from '../core/types.js';
import { isConditionalStep, shouldSkipStep } from '../features/conditional.js';
import type { WorkflowCache } from '../storage/cache.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import {
  InvalidStateError,
  StepNotFoundError,
  toError,
  WorkflowNotFoundError,
} from '../utils/errors.js';
import { calculateRetryDelay, resolveBackoffMultiplier } from '../utils/helpers.js';
import type { WorkflowRegistry } from '../workflow/registry.js';
import { GotoSignal, StepContextImpl, WaitSignal } from './context.js';
import { applyStepUpdates, buildStepUpdateOps, toPlainRun } from './step-updater.js';

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
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly registry: WorkflowRegistry<TContext>,
    private readonly repository: WorkflowRunRepository,
    private readonly eventBus: WorkflowEventBus,
    private readonly cache: WorkflowCache,
    private readonly signalStore?: import('../core/container.js').SignalStore,
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

  /** Abort all in-flight step executions. Called by engine.shutdown(). */
  abortAll(): void {
    for (const [runId, controller] of this.activeControllers) {
      controller.abort(new Error('Engine shutdown'));
      this.activeControllers.delete(runId);
    }
  }

  // ============ Helper Methods ============

  /**
   * Find a step by ID in a workflow run, throwing if not found
   */
  private findStepOrThrow(
    run: WorkflowRun<TContext>,
    stepId: string,
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
    step: import('../core/types.js').Step,
  ): Promise<WorkflowRun<TContext> | null> {
    if (!isConditionalStep(step)) {
      return null;
    }

    const skip = await shouldSkipStep(step, run.context, run);
    if (!skip) {
      return null;
    }

    const skippedAt = new Date();
    run = await this.updateStepState(run, stepId, {
      status: 'skipped',
      completedAt: skippedAt,
      endedAt: skippedAt,
      durationMs: 0,
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
    currentStepState: StepState,
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
        { bypassTenant: true },
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
    currentStepState: StepState,
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
    const stepId = run.currentStepId;
    if (!stepId) {
      throw new InvalidStateError('execute step', run.status, ['running'], { runId: run._id });
    }

    const step = this.registry.getStep(stepId);
    const handler = this.registry.getHandler(stepId);

    if (!step || !handler) {
      const availableSteps = this.registry.definition.steps.map((s) => s.id);
      throw new StepNotFoundError(stepId, run.workflowId, availableSteps);
    }

    // 1. Check conditional skip
    const skippedRun = await this.checkConditionalSkip(run, stepId, step);
    if (skippedRun) return skippedRun;

    // 2. Check retry backoff
    const { step: currentStepState } = this.findStepOrThrow(run, stepId);
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
    currentStepState: StepState,
  ): Promise<WorkflowRun<TContext> | null> {
    const stepIndex = run.steps.findIndex((s) => s.stepId === stepId);
    if (stepIndex === -1) {
      const availableSteps = this.registry.definition.steps.map((s) => s.id);
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
      { bypassTenant: true },
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
    handler: StepHandler<unknown, TContext>,
  ): Promise<WorkflowRun<TContext>> {
    const abortController = new AbortController();

    // Register controller for cancellation support
    this.activeControllers.set(run._id, abortController);

    const { step: stepState } = this.findStepOrThrow(run, stepId);
    const ctx = new StepContextImpl(
      run._id,
      stepId,
      run.context,
      run.input,
      stepState.attempts,
      run,
      this.repository,
      this.eventBus,
      abortController.signal,
      this.signalStore,
    );

    try {
      const output = await this.executeWithTimeout(
        handler,
        ctx,
        step.timeout || this.registry.definition.defaults?.timeout,
        run._id,
        abortController,
      );

      // Success - update step with timing metrics
      const completedAt = new Date();
      const stepStartedAt = run.steps.find((s) => s.stepId === stepId)?.startedAt;
      const durationMs = stepStartedAt
        ? completedAt.getTime() - new Date(stepStartedAt).getTime()
        : undefined;
      run = await this.updateStepState(run, stepId, {
        status: 'done',
        completedAt,
        endedAt: completedAt,
        durationMs,
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
      } else if (error instanceof GotoSignal) {
        try {
          return await this.handleGoto(run, stepId, error.targetStepId);
        } catch (gotoError) {
          // Goto to invalid target → treat as step failure
          return await this.handleFailure(run, stepId, gotoError as Error);
        }
      } else if (error instanceof InvalidStateError) {
        // Workflow was cancelled - don't treat as retriable failure, just rethrow
        throw error;
      } else {
        return await this.handleFailure(run, stepId, error as Error);
      }
    } finally {
      // Flush buffered logs to DB in a single write (avoids N+1)
      ctx.flushLogs().catch(() => {});
      // Unregister controller when step completes (success, failure, or wait)
      this.activeControllers.delete(run._id);
    }
  }

  private async executeWithTimeout<T>(
    handler: StepHandler<T, TContext>,
    ctx: StepContextImpl<TContext>,
    timeout?: number,
    runId?: string,
    abortController?: AbortController,
  ): Promise<T> {
    // Start periodic heartbeat to prevent long-running steps from being marked stale
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (runId) {
      let consecutiveHeartbeatFailures = 0;
      heartbeatTimer = setInterval(async () => {
        try {
          await this.repository.updateOne(
            { _id: runId },
            { lastHeartbeat: new Date() },
            { bypassTenant: true }, // Internal operation - already scoped by _id
          );
          consecutiveHeartbeatFailures = 0;
        } catch (error) {
          consecutiveHeartbeatFailures++;
          // Emit warning so operators can monitor heartbeat health.
          // After 3 consecutive failures, the stale detector may mark this
          // workflow as crashed — emit a louder signal.
          this.eventBus.emit('engine:error', {
            runId,
            error: toError(error),
            context: consecutiveHeartbeatFailures >= 3 ? 'heartbeat-critical' : 'heartbeat-warning',
          });
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
    signal: WaitSignal,
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
    error: Error,
  ): Promise<WorkflowRun<TContext>> {
    const step = this.registry.getStep(stepId);
    const { step: stepState } = this.findStepOrThrow(run, stepId);
    const maxRetries = step?.retries ?? this.registry.definition.defaults?.retries ?? 3;

    // Check if error has retriable flag set to false (user explicitly disabled retries)
    // Guard against null/non-object thrown values
    const errorWithRetriable =
      error != null && typeof error === 'object'
        ? (error as Error & { retriable?: boolean })
        : null;
    const isRetriable = errorWithRetriable?.retriable !== false;

    // Check if we can retry (attempts is already incremented in executeStep)
    if (isRetriable && stepState.attempts < maxRetries) {
      // Resolve per-step retry config (step > workflow defaults > system defaults)
      const defaults = this.registry.definition.defaults;
      const baseDelay = step?.retryDelay ?? defaults?.retryDelay ?? TIMING.RETRY_BASE_DELAY_MS;
      const backoffConfig = step?.retryBackoff ?? defaults?.retryBackoff;
      const multiplier = resolveBackoffMultiplier(backoffConfig, TIMING.RETRY_MULTIPLIER);

      // Calculate backoff with jitter to prevent thundering herd
      const delayMs = calculateRetryDelay(
        baseDelay,
        stepState.attempts - 1,
        multiplier,
        TIMING.MAX_RETRY_DELAY_MS,
        RETRY.JITTER_FACTOR,
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
        { bypassTenant: true },
      );

      // Only update in-memory and emit events if DB accepted the update
      if (retryResult.modifiedCount > 0) {
        run.status = 'waiting';
        run.steps[stepIndex].status = 'pending';
        run.steps[stepIndex].retryAfter = retryAfter;
        run.steps[stepIndex].error = {
          message: error.message,
          retriable: true,
          stack: error.stack,
        };
        run.steps[stepIndex] = { ...run.steps[stepIndex], waitingFor: undefined };

        this.eventBus.emit('step:retry-scheduled', {
          runId: run._id,
          stepId,
          attempt: stepState.attempts,
          maxRetries,
          retryAfter,
        });
      } else {
        // DB rejected update (workflow cancelled) - invalidate cache for consistency
        this.cache.delete(run._id);
      }

      return run;
    }

    const safeError = toError(error);
    const failedAt = new Date();
    const failStartedAt = stepState.startedAt;
    const failDurationMs = failStartedAt
      ? failedAt.getTime() - new Date(failStartedAt).getTime()
      : undefined;
    const failedRun = await this.updateStepState(run, stepId, {
      status: 'failed',
      completedAt: failedAt,
      endedAt: failedAt,
      durationMs: failDurationMs,
      error: {
        message: safeError.message,
        code: (safeError as Error & { code?: string }).code,
        retriable: false,
        stack: safeError.stack,
      },
    });

    this.eventBus.emit('step:failed', { runId: run._id, stepId, error: safeError });
    this.eventBus.emit('workflow:failed', { runId: run._id, error: safeError });

    return failedRun;
  }

  /**
   * Update a step's state and derive new workflow status.
   * Atomically updates both in-memory and database state.
   */
  private async updateStepState(
    run: WorkflowRun<TContext>,
    stepId: string,
    updates: Partial<StepState>,
  ): Promise<WorkflowRun<TContext>> {
    // Convert Mongoose document to plain object if needed
    run = toPlainRun(run);

    const { index: stepIndex } = this.findStepOrThrow(run, stepId);

    // Apply updates to in-memory state (once — reused for status derivation)
    const updatedSteps = applyStepUpdates(stepId, run.steps, updates);
    const newStatus = deriveRunStatus({ ...run, steps: updatedSteps });
    const updateOps = buildStepUpdateOps(stepIndex, updates, { includeStatus: newStatus });

    run.steps = updatedSteps;
    run.updatedAt = new Date();
    run.status = newStatus;

    // Execute atomic update via repository (rejects if workflow was cancelled)
    const result = await this.repository.updateOne(
      { _id: run._id, ...CANCELLED_GUARD },
      updateOps,
      { bypassTenant: true },
    );

    // If update was rejected and workflow is cancelled, invalidate cache and throw error
    if (result.modifiedCount === 0) {
      this.cache.delete(run._id); // Force re-fetch on next access
      const current = await this.repository.getById(run._id);
      if (current?.status === 'cancelled') {
        throw new InvalidStateError('update step', 'cancelled', ['running', 'waiting', 'draft'], {
          runId: run._id,
          stepId,
        });
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
    const result = await this.repository.updateOne({ _id: run._id, ...CANCELLED_GUARD }, updates, {
      bypassTenant: true,
    });

    // If update was rejected and workflow is cancelled, invalidate cache and throw error
    if (result.modifiedCount === 0) {
      this.cache.delete(run._id); // Force re-fetch on next access
      const current = await this.repository.getById(run._id);
      if (current?.status === 'cancelled') {
        throw new InvalidStateError('move to next step', 'cancelled', ['running', 'waiting'], {
          runId: run._id,
        });
      }
    }

    return run;
  }

  /**
   * Handle a goto signal — jump execution to a target step.
   * Marks the current step as done and sets currentStepId to the target.
   */
  private async handleGoto(
    run: WorkflowRun<TContext>,
    fromStepId: string,
    targetStepId: string,
  ): Promise<WorkflowRun<TContext>> {
    // Validate target step exists
    const targetStep = this.registry.getStep(targetStepId);
    if (!targetStep) {
      const availableSteps = this.registry.definition.steps.map((s) => s.id);
      throw new StepNotFoundError(targetStepId, run.workflowId, availableSteps);
    }

    // Mark current step as skipped (goto exits the step without completing it normally)
    run = await this.updateStepState(run, fromStepId, {
      status: 'skipped',
      endedAt: new Date(),
    });

    this.eventBus.emit('step:completed', {
      runId: run._id,
      stepId: fromStepId,
      data: { goto: targetStepId },
    });

    // Jump to target step and reset it to pending so executor can re-claim it.
    const now = new Date();
    const targetIndex = this.registry.definition.steps.findIndex((s) => s.id === targetStepId);
    const updates: Record<string, unknown> = {
      currentStepId: targetStepId,
      status: 'running',
      updatedAt: now,
    };

    // Reset the target step to pending so it can be executed
    if (targetIndex !== -1) {
      updates[`steps.${targetIndex}.status`] = 'pending';
      updates[`steps.${targetIndex}.attempts`] = 0;
      const step = run.steps[targetIndex];
      if (step) {
        step.status = 'pending';
        step.attempts = 0;
        step.output = undefined;
        step.error = undefined;
        step.startedAt = undefined;
        step.endedAt = undefined;
        step.waitingFor = undefined;
        step.retryAfter = undefined;
      }
    }

    await this.repository.updateOne(
      { _id: run._id, status: { $ne: 'cancelled' } },
      { $set: updates },
      { bypassTenant: true },
    );

    run.currentStepId = targetStepId;
    run.status = 'running';
    run.updatedAt = now;

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
    const stepId = run.currentStepId;
    if (!stepId) {
      throw new InvalidStateError('resume step', run.status, ['waiting'], { runId: run._id });
    }
    const { step: stepState } = this.findStepOrThrow(run, stepId);

    if (stepState.status !== 'waiting') {
      throw new InvalidStateError('resume step', stepState.status, ['waiting'], {
        runId: run._id,
        stepId,
      });
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
