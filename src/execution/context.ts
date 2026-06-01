import { LIMITS } from '../config/constants.js';
import type { SignalStore } from '../core/container.js';
import type { WorkflowEventBus } from '../core/events.js';
import type {
  BranchPlan,
  JoinPolicy,
  StepContext,
  StepLogEntry,
  StepOutputVersion,
  WorkflowRun,
} from '../core/types.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import { logger } from '../utils/logger.js';

export class WaitSignal extends Error {
  constructor(
    public type: 'human' | 'webhook' | 'timer' | 'event' | 'childWorkflow' | 'branchJoin',
    public reason: string,
    public data?: unknown,
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
  /** Buffered log entries — flushed to DB once after step completes */
  private readonly logBuffer: StepLogEntry[] = [];

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
    private signalStore?: SignalStore,
    /**
     * Ring-buffer cap for persisted `stepLogs`. Threaded from
     * `WorkflowEngineOptions.maxStepLogs`; falls back to the default constant.
     */
    private maxStepLogs: number = LIMITS.MAX_STEP_LOGS,
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
      { bypassTenant: true }, // Internal operation - already scoped by runId
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
        { bypassTenant: true },
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
    // Stdout logging (immediate)
    logger.info(message, {
      runId: this.runId,
      stepId: this.stepId,
      attempt: this.attempt,
      ...(data !== undefined && { data }),
    });

    // Buffer log entry — flushed to DB once after step completes (avoids N+1 writes)
    this.logBuffer.push({
      stepId: this.stepId,
      message,
      attempt: this.attempt,
      timestamp: new Date(),
      ...(data !== undefined && { data }),
    });
  }

  /**
   * Flush buffered log entries to the run document in a single $push.
   * Called by the executor after step completion (success, failure, or wait).
   *
   * Bounded with `$slice: -maxStepLogs` so `stepLogs` is a ring buffer keeping
   * the most recent N entries. Without the slice a long-running / high-volume
   * workflow grows this inline array unbounded toward Mongo's 16MB doc limit.
   * `context`, step `output`, `checkpoint` and `outputHistory` are ALSO inline
   * on the run doc — the engine bounds logs (here) and output-history, but
   * cannot bound arbitrary user payloads; hosts storing large blobs should
   * persist a reference/handle, not the payload.
   */
  async flushLogs(): Promise<void> {
    if (this.logBuffer.length === 0) return;

    const entries = this.logBuffer.splice(0);
    try {
      await this.repository.updateOne(
        { _id: this.runId },
        { $push: { stepLogs: { $each: entries, $slice: -this.maxStepLogs } } },
        { bypassTenant: true },
      );
    } catch {
      // Silently drop if persistence fails — stdout log is the fallback
    }
  }

  async startChildWorkflow(workflowId: string, input: unknown): Promise<never> {
    throw new WaitSignal('childWorkflow', `Waiting for child workflow: ${workflowId}`, {
      childWorkflowId: workflowId,
      childInput: input,
      parentRunId: this.runId,
      parentStepId: this.stepId,
    });
  }

  async joinBranches<TJoin = unknown>(
    branches: Array<{ key?: string; workflowId: string; input: unknown }>,
    options?: { policy?: JoinPolicy; cancelLosers?: boolean },
  ): Promise<TJoin> {
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new Error('joinBranches requires at least one branch');
    }

    // Normalize branch keys: default to the array index. Keys must be unique
    // because they synthesize the deterministic child idempotency key and the
    // durable childRunId slot. Reject duplicates up front (fail-closed).
    const plan: BranchPlan[] = branches.map((b, i) => ({
      key: b.key ?? String(i),
      workflowId: b.workflowId,
      input: b.input,
    }));
    const seen = new Set<string>();
    for (const b of plan) {
      if (seen.has(b.key)) {
        throw new Error(`joinBranches: duplicate branch key "${b.key}"`);
      }
      seen.add(b.key);
    }

