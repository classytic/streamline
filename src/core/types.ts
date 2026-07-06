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
  condition?: ((context: unknown, run: WorkflowRun) => boolean | Promise<boolean>) | undefined;

  /**
   * Skip this step if the predicate returns true.
   * Simpler alternative to condition for basic skip logic.
   *
   * @example
   * ```typescript
   * step({ id: 'optional-step', name: 'Optional', skipIf: (ctx) => !ctx.featureEnabled })
   * ```
   */
  skipIf?: ((context: unknown) => boolean | Promise<boolean>) | undefined;

  /**
   * Only run this step if the predicate returns true.
   * Simpler alternative to condition for basic run logic.
   *
   * @example
   * ```typescript
   * step({ id: 'premium-feature', name: 'Premium', runIf: (ctx) => ctx.isPremiumUser })
   * ```
   */
  runIf?: ((context: unknown) => boolean | Promise<boolean>) | undefined;

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
  // `| undefined` (exactOptionalPropertyTypes): builders pass through
  // possibly-absent `error.code` / `error.stack` values verbatim.
  code?: string | undefined;
  retriable?: boolean | undefined;
  stack?: string | undefined;
}

/**
 * Queryable, bounded step-progress snapshot (v2.7).
 *
 * Unlike `ctx.stream()` frames (non-durable, at-most-once, never persisted),
 * `StepProgress` is the LATEST-WINS durable state a step reports via
 * `ctx.reportProgress(p)`. It answers "what is this step doing RIGHT NOW?" for
 * a UI page-refresh or a new client that has no stream history — read back via
 * `engine.getStepProgress(runId, stepId)` / `engine.getRunProgress(runId)`.
 *
 * Every field is optional except `at`. Persistence is THROTTLED (at most one DB
 * write per second per step, latest-wins-coalesced, always flushed on step
 * completion) so a renderer emitting frames rapidly can't hammer Mongo. The
 * serialized size is bounded (~1KB) — `message` is truncated if the snapshot
 * would exceed the cap. All fields are host-defined semantics; the engine never
 * interprets them for control flow.
 */
export interface StepProgress {
  /** Coarse phase label (e.g. 'downloading', 'rendering'). Host-defined. */
  phase?: string | undefined;
  /** 0–100 completion percentage. Host-defined; not clamped by the engine. */
  percent?: number | undefined;
  /** Short human-readable status line. Truncated if the snapshot exceeds ~1KB. */
  message?: string | undefined;
  /** Host estimate of remaining time in seconds. */
  estimatedSecondsRemaining?: number | undefined;
  /** When this snapshot was reported (the only required field). */
  at: Date;
}

export interface WorkflowError {
  message: string;
  code?: string;
  stack?: string;
}

/**
 * One branch of a declarative parallel fan-out (`ctx.joinBranches`).
 *
 * A branch SELECTS a pre-registered child workflow by `workflowId` and maps
 * its `input` — it ships NO executable logic (the named-handler-registry rule).
 * `key` is a stable per-branch discriminator used to (a) order results, (b)
 * synthesize the deterministic child idempotency key
 * (`${parentRunId}:${parentStepId}:${key}`) so a crash between
 * `childEngine.start()` and the `childRunId` $set cannot double-spawn, and (c)
 * persist the started `childRunId` back into the parent's `waitingFor.data`.
 */
export interface BranchPlan {
  key: string;
  workflowId: string;
  input: unknown;
  /** Stamped once the child is started — the durable de-dupe / re-read anchor. */
  childRunId?: string;
}

/** Completion policy for a branch group. Frozen 4-value enum (pure status math). */
export type JoinPolicy = 'all' | 'any' | 'race' | 'allSettled';

/** Per-branch outcome inside a resolved {@link JoinResult}. */
export interface JoinBranchResult {
  key: string;
  workflowId: string;
  childRunId?: string;
  status: 'done' | 'failed' | 'cancelled';
  output?: unknown;
  // `| undefined` (exactOptionalPropertyTypes): the join reconstructor maps
  // a possibly-absent child `error` field through verbatim.
  error?: StepError | undefined;
}

