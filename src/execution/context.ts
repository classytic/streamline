import type { StepContext, WorkflowRun } from '../core/types.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import type { WorkflowEventBus } from '../core/events.js';
import type { SignalStore } from '../core/container.js';
import { logger } from '../utils/logger.js';

export class WaitSignal extends Error {
  constructor(
    public type: 'human' | 'webhook' | 'timer' | 'event' | 'childWorkflow',
    public reason: string,
    public data?: unknown
  ) {
    super(reason);
    this.name = 'WaitSignal';
  }
}

/**
 * Signal thrown by ctx.goto() to jump execution to a different step.
 * Caught by the engine to update currentStepId.
 */
export class GotoSignal extends Error {
  constructor(public targetStepId: string) {
    super(`goto:${targetStepId}`);
    this.name = 'GotoSignal';
  }
}

export class StepContextImpl<TContext = Record<string, unknown>> implements StepContext<TContext> {
  public signal: AbortSignal;

  constructor(
    public runId: string,
    public stepId: string,
    public context: TContext,
    public input: unknown,
    public attempt: number,
    private run: WorkflowRun<TContext>,
    private repository: WorkflowRunRepository,
    private eventBus: WorkflowEventBus,
    signal?: AbortSignal,
    private signalStore?: SignalStore
  ) {
    this.signal = signal ?? new AbortController().signal;
  }

  async set<K extends keyof TContext>(key: K, value: TContext[K]): Promise<void> {
    // Guard: Don't update context if workflow is cancelled or signal is aborted
    if (this.signal.aborted) {
      throw new Error(`Cannot update context: workflow ${this.runId} has been cancelled`);
    }

    this.context[key] = value;
    this.run.context[key] = value;

    // Use atomic update with cancellation guard to prevent overwriting cancelled workflows
    const result = await this.repository.updateOne(
      {
        _id: this.runId,
        status: { $ne: 'cancelled' }, // Only update if not cancelled
      },
      {
        $set: {
          [`context.${String(key)}`]: value,
          updatedAt: new Date(),
        },
      },
      { bypassTenant: true } // Internal operation - already scoped by runId
    );

    // If update failed (workflow was cancelled), throw error
    if (result.modifiedCount === 0) {
      throw new Error(`Cannot update context: workflow ${this.runId} may have been cancelled`);
    }
  }

  getOutput<T = unknown>(stepId: string): T | undefined {
    const step = this.run.steps.find((s) => s.stepId === stepId);
    return step?.output as T | undefined;
  }

  async wait(reason: string, data?: unknown): Promise<never> {
    throw new WaitSignal('human', reason, data);
  }

  async waitFor(eventName: string, reason?: string): Promise<unknown> {
    throw new WaitSignal('event', reason || `Waiting for ${eventName}`, { eventName });
  }

  async sleep(ms: number): Promise<void> {
    const resumeAt = new Date(Date.now() + ms);
    throw new WaitSignal('timer', `Sleep ${ms}ms`, { resumeAt });
  }

  async heartbeat(): Promise<void> {
    // Guard: Don't send heartbeat if workflow is cancelled
    if (this.signal.aborted) {
      return;
    }

    try {
      await this.repository.updateOne(
        {
          _id: this.runId,
          status: { $ne: 'cancelled' },
        },
        { lastHeartbeat: new Date() },
        { bypassTenant: true }
      );
    } catch {
      // Ignore heartbeat failures - step continues execution
    }
  }

  emit(eventName: string, data: unknown): void {
    const payload = { runId: this.runId, stepId: this.stepId, data };
    // Local event bus (same process)
    this.eventBus.emit(eventName as Parameters<typeof this.eventBus.emit>[0], payload);
    // Cross-process signal store (Redis/Kafka if configured)
    this.signalStore?.publish(`streamline:event:${eventName}`, payload);
  }

  log(message: string, data?: unknown): void {
    // Nest user data under 'data' key to prevent accidental override of reserved fields
    logger.info(message, {
      runId: this.runId,
      stepId: this.stepId,
      attempt: this.attempt,
      ...(data !== undefined && { data }),
    });
  }

  async startChildWorkflow(workflowId: string, input: unknown): Promise<never> {
    throw new WaitSignal('childWorkflow', `Waiting for child workflow: ${workflowId}`, {
      childWorkflowId: workflowId,
      childInput: input,
      parentRunId: this.runId,
      parentStepId: this.stepId,
    });
  }

  async goto(targetStepId: string): Promise<never> {
    throw new GotoSignal(targetStepId);
  }

  async scatter<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
    options?: { concurrency?: number }
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const taskIds = Object.keys(tasks);
    const concurrency = options?.concurrency ?? Infinity;

    // Recover already-completed tasks from checkpoint
    const checkpoint = this.getCheckpoint<Record<string, { done: boolean; value?: unknown; error?: string }>>() ?? {};
    const results: Record<string, unknown> = {};

    // Restore completed results
    for (const id of taskIds) {
      const saved = checkpoint[id];
      if (saved?.done) {
        results[id] = saved.value;
      }
    }

    // Find incomplete tasks
    const pending = taskIds.filter((id) => !checkpoint[id]?.done);

    if (pending.length === 0) {
      return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
    }

    // Execute pending tasks with concurrency limit
    const executing = new Set<Promise<void>>();

    for (const id of pending) {
      if (this.signal.aborted) break;

      const taskFn = tasks[id]!;
      let promise!: Promise<void>;
      promise = (async () => {
        try {
          const value = await taskFn();
          results[id] = value;
          checkpoint[id] = { done: true, value };
        } catch (err) {
          // Don't mark failed tasks as done — they should re-run on retry
          throw err;
        } finally {
          executing.delete(promise);
          // Persist after each task completes — crash recovery resumes from here
          await this.checkpoint(checkpoint);
        }
      })();

      executing.add(promise);

      if (executing.size >= concurrency) {
        // Wait for at least one to finish before starting next
        await Promise.race(executing).catch(() => {});
      }
    }

    // Wait for all remaining tasks
    const settled = await Promise.allSettled(executing);

    // Check for failures
    const failures = settled.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0] as PromiseRejectedResult;
      throw first.reason;
    }

    return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  }

  async checkpoint(value: unknown): Promise<void> {
    if (this.signal.aborted) return;

    const stepIndex = this.run.steps.findIndex((s) => s.stepId === this.stepId);
    if (stepIndex === -1) return;

    await this.repository.updateOne(
      { _id: this.runId, status: { $ne: 'cancelled' } },
      {
        $set: {
          [`steps.${stepIndex}.output`]: { __checkpoint: value },
          updatedAt: new Date(),
          lastHeartbeat: new Date(),
        },
      },
      { bypassTenant: true }
    );

    // Update in-memory state
    const step = this.run.steps[stepIndex];
    if (step) {
      step.output = { __checkpoint: value };
    }
  }

  getCheckpoint<T = unknown>(): T | undefined {
    const step = this.run.steps.find((s) => s.stepId === this.stepId);
    const output = step?.output as { __checkpoint?: T } | undefined;
    return output?.__checkpoint;
  }
}