    // Like startChildWorkflow/goto: throw a WaitSignal. The engine's
    // branchJoin handler fans out the children and parks the parent durably;
    // on quorum the parent resumes with the JoinResult as this step's output.
    throw new WaitSignal('branchJoin', `Waiting for ${plan.length} parallel branches`, {
      branches: plan,
      policy: options?.policy ?? 'all',
      cancelLosers: options?.cancelLosers ?? true,
      parentRunId: this.runId,
      parentStepId: this.stepId,
    });
  }

  async goto(targetStepId: string): Promise<never> {
    throw new GotoSignal(targetStepId);
  }

  async scatter<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
    options?: { concurrency?: number },
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const taskIds = Object.keys(tasks);
    const concurrency = options?.concurrency ?? Infinity;

    // Recover already-completed tasks from checkpoint
    const checkpoint =
      this.getCheckpoint<Record<string, { done: boolean; value?: unknown; error?: string }>>() ??
      {};
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

    // Execute pending tasks with a concurrency limit.
    //
    // CORRECTNESS: the in-flight `executing` set is used ONLY to gate
    // concurrency (race one slot free before starting the next). It MUST NOT
    // be the source of truth for settled outcomes — each task removes itself
    // from the set in `finally`, so a task that fails (or finishes) early is
    // already gone by the time we await the tail. Awaiting only the residual
    // set would silently drop early failures and let scatter return partial
    // success. Instead we keep `allTasks` (every task's promise, never pruned)
    // and `failures` (settled rejections), and decide success/failure from
    // those — independent of what's still in the gating set.
    const executing = new Set<Promise<void>>();
    const allTasks: Promise<void>[] = [];
    const failures: unknown[] = [];

    for (const id of pending) {
      if (this.signal.aborted) break;

      const taskFn = tasks[id];
      if (!taskFn) continue;
      let promise!: Promise<void>;
      promise = (async () => {
        try {
          const value = await taskFn();
          results[id] = value;
          // Only successful tasks checkpoint `{done:true}`; a failed task is
          // NOT recorded done, so crash recovery re-runs exactly the
          // incomplete/failed tasks (completed ones are restored above).
          checkpoint[id] = { done: true, value };
          // Persist after each SUCCESS — crash recovery resumes from here.
          await this.checkpoint(checkpoint);
        } catch (err) {
          // Record the failure independently of the gating set so it is
          // observed even though this promise has already left `executing`.
          failures.push(err);
        } finally {
          executing.delete(promise);
        }
      })();

      executing.add(promise);
      allTasks.push(promise);

      if (executing.size >= concurrency) {
        // Wait for at least one to finish before starting the next. The task
        // body never rejects (it captures its own error), so no swallow here.
        await Promise.race(executing);
      }
    }

    // Wait for EVERY task to settle (not just the residual in-flight set).
    await Promise.all(allTasks);

    // Honor the documented "throws on failure" contract: if ANY task failed,
    // throw the first error so the step fails (and is retried) rather than
    // returning a partial-success result.
    if (failures.length > 0) {
      throw failures[0];
    }

    return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  }

  async checkpoint<T = unknown>(value: T): Promise<void> {
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
      { bypassTenant: true },
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

  outputHistory<T = unknown>(stepId?: string): StepOutputVersion<T>[] {
    const id = stepId ?? this.stepId;
    const step = this.run.steps.find((s) => s.stepId === id);
    return (step?.outputHistory ?? []) as StepOutputVersion<T>[];
  }

  async pinOutput(version: number, stepId?: string): Promise<void> {
    // Honor cancellation before any I/O (every ctx I/O checks abort).
    if (this.signal.aborted) {
      throw new Error(`Cannot pin output: workflow ${this.runId} has been cancelled`);
    }

    const id = stepId ?? this.stepId;
    const step = this.run.steps.find((s) => s.stepId === id);
    if (!step) {
      throw new Error(`Cannot pin output: step "${id}" not found in run ${this.runId}`);
    }

    const entry = (step.outputHistory ?? []).find((v) => v.version === version);
    if (!entry) {
      throw new Error(
        `Cannot pin output: version ${version} not found in history of step "${id}" ` +
          `(run ${this.runId}).`,
      );
    }

    // Durable, cancelled-guarded copy-back into the live output slot.
    const result = await this.repository.restoreStepOutput(this.runId, id, version);
    if (result.modifiedCount === 0) {
      throw new Error(
        `Cannot pin output: run ${this.runId} is cancelled or version ${version} no longer ` +
          `exists for step "${id}".`,
      );
    }

    // Mirror the durable write in-memory so a subsequent ctx.getOutput sees it.
    step.output = entry.output;
    step.pinnedVersion = version;
  }

  idempotencyKey(scope?: string): string {
    // Attempt-invariant by design: the key MUST be identical across retries
    // and crash recovery so the downstream provider dedupes a re-issued call
    // instead of performing the side effect twice. Never fold in `attempt`.
    const base = `${this.runId}:${this.stepId}`;
    return scope ? `${base}:${scope}` : base;
  }
}