/**
 * The resolved value of `ctx.joinBranches` — reconstructed durably from the
 * child runs, NOT held in memory. Becomes the joining step's `output`.
 *
 * `satisfied` is pure status math over the policy:
 *   - `all`        → every branch `done`
 *   - `any`        → at least one branch `done`
 *   - `race`       → at least one branch terminal (first to finish wins)
 *   - `allSettled` → always satisfied once every branch is terminal
 */
export interface JoinResult {
  policy: JoinPolicy;
  satisfied: boolean;
  branches: JoinBranchResult[];
}

export interface WaitingFor {
  type: 'human' | 'webhook' | 'timer' | 'event' | 'childWorkflow' | 'branchJoin';
  reason: string;
  // Optional fields carry `| undefined` (exactOptionalPropertyTypes): the
  // executor builds WaitingFor literals from possibly-absent signal fields
  // and mongoose's $set drops explicit-undefined keys, so "explicitly
  // undefined" and "absent" are the same persisted state here.
  resumeAt?: Date | undefined;
  /**
   * Deadline for a `human` / `webhook` wait. When set and reached, the
   * scheduler's expiry sweep resumes the step with a timeout sentinel
   * (`{ __waitResolved: 'timeout' }`, see `getWaitResolution`) instead of
   * leaving it parked forever — so an unanswered approval can't wedge a
   * long-running workflow. Distinct from `resumeAt` (which is the *normal*
   * wake time for a `timer`/sleep wait); a human wait that also wants a
   * scheduled nudge would use its own hook. Promoted from
   * `ctx.wait(reason, { expiresAt })` data by the executor. Default-absent:
   * a wait without it parks indefinitely (the prior behaviour).
   */
  expiresAt?: Date | undefined;
  eventName?: string | undefined;
  data?: unknown;
  /**
   * Reconciliation cadence gate for poll-recoverable waits (`childWorkflow`
   * and `branchJoin`; designed generically so later slices can extend it to
   * `gate`). The scheduler's child-waiting / branch-join sweeps only
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
  // Lifecycle fields carry `| undefined` (exactOptionalPropertyTypes): the
  // executor's retry/rewind paths deliberately CLEAR them by assigning
  // `undefined` in `Partial<StepState>` patches (mongoose drops
  // explicit-undefined keys on $set, i.e. field reset), so `undefined` is
  // a legitimate write value, not just "absent".
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  endedAt?: Date | undefined;
  /**
   * Actual execution duration in milliseconds (completedAt - startedAt).
   * Only set when step completes (done/failed/skipped).
   * Useful for performance monitoring and SLA tracking.
   */
  durationMs?: number | undefined;
  output?: TOutput;
  waitingFor?: WaitingFor | undefined;
  error?: StepError | undefined;
  retryAfter?: Date | undefined; // Exponential backoff - don't retry before this time
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
  /**
   * Latest queryable progress snapshot for this step (v2.7). Written via
   * `ctx.reportProgress()` with THROTTLED, latest-wins persistence (≤1 DB
   * write/second/step + a final flush on completion). Read back via
   * `engine.getStepProgress` / `engine.getRunProgress`. Bounded (~1KB). NEVER
   * overlaps `output` (invariant #9). Default-absent on steps that never
   * report progress (no schema growth, no migration).
   */
  lastProgress?: StepProgress | undefined;
  /**
   * Durable per-step memoization cache for `ctx.dedupe()` (v2.7). Maps a
   * host-chosen key to the resolved value, committed to the run doc so a retry
   * / crash-replay returns the cached value WITHOUT re-running the producer.
   * Bounded (~10KB serialized per step); an over-budget value is not cached.
   * NEVER overlaps `output` (invariant #9). Default-absent on steps that never
   * call `ctx.dedupe`.
   */
  dedupeCache?: Record<string, unknown> | undefined;
  /**
   * Host-recorded per-step cost (v2.7) — an arbitrary numeric weight (tokens,
   * dollars, credits). Populated ONLY when a host writes it, typically from a
   * `taskMiddleware.after` hook. `engine.getRunMetrics` sums it across steps.
   * The engine never interprets it. Default-absent (no schema growth).
   */
  cost?: number | undefined;
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
  dstNote?: string | undefined;
  /** Optional recurrence pattern for repeating workflows */
  recurrence?: RecurrencePattern | undefined;
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
  // `| undefined` (exactOptionalPropertyTypes): rewind/goto paths CLEAR
  // completion fields by assigning `undefined` (mongoose drops
  // explicit-undefined keys on $set — a field reset, not a value).
  error?: WorkflowError | undefined; // Set when workflow fails due to unrecoverable error
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | undefined;
  endedAt?: Date | undefined;
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
  userId?: string | undefined;
  tags?: string[] | undefined;
  meta?: Record<string, unknown> | undefined;
  /**
   * Operator-supplied cancellation reason (v2.7). Persisted by
   * `engine.cancel(runId, { reason })` and echoed in the `workflow:cancelled`
   * event payload. Optional + default-absent — `cancel(runId)` with no reason
   * leaves it unset (byte-for-byte the pre-2.7 shape). Never overwritten on a
   * terminal-run cancel no-op.
   */
  cancellationReason?: string | undefined;
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
  defaults?:
    | {
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
      }
    | undefined;
}

