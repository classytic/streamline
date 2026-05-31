export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
/**
 * Workflow run lifecycle status.
 *
 * ⚠️ TYPE-LEVEL BREAKING CHANGE (semver-MINOR at runtime, breaking for
 * exhaustive consumers). v2.4 adds the durable-saga compensation phase:
 * `'compensating' | 'compensated' | 'compensation_failed'`. These are purely
 * ADDITIVE at runtime — no existing transition or terminal-state behavior
 * changes for workflows without compensation handlers, and the engine never
 * emits them unless a failed run has registered `onCompensate` handlers.
 *
 * BUT any downstream TypeScript consumer doing an exhaustive `switch (status)`
 * with a `never`-check default (common under `isolatedModules`/strict) will
 * stop compiling until it handles the three new literals. Document this in the
 * changelog as a type-level break. There is no runtime migration.
 */
export type RunStatus =
  | 'draft'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  // ── Durable saga / compensation phase (v2.4) ──
  /** Failed run is actively rolling back completed steps in reverse order. */
  | 'compensating'
  /** All compensations completed successfully (TERMINAL). */
  | 'compensated'
  /** A compensation handler exhausted retries / threw fatally (TERMINAL). */
  | 'compensation_failed';

/**
 * Per-step compensation memoization record (durable saga, v2.4).
 *
 * NEW field on `StepState` — never overlaps the `output` slot (invariant #9).
 * Default-absent on runs that never enter compensation (no migration, no
 * schema growth for non-saga workflows).
 *
 * `status` is the idempotency CAS target: the engine flips `pending → done`
 * via a numeric-index guarded `updateOne` (NOT mongokit `claim()`, which can't
 * forward arrayFilters) ONLY after the handler resolves. A re-entered recovery
 * skips any step already `done`, so a step compensates effectively-once within
 * the same cluster.
 */
export interface StepCompensationState {
  status: 'pending' | 'done' | 'failed' | 'skipped';
  attempts: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: StepError;
}

export interface Step {
  id: string;
  name: string;
  description?: string;
  /**
   * Maximum number of execution attempts for this step (including the initial attempt).
   *
   * Example: retries=3 means:
   * - Attempt 1 (initial execution)
   * - Attempt 2 (first retry after failure)
   * - Attempt 3 (second retry after failure)
   * - Total: 3 attempts
   *
   * If all attempts fail, the step is marked as 'failed' and the workflow stops.
   * Uses exponential backoff: 1s, 2s, 4s, 8s, ... (max 60s between retries).
   *
   * @default 3
   */
  retries?: number;
  /**
   * Maximum execution time in milliseconds for this step.
   * If the step handler doesn't complete within this time, it throws a timeout error.
   *
   * @default undefined (no timeout)
   */
  timeout?: number;

  /**
   * Base delay in milliseconds before the first retry.
   * Used as the starting point for exponential backoff.
   *
   * @default 1000 (1 second)
   *
   * @example
   * ```typescript
   * step({ id: 'call-api', retries: 3, retryDelay: 5000 }) // 5s, 10s, 20s
   * ```
   */
  retryDelay?: number;

  /**
   * Backoff strategy for retries.
   * - 'exponential': delay doubles each attempt (default)
   * - 'linear': delay stays constant
   * - 'fixed': alias for 'linear'
   * - number: custom multiplier (e.g., 3 for tripling)
   *
   * @default 'exponential'
   */
  retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;

  // ============ Conditional Execution ============

  /**
   * Full condition function with access to context and run.
   * Return true to execute the step, false to skip.
   *
   * @example
   * ```typescript
   * step({
   *   id: 'send-email',
   *   name: 'Send Email',
   *   condition: (context, run) => context.shouldSendEmail && run.status === 'running'
   * })
   * ```
   */
  condition?: (context: unknown, run: WorkflowRun) => boolean | Promise<boolean>;

  /**
   * Skip this step if the predicate returns true.
   * Simpler alternative to condition for basic skip logic.
   *
   * @example
   * ```typescript
   * step({ id: 'optional-step', name: 'Optional', skipIf: (ctx) => !ctx.featureEnabled })
   * ```
   */
  skipIf?: (context: unknown) => boolean | Promise<boolean>;

