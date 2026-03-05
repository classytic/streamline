import type { StepContext, WorkflowRun } from '../core/types.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import type { WorkflowEventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';

export class WaitSignal extends Error {
  constructor(
    public type: 'human' | 'webhook' | 'timer' | 'event',
    public reason: string,
    public data?: unknown
  ) {
    super(reason);
    this.name = 'WaitSignal';
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
    signal?: AbortSignal
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
    // Use type assertion for custom event names
    this.eventBus.emit(eventName as Parameters<typeof this.eventBus.emit>[0], { runId: this.runId, stepId: this.stepId, data });
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
}