/**
 * Read-only facts about the step a middleware hook is observing.
 */
export interface StepMiddlewareInfo<TContext = Record<string, unknown>> {
  runId: string;
  workflowId: string;
  stepId: string;
  /** Attempt counter at hook time (1-based once the step is claimed). */
  attempt: number;
  context: TContext;
}

/**
 * Cross-cutting observation seam around step execution (v2.6).
 *
 * Middleware is **observability-only**: hooks are awaited sequentially in
 * registration order, but a hook that throws is logged and SWALLOWED — it
 * cannot veto, retry, or mutate a step. This keeps the seam free of new
 * control-flow failure modes; use it for metrics, tracing, token metering,
 * structured logging, PII redaction sinks.
 *
 * Hook timing:
 *   - `beforeStep`  — after the atomic claim, before the handler runs.
 *   - `afterStep`   — after the success state is durably written
 *                     (output + durationMs available).
 *   - `onStepError` — handler threw a non-wait error (before retry
 *                     scheduling / failure handling).
 *   - `onWait`      — handler suspended (`ctx.wait` / `sleep` / `waitFor` /
 *                     child / branch join).
 *
 * @example Token metering
 * ```typescript
 * const tokenMeter: StepMiddleware = {
 *   name: 'token-meter',
 *   afterStep: async ({ runId, stepId, output }) => {
 *     const usage = (output as { usage?: { totalTokens?: number } })?.usage;
 *     if (usage?.totalTokens) await meter.record(runId, stepId, usage.totalTokens);
 *   },
 * };
 * createWorkflow('agent', { steps: { ... }, middleware: [tokenMeter] });
 * ```
 */
export interface StepMiddleware<TContext = Record<string, unknown>> {
  /** Identifier used in the swallowed-error log line. */
  name?: string;
  beforeStep?: (info: StepMiddlewareInfo<TContext>) => void | Promise<void>;
  afterStep?: (
    info: StepMiddlewareInfo<TContext> & { output: unknown; durationMs?: number | undefined },
  ) => void | Promise<void>;
  onStepError?: (info: StepMiddlewareInfo<TContext> & { error: Error }) => void | Promise<void>;
  onWait?: (
    info: StepMiddlewareInfo<TContext> & { waitType: string; reason: string },
  ) => void | Promise<void>;
}

/**
 * Read-only facts a {@link TaskMiddleware} hook observes (v2.7).
 *
 * Fires around each STEP and each SCATTER TASK. `taskKey` is set only for a
 * scatter sub-task (the task's key/index); it is absent for a plain step.
 */