  /**
   * Only run this step if the predicate returns true.
   * Simpler alternative to condition for basic run logic.
   *
   * @example
   * ```typescript
   * step({ id: 'premium-feature', name: 'Premium', runIf: (ctx) => ctx.isPremiumUser })
   * ```
   */
  runIf?: (context: unknown) => boolean | Promise<boolean>;

  // ============ Versioned Output History (opt-in) ============

  /**
   * Opt-in per-step versioned output ring buffer.
   *
   * When `keep > 0`, the engine snapshots the step's PRIOR committed output
   * into `StepState.outputHistory` on the rerun/rewind transition (i.e. when
   * a step that was previously `done` re-succeeds). The buffer is bounded to
   * the most recent `keep` versions via a `$push` + `$slice:-keep` ring.
   *
   * `keep` of `0` or `undefined` ⇒ feature DISABLED ⇒ behavior is
   * byte-for-byte identical to v2.3.4: no `outputHistory` field is ever
   * written and the run-document schema does not grow.
   *
   * History stores raw outputs inline in the run document — bound the value
   * size (the 16MB BSON cap is `keep × output-size` per step). For large
   * blobs, store a handle/reference, not the payload.
   */
  outputHistory?: { keep: number };
}

/**
 * One archived generation of a step's output, captured on the rerun/rewind
 * transition. Stored inline in `StepState.outputHistory` as a bounded ring
 * buffer (see `Step.outputHistory.keep`).
 *
 * `version` is a monotonically-increasing per-step counter (the value of
 * `attempt`/generation at capture time is recorded in `attempt` for the
 * idempotency guard). The engine never interprets these for control flow —
 * they are pure provenance the host reads via `ctx.outputHistory()` and
 * selects from via `ctx.pinOutput()`.
 */
export interface StepOutputVersion<T = unknown> {
  /** Monotonic per-step version number (1-based). */
  version: number;
  /** The archived output value (the prior committed generation). */
  output: T;
  /** When this generation was archived. */
  at: Date;
  /**
   * The step `attempts` count of the generation being archived. Used as the
   * idempotency guard: the engine refuses to push a version whose `attempt`
   * matches the top-of-buffer entry, so the same generation can't double-push
   * (e.g. on a done-then-crash-before-moveToNextStep replay).
   */
  attempt?: number;
}

/**
 * A single log entry persisted on the workflow run document.
 * Captured via ctx.log() and visible via GET /api/workflows/:id/runs/:runId
 */
export interface StepLogEntry {
  /** Step that produced this log */
  stepId: string;
  /** Log message */
  message: string;
  /** Optional structured data */
  data?: unknown;
  /** Attempt number when log was captured */
  attempt: number;
  /** Timestamp of the log entry */
  timestamp: Date;
}

export interface StepError {
  message: string;
  code?: string;
  retriable?: boolean;
  stack?: string;
}

export interface WorkflowError {
  message: string;
  code?: string;
  stack?: string;
}

export interface WaitingFor {
  type: 'human' | 'webhook' | 'timer' | 'event' | 'childWorkflow';
  reason: string;
  resumeAt?: Date;
  eventName?: string;
  data?: unknown;
  /**
   * Reconciliation cadence gate for poll-recoverable waits (currently
   * `childWorkflow`; designed generically so later slices can extend it to
   * `gate` / `branchJoin`). The scheduler's child-waiting sweep only
   * revisits a run once `nextReconcileAt <= now`, so a step that is still
   * legitimately blocked isn't re-reconciled on every poll cycle. The
   * engine sets/bumps this each reconcile attempt.
   *
   * Optional + default-absent: a run that never enters a poll-recoverable
   * wait never carries this field. Event / human / webhook / timer waits
   * resume via their own hook/timer and never set it. Persists
   * automatically — the `StepState` schema stores `waitingFor` as Mixed.
   */
  nextReconcileAt?: Date;
}

