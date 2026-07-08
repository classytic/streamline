import { LIMITS } from '../config/constants.js';
import type { SignalStore } from '../core/container.js';
import type { WorkflowEventBus } from '../core/events.js';
import type {
  BranchPlan,
  JoinPolicy,
  StepContext,
  StepLogEntry,
  StepOutputVersion,
  StepProgress,
  WorkflowRun,
} from '../core/types.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import { NonRetriableError } from '../utils/errors.js';
import { approxByteSize, guardPayloadSize } from '../utils/helpers.js';
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

/**
 * Per-scatter-task guard/record hooks (v2.7), passed from the executor into the
 * step context so `ctx.scatter()` can apply the same `taskMiddleware` chain to
 * each sub-task that the executor applies to the whole step.
 */
export interface TaskHooks {
  workflowId: string;
  tenantId?: string | undefined;
  /** Returns a rejection reason (or `undefined` to allow) for one task. */
  before: (taskKey: string) => Promise<{ rejected: boolean; reason?: string }>;
  /** Records one task's outcome (result/error + durationMs). */
  after: (
    taskKey: string,
    outcome: { result?: unknown; error?: unknown; durationMs: number },
  ) => Promise<void>;
}

export class StepContextImpl<TContext = Record<string, unknown>, TOutputs = Record<string, unknown>>
  implements StepContext<TContext, TOutputs>
{
  public signal: AbortSignal;
  /** Buffered log entries — flushed to DB once after step completes */
  private readonly logBuffer: StepLogEntry[] = [];
  /**
   * Name of the checkpoint-slot owner currently in flight (`'scatter'` |
   * `'loop'`), or `null`. The step's `output.__checkpoint` slot is single-use;
   * this flag makes nesting a hard runtime error instead of silent corruption.
   */
  private slotInUse: 'scatter' | 'loop' | null = null;

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
    /**
     * Opt-in HARD cap (bytes) for a single step output / checkpoint payload.
     * Threaded from `WorkflowEngineOptions.maxPayloadBytes`. Absent ⇒
     * warn-only at {@link LIMITS.PAYLOAD_WARN_BYTES}.
     */
    private maxPayloadBytes?: number,
    /**
     * Optional per-scatter-task guard/record hooks (v2.7). Supplied by the
     * executor only when `taskMiddleware` is configured, so the default scatter
     * path is unchanged. `before` returns a rejection reason (or undefined to
     * allow); `after` records the task outcome. `workflowId` / `tenantId` are
     * stamped once and reused for every task's `TaskHookContext`.
     */
    private taskHooks?: TaskHooks,
  ) {
    this.signal = signal ?? new AbortController().signal;
  }

  /**
   * Typed, lazy view of step outputs — each property access resolves through
   * `getOutput`, so it always reflects the loaded run's current state.
   */
  get outputs(): Partial<TOutputs> {
    return new Proxy({} as Partial<TOutputs>, {
      get: (_target, prop) => (typeof prop === 'string' ? this.getOutput(prop) : undefined),
      has: (_target, prop) =>
        typeof prop === 'string' && this.run.steps.some((s) => s.stepId === prop),
      ownKeys: () => this.run.steps.map((s) => s.stepId),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
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

  /** Per-step-execution frame counter for ctx.stream (resets on retry). */
  private streamSeq = 0;

  stream(frame: unknown): void {
    // Fire-and-forget by contract — no persistence, no abort error. A frame
    // emitted after cancellation is simply dropped.
    if (this.signal.aborted) return;
    const payload = {
      runId: this.runId,
      stepId: this.stepId,
      attempt: this.attempt,
      seq: this.streamSeq++,
      frame,
      timestamp: new Date(),
    };
    this.eventBus.emit('step:stream', payload);
    this.signalStore?.publish(`streamline:stream:${this.runId}`, payload);
  }

  // ── Queryable progress (v2.7) — throttled, latest-wins persistence. ──
  /** Latest reported snapshot not yet known to be persisted (coalesced). */
  private pendingProgress: StepProgress | undefined;
  /** The snapshot most recently written to the DB (dedup — skip re-writes). */
  private lastFlushedProgress: StepProgress | undefined;
  /** Wall-clock of the last durable progress write (throttle gate). */
  private lastProgressWriteAt = 0;
  /** Deferred-flush timer armed when a call arrives inside the throttle window. */
  private progressTimer: NodeJS.Timeout | undefined;

  reportProgress(progress: Omit<StepProgress, 'at'> & { at?: Date }): void {
    // Advisory, never load-bearing — dropped after cancellation.
    if (this.signal.aborted) return;

    // Bound the serialized snapshot (~1KB): truncate `message` if needed so a
    // verbose status line can't grow the inline `lastProgress` subdoc.
    const snapshot: StepProgress = { ...progress, at: progress.at ?? new Date() };
    if (snapshot.message !== undefined && approxByteSize(snapshot) !== undefined) {
      let size = approxByteSize(snapshot) ?? 0;
      if (size > LIMITS.PROGRESS_MAX_BYTES) {
        // Trim the message down until the whole snapshot fits (or it's empty).
        const overshoot = size - LIMITS.PROGRESS_MAX_BYTES;
        const msg = snapshot.message;
        snapshot.message =
          msg.length > overshoot ? `${msg.slice(0, Math.max(0, msg.length - overshoot - 1))}…` : '';
        size = approxByteSize(snapshot) ?? 0;
        // Last resort: drop the message entirely if still over.
        if (size > LIMITS.PROGRESS_MAX_BYTES) snapshot.message = undefined;
      }
    }

    this.pendingProgress = snapshot;

    const now = Date.now();
    const elapsed = now - this.lastProgressWriteAt;
    if (elapsed >= LIMITS.PROGRESS_PERSIST_THROTTLE_MS) {
      // Outside the throttle window — persist immediately (fire-and-forget).
      void this.writeProgress();
    } else if (!this.progressTimer) {
      // Inside the window — arm a single deferred flush for the tail value.
      const delay = LIMITS.PROGRESS_PERSIST_THROTTLE_MS - elapsed;
      this.progressTimer = setTimeout(() => {
        this.progressTimer = undefined;
        void this.writeProgress();
      }, delay);
      // Don't keep the process alive purely for a progress flush.
      this.progressTimer.unref?.();
    }
    // else: a deferred flush is already armed; the coalesced `pendingProgress`
    // (latest-wins) will be written when it fires.
  }

  /** Persist the pending progress snapshot (latest-wins). Fire-and-forget. */
  private async writeProgress(): Promise<void> {
    const snapshot = this.pendingProgress;
    if (snapshot === undefined) return;
    if (snapshot === this.lastFlushedProgress) return; // nothing new
    this.lastProgressWriteAt = Date.now();
    this.lastFlushedProgress = snapshot;

    const stepIndex = this.run.steps.findIndex((s) => s.stepId === this.stepId);
    if (stepIndex === -1) return;

    try {
      await this.repository.updateOne(
        { _id: this.runId, status: { $ne: 'cancelled' } },
        { $set: { [`steps.${stepIndex}.lastProgress`]: snapshot } },
        { bypassTenant: true },
      );
      // Mirror in-memory so getRunProgress off the cached run is consistent.
      const step = this.run.steps[stepIndex];
      if (step) step.lastProgress = snapshot;
    } catch {
      // Progress is advisory — swallow persistence errors (stdout unaffected).
    }
  }

  /**
   * Flush the final progress snapshot regardless of the throttle window and
   * clear any armed timer. Called by the executor after the step settles so the
   * last reported value always lands even if it arrived inside the window.
   */
  async flushProgress(): Promise<void> {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    await this.writeProgress();
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
    if (this.slotInUse) {
      throw new Error(
        `ctx.scatter() cannot be nested inside ctx.${this.slotInUse}() — each owns ` +
          `the step's single checkpoint slot (nesting corrupts recovery). Run the ` +
          `inner work as its own step, or flatten into a single scatter.`,
      );
    }
    this.slotInUse = 'scatter';
    try {
      return await this.runScatter(tasks, options);
    } finally {
      this.slotInUse = null;
    }
  }

  private async runScatter<T extends Record<string, () => Promise<unknown>>>(
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
        const taskStartedAt = Date.now();
        try {
          // Per-task guard (v2.7): a `taskMiddleware.before` rejection fails
          // ONLY this task with the reason; siblings proceed. Recorded as a
          // failure so scatter throws (and the step retries) like any task
          // failure — but the rejected task is not checkpointed done, so a
          // retry re-runs exactly it.
          if (this.taskHooks) {
            const guard = await this.taskHooks.before(id);
            if (guard.rejected) {
              throw new NonRetriableError(
                guard.reason ?? `Scatter task "${id}" rejected by task guard`,
              );
            }
          }
          const value = await taskFn();
          results[id] = value;
          // Only successful tasks checkpoint `{done:true}`; a failed task is
          // NOT recorded done, so crash recovery re-runs exactly the
          // incomplete/failed tasks (completed ones are restored above).
          checkpoint[id] = { done: true, value };
          // Persist after each SUCCESS — crash recovery resumes from here.
          // Use the raw writer (not the guarded public `checkpoint()`) — scatter
          // legitimately owns the slot it just claimed via `slotInUse`.
          await this.writeCheckpoint(checkpoint);
          if (this.taskHooks) {
            await this.taskHooks.after(id, {
              result: value,
              durationMs: Date.now() - taskStartedAt,
            });
          }
        } catch (err) {
          // Record the failure independently of the gating set so it is
          // observed even though this promise has already left `executing`.
          failures.push(err);
          if (this.taskHooks) {
            await this.taskHooks.after(id, { error: err, durationMs: Date.now() - taskStartedAt });
          }
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
    // A single step has ONE checkpoint slot (`output.__checkpoint`). `scatter()`
    // and `loop()` claim it for their durable recovery, so a user `checkpoint()`
    // call while one is in flight would clobber their progress and silently
    // re-run completed work. Fail loud instead of corrupting state.
    if (this.slotInUse) {
      throw new Error(
        `ctx.checkpoint() cannot run inside ctx.${this.slotInUse}() — it owns this ` +
          `step's single checkpoint slot (a nested write corrupts recovery). ` +
          `Checkpoint from the parent step, or move the work out of ${this.slotInUse}().`,
      );
    }
    await this.writeCheckpoint(value);
  }

  /**
   * The raw checkpoint DB write, WITHOUT the slot-ownership guard. Used by the
   * public `checkpoint()` (behind the guard) and internally by `scatter()` /
   * `loop()` (which legitimately own the slot). Keeping the guard off the writer
   * lets scatter persist per-task progress without tripping its own guard.
   */
  private async writeCheckpoint<T = unknown>(value: T): Promise<void> {
    if (this.signal.aborted) return;

    guardPayloadSize('checkpoint', value, {
      runId: this.runId,
      stepId: this.stepId,
      ...(this.maxPayloadBytes !== undefined && { maxPayloadBytes: this.maxPayloadBytes }),
    });

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

  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const step = this.run.steps.find((s) => s.stepId === this.stepId);
    const cache = (step?.dedupeCache ?? {}) as Record<string, unknown>;

    // Cache hit — return the memoized value WITHOUT re-running fn (crash/retry
    // idempotency). `hasOwn` so a legitimately-cached `undefined` still hits.
    if (step && Object.hasOwn(cache, key)) {
      return cache[key] as T;
    }

    const value = await fn();

    // Don't cache after cancellation (the run write would be rejected anyway).
    if (this.signal.aborted || !step) return value;

    // Budget guard: cache only if the step's total dedupe cache stays under
    // ~10KB. Over budget ⇒ don't cache (run every time), warn once.
    const candidate = { ...cache, [key]: value };
    const size = approxByteSize(candidate);
    if (size !== undefined && size > LIMITS.DEDUPE_MAX_BYTES) {
      logger.warn(
        '[streamline] ctx.dedupe cache over budget — value NOT cached (will re-run on retry)',
        {
          runId: this.runId,
          stepId: this.stepId,
          key,
          bytes: size,
          maxBytes: LIMITS.DEDUPE_MAX_BYTES,
        },
      );
      return value;
    }

    const stepIndex = this.run.steps.findIndex((s) => s.stepId === this.stepId);
    if (stepIndex === -1) return value;

    try {
      // Durable commit BEFORE returning — a crash after this point replays the
      // step and reads the cached value instead of re-running fn.
      await this.repository.updateOne(
        { _id: this.runId, status: { $ne: 'cancelled' } },
        {
          $set: {
            [`steps.${stepIndex}.dedupeCache.${key}`]: value,
            updatedAt: new Date(),
            lastHeartbeat: new Date(),
          },
        },
        { bypassTenant: true },
      );
      // Mirror in-memory so a second dedupe(key) in the same execution hits.
      step.dedupeCache = candidate;
    } catch {
      // If the durable write fails (e.g. run cancelled), still return the
      // computed value — dedupe degrades to "no memoization" on write failure.
    }

    return value;
  }

  async loop<S>(
    initial: S,
    body: (state: S, iteration: number) => Promise<{ state: S; done: boolean }>,
    options?: { maxIterations?: number },
  ): Promise<S> {
    const maxIterations = options?.maxIterations ?? 1000;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new NonRetriableError(`ctx.loop: maxIterations must be a positive integer.`);
    }
    if (this.slotInUse) {
      throw new Error(
        `ctx.loop() cannot be nested inside ctx.${this.slotInUse}() — each owns the ` +
          `step's single checkpoint slot (nesting corrupts recovery). Run the inner ` +
          `work as its own step.`,
      );
    }
    this.slotInUse = 'loop';
    try {
      return await this.runLoop(initial, body, maxIterations);
    } finally {
      this.slotInUse = null;
    }
  }

  private async runLoop<S>(
    initial: S,
    body: (state: S, iteration: number) => Promise<{ state: S; done: boolean }>,
    maxIterations: number,
  ): Promise<S> {
    // Crash recovery: resume from the last committed iteration. The loop owns
    // the step's checkpoint slot; a foreign checkpoint shape (no marker) means
    // first execution — start from `initial`.
    const saved = this.getCheckpoint<{ __loopIteration?: number; state?: S }>();
    let state = initial;
    let iteration = 0;
    if (
      saved &&
      typeof saved === 'object' &&
      typeof (saved as { __loopIteration?: unknown }).__loopIteration === 'number'
    ) {
      state = (saved as { state: S }).state;
      iteration = (saved as { __loopIteration: number }).__loopIteration;
    }

    while (true) {
      if (this.signal.aborted) {
        throw new Error(`ctx.loop aborted: workflow ${this.runId} was cancelled or timed out`);
      }
      if (iteration >= maxIterations) {
        throw new NonRetriableError(
          `ctx.loop in step "${this.stepId}" exceeded maxIterations (${maxIterations}) ` +
            `without body returning { done: true }. Raise maxIterations or fix the ` +
            `termination condition.`,
        );
      }

      const result = await body(state, iteration);
      state = result.state;
      iteration += 1;

      // Durable commit of this iteration. writeCheckpoint() also bumps the run's
      // lastHeartbeat, so each iteration doubles as an automatic heartbeat —
      // a long loop never trips the stale detector. Raw writer: the loop owns
      // the slot it claimed via `slotInUse`.
      await this.writeCheckpoint({ __loopIteration: iteration, state });

      if (result.done) return state;
    }
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