export interface TaskHookContext {
  runId: string;
  stepId: string;
  workflowId: string;
  /** Set for a scatter sub-task (its key); absent for a whole-step invocation. */
  taskKey?: string | undefined;
  /** Attempt counter at hook time (1-based once the step is claimed). */
  attempt: number;
  tenantId?: string | undefined;
}

/**
 * Result of a {@link TaskMiddleware} `before` guard.
 *
 * `{ allow: false, reason }` rejects the step/task with a NON-RETRIABLE error
 * carrying `reason` — the step fails without retry, or the single scatter task
 * is rejected while its siblings proceed.
 */
export type TaskGuardResult = { allow: true } | { allow: false; reason?: string | undefined };

/**
 * General per-step / per-scatter-task guard + recording middleware (v2.7).
 *
 * A GENERALIZED seam — the engine bakes in NO policy (no budget, no cost model).
 * Hosts compose recipes on top: e.g. a spend budget = read the running total in
 * `before` and reject when over; record `actualCost` in `after`. See the
 * `taskMiddleware` config field and the CHANGELOG "budget recipe".
 *
 * Timing:
 *   - `before` — before each step handler AND before each scatter task. Return
 *     `{ allow: false, reason }` to reject that unit non-retriably. Absent /
 *     `{ allow: true }` ⇒ proceed. Multiple middlewares run in order; the FIRST
 *     `allow: false` short-circuits.
 *   - `after`  — after each step/task settles, with `result` (on success) or
 *     `error` (on failure) plus `durationMs`. The recording hook (write cost
 *     here). Errors thrown by `after` are logged and swallowed.
 */
export interface TaskMiddleware {
  before?: (ctx: TaskHookContext) => Promise<TaskGuardResult> | TaskGuardResult;
  after?: (
    ctx: TaskHookContext & {
      result?: unknown;
      error?: unknown;
      durationMs: number;
    },
  ) => Promise<void> | void;
}

/**
 * Aggregated run-level metrics (v2.7), returned by `engine.getRunMetrics`.
 * Pure aggregation over the run doc's `StepState` — no new storage beyond the
 * optional per-step `cost` field. Queryable for both terminal and in-flight
 * runs.
 */
export interface RunMetrics {
  runId: string;
  status: RunStatus;
  steps: Array<{
    stepId: string;
    durationMs?: number | undefined;
    attempts: number;
    cost?: number | undefined;
  }>;
  /** Sum of per-step `durationMs` (missing durations count as 0). */
  totalDurationMs: number;
  /** Sum of per-step `cost` when ANY step has a cost; otherwise `undefined`. */
  totalCost?: number | undefined;
}

/**
 * Queryable run-progress snapshot (v2.7), returned by `engine.getRunProgress`.
 * A plain read off the run doc: the run status plus every step's status and
 * latest {@link StepProgress}.
 */
export interface RunProgress {
  status: RunStatus;
  steps: Array<{
    stepId: string;
    status: StepStatus;
    lastProgress?: StepProgress | undefined;
  }>;
}

export interface StepContext<
  TContext = Record<string, unknown>,
  TOutputs = Record<string, unknown>,