export interface StepState<TOutput = unknown> {
  stepId: string;
  status: StepStatus;
  attempts: number;
  startedAt?: Date;
  completedAt?: Date;
  endedAt?: Date;
  /**
   * Actual execution duration in milliseconds (completedAt - startedAt).
   * Only set when step completes (done/failed/skipped).
   * Useful for performance monitoring and SLA tracking.
   */
  durationMs?: number;
  output?: TOutput;
  waitingFor?: WaitingFor;
  error?: StepError;
  retryAfter?: Date; // Exponential backoff - don't retry before this time
  /**
   * Bounded ring buffer of prior committed outputs, populated only when the
   * step opts in via `Step.outputHistory.keep > 0` AND the step is re-run
   * (a previously-`done` step re-succeeds). NEVER overlaps the live `output`
   * slot — invariant #9. Default-absent on legacy/disabled runs (no
   * migration). Oldest entries are evicted past `keep` (`$slice:-keep`).
   */
  outputHistory?: StepOutputVersion[];
  /**
   * Host-chosen index/version restored into the live `output` slot via
   * `ctx.pinOutput()` / `restoreStepOutput()`. Pure metadata — the engine
   * stores it but never acts on it for control flow. Default-absent.
   */
  pinnedVersion?: number;
  /**
   * Durable saga compensation memoization (v2.4). Written DB-first AFTER the
   * step's `onCompensate` handler resolves, flipped `pending → done` via a
   * numeric-index guarded CAS so a crash-resumed compensation phase skips
   * already-compensated steps (effectively-once within the cluster). NEVER
   * overlaps `output` (invariant #9). Default-absent on non-saga runs.
   */
  compensation?: StepCompensationState;
}

/**
 * Scheduling metadata for timezone-aware workflow execution
 */
export interface SchedulingInfo {
  /**
   * User's intended local time as ISO string (without timezone suffix)
   * Format: "YYYY-MM-DDTHH:mm:ss" (e.g., "2024-03-10T09:00:00")
   * This is the ORIGINAL string the user provided, preserved for accurate rescheduling
   */
  scheduledFor: string;
  /** IANA timezone name (e.g., "America/New_York", "Europe/London") */
  timezone: string;
  /** Human-readable local time with timezone abbreviation (e.g., "2024-03-10 09:00:00 EDT") */
  localTimeDisplay: string;
  /** UTC execution time - used by scheduler for actual execution */
  executionTime: Date;
  /** Whether this time falls during a DST transition */
  isDSTTransition: boolean;
  /** Human-readable note about DST adjustments (if any) */
  dstNote?: string;
  /** Optional recurrence pattern for repeating workflows */
  recurrence?: RecurrencePattern;
}

/**
 * Recurrence pattern for scheduled workflows
 */
export interface RecurrencePattern {
  /** How often to repeat (daily, weekly, monthly, custom cron) */
  pattern: 'daily' | 'weekly' | 'monthly' | 'custom';
  /** For weekly: which days (0=Sunday, 6=Saturday) */
  daysOfWeek?: number[];
  /** For monthly: which day of month (1-31) */
  dayOfMonth?: number;
  /** Custom cron expression (if pattern='custom') */
  cronExpression?: string;
  /** Stop repeating after this date */
  until?: Date;
  /** Or stop after N occurrences */
  count?: number;
  /** How many times has this recurred so far */
  occurrences?: number;
}

export interface WorkflowRun<TContext = Record<string, unknown>> {
  _id: string;
  workflowId: string;
  status: RunStatus;
  steps: StepState[];
  currentStepId: string | null;
  context: TContext;
  input: unknown;
  output?: unknown;
  error?: WorkflowError; // Set when workflow fails due to unrecoverable error
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  lastHeartbeat?: Date; // For detecting stale/stuck running workflows
  paused?: boolean; // User-initiated pause - scheduler skips paused workflows
  /** Timezone-aware scheduling metadata (optional - only for scheduled workflows) */
  scheduling?: SchedulingInfo;
  /**
   * Persisted step-level logs captured via ctx.log().
   * Each entry includes stepId, message, optional data, attempt, and timestamp.
   * Queryable via GET /api/workflows/:workflowId/runs/:runId
   */
  stepLogs?: StepLogEntry[];
  /**
   * Idempotency key for deduplication.
   * If set, only one non-terminal run can exist per key.
   * Starting a workflow with a duplicate key returns the existing run.
   */
  idempotencyKey?: string;
  /**
   * Execution priority (higher = picked up sooner by scheduler).
   * @default 0
   */
  priority?: number;
  /** Concurrency grouping key (set by engine when concurrency config is active) */
  concurrencyKey?: string;
  userId?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  /**
   * Snapshot of the workflow definition's `version` at the time the run
   * was created. Required for in-flight runs to resume on the version
   * they started under, even after the host has registered a newer
   * definition. Set by `WorkflowRegistry.createRun()`; never mutated.
   *
   * Optional in the type to keep historical runs (created before v2.3.3)
   * loadable — the engine falls back to the active registry when this
   * field is missing.
   */
  definitionVersion?: string;
  /**
   * Number of times the stale-recovery / sweeper paths have terminated
   * this run. Bounded by `RetentionOptions.maxStaleRecoveries`; the
   * sweeper marks the run permanently failed (`error.code === 'dead_lettered'`)
   * once the limit is reached so it stops cycling through the recovery
   * loop forever.
   *
   * Incremented by `engine.recoverStale()` and `repository.markStaleAsFailed()`.
   * Hosts inspecting this field can build their own dashboards for
   * "runs that have crashed N+ times" without re-deriving from logs.
   */
  recoveryAttempts?: number;
}

export interface WorkflowDefinition<TContext = Record<string, unknown>> {
  id: string;
  name: string;
  version: string;
  steps: Step[];
  createContext: (input: unknown) => TContext;
  /**
   * Default values for all steps in this workflow.
   * Individual steps can override these defaults.
   */
  defaults?: {
    /**
     * Maximum number of execution attempts for each step (including initial attempt).
     * @default 3
     */
    retries?: number;
    /**
     * Maximum execution time in milliseconds for each step.
     * @default undefined (no timeout)
     */
    timeout?: number;
    /**
     * Base delay in milliseconds before the first retry.
     * @default 1000 (1 second)
     */
    retryDelay?: number;
    /**
     * Backoff strategy for retries.
     * @default 'exponential'
     */
    retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
    /**
     * Workflow-wide default for the opt-in output-history ring buffer.
     * Per-step `Step.outputHistory` overrides this. `keep` 0/undefined ⇒
     * disabled (byte-for-byte v2.3.4 — no new writes, no schema growth).
     */
    outputHistory?: { keep: number };
  };
}

export interface StepContext<TContext = Record<string, unknown>> {
  runId: string;
  stepId: string;
  context: TContext;
  input: unknown;
  attempt: number;

  /**
   * AbortSignal for step cancellation.
   * Handlers should check this signal and abort long-running operations when triggered.
   * The signal is aborted when:
   * - Step timeout is exceeded
   * - Workflow is cancelled
   *
   * @example
   * ```typescript
   * async function fetchData(ctx) {
   *   const response = await fetch(url, { signal: ctx.signal });
   *   // ...
   * }
   * ```
   */
  signal: AbortSignal;

  set: <K extends keyof TContext>(key: K, value: TContext[K]) => Promise<void>;
  getOutput: <T = unknown>(stepId: string) => T | undefined;