> {
  runId: string;
  stepId: string;
  context: TContext;
  input: unknown;
  attempt: number;

  /**
   * Typed, read-only view of completed step outputs.
   *
   * Each property is the output of the step with that ID, or `undefined` if
   * the step hasn't completed yet (hence `Partial`). With a declared
   * `TOutputs` interface on `createWorkflow<TContext, TInput, TOutputs>`,
   * property access is fully typed and a typo on a step name is a compile
   * error — no more manual `getOutput<T>('...')` casting:
   *
   * ```typescript
   * interface Outputs {
   *   fetch: { html: string };
   *   parse: { items: number };
   * }
   * createWorkflow<Ctx, Input, Outputs>('scrape', {
   *   steps: {
   *     fetch: async (ctx) => ({ html: await get(ctx.context.url) }),
   *     parse: async (ctx) => ({ items: count(ctx.outputs.fetch?.html) }),
   *   },
   * });
   * ```
   *
   * Without a declared `TOutputs`, properties are `unknown` (same data as
   * `getOutput`, which remains available for dynamic step IDs).
   */
  outputs: Partial<TOutputs>;

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
   * Emit a NON-durable streaming frame (v2.6) — live progress for UIs:
   * LLM tokens, percent-complete, intermediate previews.
   *
   * Contract (deliberately weaker than everything else in streamline):
   *   - **at-most-once** — frames are fire-and-forget on the event bus
   *     (`step:stream`) + cross-process signal store; nothing is persisted.
   *   - **side-effect-free on run state** — a crash loses unflushed frames,
   *     a retry restarts `seq` at 0, and replays re-emit.
   *   - **never load-bearing** — data a later step needs goes in the step
   *     output or `ctx.checkpoint()`, not a stream frame.
   *
   * Consumers subscribe to `'step:stream'` on the container bus (arc's SSE
   * endpoint delivers these to browsers) or `'streamline:step.stream'` on
   * an arc-shape transport.
   *
   * @example
   * ```typescript
   * for await (const token of llm.stream(prompt)) {
   *   ctx.stream({ token });
   * }
   * ```
   */
  stream: (frame: unknown) => void;

  /**
   * Report the step's LATEST queryable progress (v2.7) — durable, latest-wins.
   *
   * Unlike `ctx.stream()` (non-durable frames for a live subscriber),
   * `reportProgress` persists a bounded {@link StepProgress} snapshot onto the
   * run doc's `StepState.lastProgress`, so a UI page-refresh or a brand-new
   * client can read "what is this step doing now?" WITHOUT replaying stream
   * history — via `engine.getStepProgress` / `engine.getRunProgress`.
   *
   * Persistence is THROTTLED to protect Mongo: at most one write per second per
   * step, coalescing rapid calls to the latest value in memory. The final value
   * is ALWAYS flushed when the step completes, so the last snapshot never gets
   * lost to the throttle window. `message` is truncated if the snapshot would
   * exceed ~1KB serialized.
   *
   * Fire-and-forget: a persistence failure is swallowed (progress is advisory,
   * never load-bearing). `at` is stamped for you if omitted.
   *
   * @example
   * ```typescript
   * for (let i = 0; i < total; i++) {
   *   await process(items[i]);
   *   ctx.reportProgress({ phase: 'processing', percent: (i / total) * 100 });
   * }
   * ```
   */
  reportProgress: (progress: Omit<StepProgress, 'at'> & { at?: Date }) => void;

  /**
   * Durable per-step memoization (v2.7) — the "run this side effect at most
   * once, even across retries and crash-replay" primitive.
   *
   * Memoizes `fn`'s resolved value into the run doc keyed by `key` WITHIN this
   * step. On the first call the fn runs and its result is committed durably; a
   * later call (a retry, or a crash-recovery replay) with the SAME key returns
   * the cached value WITHOUT re-running `fn`. Crash-safe: the cache write
   * commits to the run document before the value is returned.
   *
   * The cache is bounded (~10KB total per step). If adding a value would exceed
   * the budget, it is NOT cached — `fn` runs and a warning is logged (so a
   * large value degrades to "run every time" rather than blowing the doc).
   *
   * This is the mechanism `ctx.scatter()` uses internally to short-circuit
   * already-completed tasks on retry, but it is a general primitive: use it to
   * make any expensive/side-effecting sub-operation crash-idempotent without a
   * host-side dedup store.
   *
   * @param key - Stable per-step cache key. Same key ⇒ same cached value.
   * @param fn  - Producer; run at most once per key across the step's lifetime.
   *
   * @example
   * ```typescript
   * const user = await ctx.dedupe('fetch-user', () => api.getUser(id));
   * // On retry, api.getUser is NOT called again — the cached user is returned.
   * ```
   */
  dedupe: <T>(key: string, fn: () => Promise<T>) => Promise<T>;

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
   * Durable loop — the agent-loop primitive.
   *
   * Runs `body(state, iteration)` until it returns `{ done: true }`, durably
   * checkpointing the state after EVERY iteration (each checkpoint write also
   * bumps the run's heartbeat, so a long loop never trips the stale
   * detector). On crash/restart the loop resumes from the last committed
   * iteration — completed iterations never re-run; the interrupted iteration
   * re-runs from its start (at-least-once per iteration, so pass
   * `ctx.idempotencyKey(`iter:${i}`)` to external side effects).
   *
   * `maxIterations` (default 1000) is a hard cap: exceeding it fails the step
   * with a NON-retriable error — a runaway agent can't spin forever.
   *
   * Owns the step's checkpoint slot — don't mix with `ctx.checkpoint()` /
   * `ctx.scatter()` in the same step (same constraint scatter has).
   *
   * @example LLM agent loop
   * ```typescript
   * const final = await ctx.loop(
   *   { messages: [seed], done: false },
   *   async (state, i) => {
   *     const reply = await llm.chat(state.messages, {
   *       idempotencyKey: ctx.idempotencyKey(`iter:${i}`),
   *     });
   *     return {
   *       state: { ...state, messages: [...state.messages, reply] },
   *       done: reply.stopReason === 'end_turn',
   *     };
   *   },
   *   { maxIterations: 50 },
   * );
   * ```
   */
  loop: <S>(
    initial: S,
    body: (state: S, iteration: number) => Promise<{ state: S; done: boolean }>,
    options?: { maxIterations?: number },
  ) => Promise<S>;

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
   * Declarative parallel STEPS + durable join — fan out to N pre-registered
   * child workflows, run them concurrently and crash-durably, then JOIN them
   * with a completion policy before this step proceeds.
   *
   * Unlike `scatter()` (in-process, same-worker, single-step tasks), each
   * branch is a real child workflow run = a document parked at zero compute,
   * with its own retry/timeout/compensation/output-history. The parent step
   * enters a `branchJoin` wait that survives process restarts: on crash the
   * scheduler's branch-join sweep re-reads each child's persisted status,
   * re-starts only branches that never got a `childRunId`, and resolves the
   * join when the policy quorum is met. Completed branches are never re-run.
   *
   * Resolves (on resume) to a {@link JoinResult}, which becomes this step's
   * output — read it from a later step via `ctx.getOutput(thisStepId)`.
   *
   * Partial-failure policy:
   *   - `all` (default): one branch failure ⇒ this step fails ⇒ the run goes
   *     `failed` ⇒ existing saga compensation rolls back completed branches.
   *   - `any` / `race`: first success (any) / first terminal (race) resolves;
   *     still-running losers are cancelled when `cancelLosers` (default true).
   *   - `allSettled`: every outcome is collected; a branch failure NEVER fails
   *     the step.
   *
   * @example
   * ```typescript
   * const wf = createWorkflow('render', {
   *   steps: {
   *     fanout: async (ctx) =>
   *       ctx.joinBranches(
   *         [
   *           { key: 'a', workflowId: 'render-shot', input: { shot: 1 } },
   *           { key: 'b', workflowId: 'render-shot', input: { shot: 2 } },
   *         ],
   *         { policy: 'all' },
   *       ),
   *     compose: async (ctx) => {
   *       const join = ctx.getOutput<JoinResult>('fanout');
   *       return join?.branches.map((b) => b.output);
   *     },
   *   },
   * });
   * ```
   */
  joinBranches: <TJoin = JoinResult>(
    branches: Array<{ key?: string; workflowId: string; input: unknown }>,
    options?: { policy?: JoinPolicy; cancelLosers?: boolean },
  ) => Promise<TJoin>;

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

export type StepHandler<
  TOutput = unknown,
  TContext = Record<string, unknown>,
  TOutputs = Record<string, unknown>,
> = (ctx: StepContext<TContext, TOutputs>) => Promise<TOutput>;

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