  wait: (reason: string, data?: unknown) => Promise<never>;
  waitFor: (eventName: string, reason?: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;

  /**
   * Send a heartbeat to prevent the workflow from being marked as stale.
   * Use this in long-running steps (5+ minutes) to signal the step is still active.
   *
   * Heartbeats are automatically sent every 30 seconds during step execution,
   * but you can call this manually for extra control.
   *
   * @example
   * ```typescript
   * async function processLargeDataset(ctx) {
   *   for (const batch of batches) {
   *     await processBatch(batch);
   *     await ctx.heartbeat(); // Signal we're still alive
   *   }
   * }
   * ```
   */
  heartbeat: () => Promise<void>;

  emit: (eventName: string, data: unknown) => void;
  log: (message: string, data?: unknown) => void;

  /**
   * Save a typed checkpoint for crash-safe batch processing (durable loop).
   * On crash recovery, `getCheckpoint<T>()` returns the last saved value.
   *
   * @example
   * ```typescript
   * const last = ctx.getCheckpoint<number>() ?? -1;
   * for (let i = last + 1; i < items.length; i++) {
   *   await process(items[i]);
   *   await ctx.checkpoint(i);
   * }
   * ```
   */
  checkpoint: <T = unknown>(value: T) => Promise<void>;

  /**
   * Read the last checkpoint value saved by `checkpoint()`.
   * Returns `undefined` on first execution (no prior crash).
   *
   * Use the same type parameter as your `checkpoint()` call for type safety.
   */
  getCheckpoint: <T = unknown>() => T | undefined;

  /**
   * Start a child workflow and durably wait for it to complete.
   *
   * The parent step enters a waiting state. When the child reaches a terminal
   * state (done/failed/cancelled), the parent automatically resumes with the
   * child's output as this step's output.
   *
   * Durable: survives process restarts. The scheduler picks up the parent
   * when the child completes via the `childRunId` stored in waitingFor.
   *
   * @param workflowId - The child workflow's registered ID
   * @param input - Input data for the child workflow
   * @returns The child workflow's output (after it completes)
   *
   * @example
   * ```typescript
   * const pipeline = createWorkflow('pipeline', {
   *   steps: {
   *     validate: async (ctx) => { ... },
   *     runSubPipeline: async (ctx) => {
   *       return ctx.startChildWorkflow('sub-pipeline', { data: ctx.context.data });
   *       // Parent waits here. Resumes when child completes.
   *     },
   *     finalize: async (ctx) => {
   *       const childResult = ctx.getOutput('runSubPipeline');
   *       return { done: true, childResult };
   *     },
   *   },
   * });
   * ```
   */
  startChildWorkflow: (workflowId: string, input: unknown) => Promise<never>;

  /**
   * Jump to a different step, breaking out of the linear sequence.
   *
   * Use for conditional branching, error recovery paths, or skip-ahead logic.
   * The target step must exist in the workflow definition.
   *
   * @param stepId - The step ID to jump to
   *
   * @example
   * ```typescript
   * const workflow = createWorkflow('order', {
   *   steps: {
   *     validate: async (ctx) => {
   *       if (!ctx.context.paymentValid) {
   *         return ctx.goto('handleFailure'); // Skip to failure handler
   *       }
   *       return { valid: true };
   *     },
   *     process: async (ctx) => { ... },
   *     handleFailure: async (ctx) => { ... },
   *   },
   * });
   * ```
   */
  goto: (stepId: string) => Promise<never>;

  /**
   * Durable scatter/gather — execute tasks in parallel with crash recovery.
   *
   * Unlike `executeParallel()` (in-memory only), `scatter()` persists each
   * task's completion to MongoDB via checkpoints. If the process crashes
   * mid-scatter, only incomplete tasks re-execute on recovery.
   *
   * @param tasks - Named tasks to execute. Keys become result keys.
   * @param options - Concurrency limit (default: Infinity)
   * @returns Record of results keyed by task name
   *
   * @example
   * ```typescript
   * const results = await ctx.scatter({
   *   user: () => fetchUser(ctx.context.userId),
   *   orders: () => fetchOrders(ctx.context.userId),
   *   recommendations: () => getRecommendations(ctx.context.userId),
   * });
   *
   * // results.user, results.orders, results.recommendations
   * // If crash after 'user' completes, only 'orders' and 'recommendations' re-run.
   * ```
   */
  scatter: <T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
    options?: { concurrency?: number },
  ) => Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;

  /**
   * Read the versioned output history for a step (defaults to the current
   * step). Pure read — returns the in-memory `StepState.outputHistory` of the
   * loaded run, no I/O. Empty array when history is disabled or the step has
   * never been re-run.
   *
   * Ordered oldest→newest (the ring-buffer order); the last element is the
   * most recently archived generation.
   *
   * @example
   * ```typescript
   * const versions = ctx.outputHistory<MyOutput>('generate-shot');
   * const previous = versions.at(-1)?.output;
   * ```
   */
  outputHistory: <T = unknown>(stepId?: string) => StepOutputVersion<T>[];

  /**
   * Durably restore a historical output version back into the live `output`
   * slot of a step (defaults to the current step) and record `pinnedVersion`.
   *
   * A guarded compare-and-set copy-back: refused on a cancelled run. Pinning
   * the same version twice is idempotent (same resulting state).
   *
   * @param version - The `StepOutputVersion.version` to restore.
   * @param stepId - Target step (defaults to the current step).
   *
   * @example
   * ```typescript
   * const versions = ctx.outputHistory('generate-shot');
   * await ctx.pinOutput(versions[0].version, 'generate-shot'); // restore oldest
   * ```
   */
  pinOutput: (version: number, stepId?: string) => Promise<void>;

  /**
   * Deterministic, **attempt-invariant** idempotency key for effectively-once
   * external side effects (charge a card, send an email, POST to a vendor).
   *
   * Returns `` `${runId}:${stepId}` `` (optionally `` `:${scope}` `` for several
   * distinct effects in one step). The key is STABLE across retries and crash
   * recovery — it deliberately does NOT include `attempt`, because a retried
   * step must reuse the SAME key so the downstream provider dedupes the call
   * instead of charging twice. Pass it as the provider's idempotency key /
   * `Idempotency-Key` header.
   *
   * This is a pure primitive: the engine guarantees the key is stable; the
   * HOST composes effectively-once by handing the key to an idempotent API or
   * its own dedup store. The engine performs no external dedup itself.
   *
   * @param scope - Optional discriminator when one step makes multiple
   *   distinct side-effecting calls (e.g. `'charge'` vs `'refund'`).
   *
   * @example
   * ```typescript
   * await stripe.charges.create(
   *   { amount, currency, customer },
   *   { idempotencyKey: ctx.idempotencyKey('charge') },
   * );
   * ```
   */
  idempotencyKey: (scope?: string) => string;
}

export type StepHandler<TOutput = unknown, TContext = Record<string, unknown>> = (
  ctx: StepContext<TContext>,
) => Promise<TOutput>;

export type WorkflowHandlers<TContext = Record<string, unknown>> = {
  [stepId: string]: StepHandler<unknown, TContext>;
};

// ============ Type Inference Helpers ============

/**
 * Infer context type from WorkflowDefinition
 * @example
 * type MyContext = InferContext<typeof myWorkflow>
 */
export type InferContext<T> = T extends WorkflowDefinition<infer TContext> ? TContext : never;

/**
 * Infer context type from WorkflowHandlers
 * @example
 * type MyContext = InferHandlersContext<typeof myHandlers>
 */
export type InferHandlersContext<T> = T extends WorkflowHandlers<infer TContext> ? TContext : never;

/**
 * Strongly-typed handlers that match workflow steps
 * Ensures all step IDs have corresponding handlers
 * @example
 * const handlers: TypedHandlers<typeof workflow, MyContext> = { ... }
 */
export type TypedHandlers<
  TWorkflow extends WorkflowDefinition<any>,
  TContext = InferContext<TWorkflow>,
> = {
  [K in TWorkflow['steps'][number]['id']]: StepHandler<unknown, TContext>;
};

/**
 * Extract step IDs as union type from workflow definition
 * @example
 * type MyStepIds = StepIds<typeof myWorkflow> // 'step1' | 'step2' | 'step3'
 */
export type StepIds<T extends WorkflowDefinition<any>> = T['steps'][number]['id'];

/**
 * Payload for workflow and engine events
 */
export interface WorkflowEventPayload {
  runId?: string;
  stepId?: string;
  data?: unknown;
  error?: Error;
  context?: string;
  /**
   * Explicit broadcast flag for resuming multiple workflows.
   * When true, the event will resume ALL workflows waiting on this event.
   * When false/undefined with no runId, a warning is logged.
   */
  broadcast?: boolean;
}
