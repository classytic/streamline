/**
 * Simplified Workflow Definition API
 *
 * Inspired by Vercel's workflow - cleaner, function-based syntax.
 * No compiler needed - just cleaner ergonomics.
 *
 * @example
 * ```typescript
 * import { createWorkflow } from '@classytic/streamline';
 *
 * const userSignup = createWorkflow('user-signup', {
 *   steps: {
 *     createUser: async (ctx) => {
 *       return { id: crypto.randomUUID(), email: ctx.input.email };
 *     },
 *     sendWelcome: async (ctx) => {
 *       const user = ctx.getOutput('createUser');
 *       await sendEmail(user.email, 'Welcome!');
 *     },
 *     onboard: async (ctx) => {
 *       await ctx.sleep(5000);
 *       await sendOnboardingEmail(ctx.getOutput('createUser'));
 *     },
 *   },
 *   context: (input) => ({ email: input.email }),
 * });
 *
 * // Start workflow
 * const run = await userSignup.start({ email: 'test@example.com' });
 * ```
 */

import { createContainer, type StreamlineContainer } from '../core/container.js';
import type { WorkflowFailedPayload } from '../core/events.js';
import { isTerminalState } from '../core/status.js';
import type {
  Step,
  StepContext,
  StepHandler,
  StepMiddleware,
  WorkflowDefinition,
  WorkflowRun,
} from '../core/types.js';
import { WorkflowEngine } from '../execution/engine.js';
import type { SmartSchedulerConfig } from '../execution/smart-scheduler.js';
import { makeCounterId } from '../storage/concurrency-counter.model.js';
import { ConcurrencyLimitReachedError, WorkflowNotFoundError } from '../utils/errors.js';
import { validateId, validateRetryConfig } from '../utils/validation.js';

// camelCase/kebab-case -> Title Case
const toName = (id: string) =>
  id
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());

// ============================================================================
// Step Configuration
// ============================================================================

/**
 * Per-step configuration for overriding timeout, retries, and conditions.
 *
 * `TContext` flows from `WorkflowConfig` — no manual annotation needed.
 *
 * @example
 * ```typescript
 * const workflow = createWorkflow('pipeline', {
 *   steps: {
 *     clone: {
 *       handler: async (ctx) => { ... },
 *       timeout: 120_000,
 *       retries: 5,
 *     },
 *     review: {
 *       handler: async (ctx) => { ... },
 *       timeout: 300_000,
 *       skipIf: (ctx) => ctx.autoApproved, // ctx is your TContext
 *     },
 *   },
 * });
 * ```
 */
export interface StepConfig<
  TOutput = unknown,
  TContext = Record<string, unknown>,
  TOutputs = Record<string, unknown>,
> {
  handler: StepHandler<TOutput, TContext, TOutputs>;
  timeout?: number;
  retries?: number;
  /**
   * Base delay in milliseconds before the first retry.
   * @default 1000 (1 second)
   */
  retryDelay?: number;
  /**
   * Backoff strategy for retries.
   * - 'exponential': delay doubles each attempt (default)
   * - 'linear' | 'fixed': delay stays constant
   * - number: custom multiplier
   * @default 'exponential'
   */
  retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
  condition?: (context: TContext, run: WorkflowRun) => boolean | Promise<boolean>;
  skipIf?: (context: TContext) => boolean | Promise<boolean>;
  runIf?: (context: TContext) => boolean | Promise<boolean>;

  /**
   * Compensation handler (saga pattern rollback).
   *
   * Called in reverse order when a later step fails permanently.
   * Only runs for steps that completed successfully (status: 'done').
   *
   * @example
   * ```typescript
   * charge: {
   *   handler: async (ctx) => stripe.charges.create({ amount: 100 }),
   *   onCompensate: async (ctx) => {
   *     const chargeId = ctx.getOutput<{ id: string }>('charge')?.id;
   *     await stripe.refunds.create({ charge: chargeId });
   *   },
   * },
   * ```
   */
  onCompensate?: StepHandler<unknown, TContext, TOutputs>;

  /**
   * Max compensation attempts for this step's `onCompensate` handler when it
   * throws (durable saga, v2.4). Includes the initial attempt. If all attempts
   * fail, the run terminates `compensation_failed`.
   *
   * @default 3
   */
  compensateRetries?: number;
  /** Base delay (ms) before the first compensation retry. @default 1000 */
  compensateRetryDelay?: number;
  /**
   * Compensation retry backoff strategy. @default 'exponential'
   */
  compensateRetryBackoff?: 'exponential' | 'linear' | 'fixed' | number;

  /**
   * Opt-in per-step versioned output history (ring buffer).
   *
   * `keep > 0` archives the step's prior committed output into
   * `StepState.outputHistory` when the step is re-run (rewind/goto/rerun and
   * the step re-succeeds), bounded to the most recent `keep` versions.
   * `0`/`undefined` ⇒ disabled ⇒ byte-for-byte v2.3.4 (no new writes).
   *
   * Read with `ctx.outputHistory()`, restore with `ctx.pinOutput()`.
   *
   * @example
   * ```typescript
   * generateShot: {
   *   handler: async (ctx) => renderShot(ctx.input),
   *   outputHistory: { keep: 5 }, // keep the last 5 generations
   * }
   * ```
   */
  outputHistory?: { keep: number };
}

/**
 * Best-effort define-time guard: a compensation handler MUST NOT suspend.
 *
 * The durable compensation phase walks completed steps synchronously and
 * checkpoints each per-step compensation; a `ctx.wait` / `ctx.waitFor` /
 * `ctx.sleep` / `ctx.startChildWorkflow` inside an `onCompensate` handler would
 * throw a `WaitSignal` that has NO resume site in the compensation loop —
 * wedging a half-parked `compensating` run. We reject such handlers at
 * definition time.
 *
 * This is a STATIC source scan — it cannot catch a suspending call hidden
 * behind an indirection (a helper that closes over `ctx`). The compensation
 * runtime is the backstop: a `WaitSignal` (or `GotoSignal`) that escapes a
 * compensation handler is caught and fails the step's compensation to
 * `compensation_failed` rather than hanging. The static check exists to fail
 * the common, obvious mistake loudly at boot.
 *
 * We deliberately match `ctx`-qualified calls (and the common `{ wait }`
 * destructured-then-called shape is NOT matched — too noisy/false-positive;
 * the runtime guard covers it). The regex tolerates whitespace and optional
 * chaining/awaits.
 */
const SUSPENDING_PRIMITIVE_RE =
  /\b(?:ctx|context)\s*\.\s*(?:wait|waitFor|sleep|startChildWorkflow)\s*\(/;

function assertNonSuspendingCompensation(stepId: string, handler: StepHandler<unknown, unknown>) {
  // Function.prototype.toString gives the source for non-native fns. Native /
  // bound fns return "[native code]" — we skip those (can't introspect).
  let src: string;
  try {
    src = Function.prototype.toString.call(handler);
  } catch {
    return; // not introspectable — rely on the runtime guard
  }
  if (src.includes('[native code]')) return;
  if (SUSPENDING_PRIMITIVE_RE.test(src)) {
    const match = SUSPENDING_PRIMITIVE_RE.exec(src);
    throw new Error(
      `Workflow step "${stepId}": onCompensate handler calls a suspending primitive ` +
        `(${match?.[0] ?? 'ctx.wait/waitFor/sleep/startChildWorkflow'}). ` +
        `Compensation handlers MUST NOT suspend — they run inside the durable ` +
        `compensation phase, which has no resume site for a wait. Remove the ` +
        `suspending call (do the rollback synchronously, using ` +
        `ctx.idempotencyKey('compensate') for effectively-once external calls).`,
    );
  }
}

/** Type guard: is the step entry a StepConfig object (vs a plain handler fn)? */
function isStepConfig<TOutput, TContext>(
  step: StepHandler<TOutput, TContext> | StepConfig<TOutput, TContext>,
): step is StepConfig<TOutput, TContext> {
  return typeof step === 'object' && step !== null && 'handler' in step;
}

/**
 * Convert a StepConfig entry into a Step definition.
 *
 * The Step interface uses `(context: unknown)` for conditions because steps are
 * stored in WorkflowDefinition (untyped at runtime). This is the one boundary
 * where typed `TContext` callbacks widen to `unknown` — safe because the executor
 * always passes the correct TContext at call sites.
 */
function toStepDef<TContext>(stepId: string, entry: StepConfig<unknown, TContext>): Step {
  const step: Step = { id: stepId, name: toName(stepId) };

  if (entry.timeout !== undefined) step.timeout = entry.timeout;
  if (entry.retries !== undefined) step.retries = entry.retries;
  if (entry.retryDelay !== undefined) step.retryDelay = entry.retryDelay;
  if (entry.retryBackoff !== undefined) step.retryBackoff = entry.retryBackoff;

  // TContext → unknown widening: safe at this boundary.
  // The executor calls these with the real TContext value.
  if (entry.condition) step.condition = entry.condition as Step['condition'];
  if (entry.skipIf) step.skipIf = entry.skipIf as Step['skipIf'];
  if (entry.runIf) step.runIf = entry.runIf as Step['runIf'];

  if (entry.outputHistory !== undefined) step.outputHistory = entry.outputHistory;

  return step;
}

// ============================================================================
// Workflow Configuration
// ============================================================================

/**
 * Configuration for `createWorkflow()`.
 *
 * Steps can be plain async handlers or `StepConfig` objects with per-step
 * timeout, retries, and conditions. Mix freely — `TContext` infers everywhere.
 *
 * @example
 * ```typescript
 * const config: WorkflowConfig<MyContext> = {
 *   steps: {
 *     fast: async (ctx) => ctx.context.value * 2,
 *     slow: { handler: async (ctx) => heavyWork(), timeout: 120_000 },
 *   },
 *   context: (input) => ({ value: input.n }),
 * };
 * ```
 */
/**
 * Blocks generic inference at a use site (version-safe equivalent of TS 5.4's
 * built-in `NoInfer`). `TOutputs` must come from the EXPLICIT type argument,
 * never be inferred from the steps object — inferring it would be circular
 * (handler ctx types depend on it) and collapses to implicit-any.
 */
type NoInferStrict<T> = [T][T extends unknown ? 0 : never];

/**
 * The steps map, keyed and return-type-checked by the declared `TOutputs`.
 *
 * With the default `TOutputs` (`Record<string, unknown>`) this is exactly the
 * pre-2.6 shape — any step names, any return types. With a declared outputs
 * interface, every key must exist, no extra keys are allowed, and each
 * handler's resolved return type must match `TOutputs[K]`.
 */
export type WorkflowSteps<TContext, TOutputs = Record<string, unknown>> = {
  [K in keyof TOutputs]:
    | StepHandler<TOutputs[K], TContext, TOutputs>
    | StepConfig<TOutputs[K], TContext, TOutputs>;
};

export interface WorkflowConfig<TContext, TInput = unknown, TOutputs = Record<string, unknown>> {
  steps: WorkflowSteps<TContext, NoInferStrict<TOutputs>>;
  context?: (input: TInput) => TContext;
  version?: string;
  defaults?: {
    retries?: number;
    timeout?: number;
    retryDelay?: number;
    retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
    /**
     * Workflow-wide default for the opt-in output-history ring buffer.
     * Per-step `outputHistory` overrides this. `keep` 0/undefined ⇒ disabled.
     */
    outputHistory?: { keep: number };
  };
  autoExecute?: boolean;
  /** Optional custom container for dependency injection */
  container?: StreamlineContainer;
  /**
   * Custom scheduler configuration (partial — merged over the defaults).
   * Notably `inMemoryTimers: false` opts a high-scale deployment into
   * DB-only polling for timer/sleep resumes (no per-wait `setTimeout`).
   */
  scheduler?: Partial<SmartSchedulerConfig>;
  /**
   * Ring-buffer cap for persisted `stepLogs` (ctx.log()) on the run doc.
   * Defaults to {@link LIMITS.MAX_STEP_LOGS} (1000). See
   * {@link WorkflowEngineOptions.maxStepLogs}.
   */
  maxStepLogs?: number;

  /**
   * Opt-in HARD cap (bytes, JSON-approximated) for a single step output or
   * `ctx.checkpoint()` payload. Exceeding it fails the step with a
   * NON-retriable error (retrying can't shrink the payload) instead of
   * letting the run document silently grow toward — and then die at —
   * Mongo's 16MB BSON limit.
   *
   * Default: unset = warn-only. Payloads over 1MB log a warning naming the
   * run/step; nothing is rejected, so existing workflows are unaffected.
   *
   * For large artifacts, persist a reference (object-store key, file path,
   * doc id) and store only the reference in the output.
   */
  maxPayloadBytes?: number;

  /**
   * Observability-only step middleware (v2.6) — cross-cutting hooks awaited
   * around every step execution: `beforeStep`, `afterStep` (durable output +
   * durationMs), `onStepError`, `onWait`. Hooks run in array order; a hook
   * that throws is logged and SWALLOWED — middleware can never veto, fail,
   * or suspend a step. Use for metrics, tracing, token metering, structured
   * logging.
   *
   * @example
   * ```typescript
   * createWorkflow('agent', {
   *   steps: { ... },
   *   middleware: [
   *     { name: 'timing', afterStep: ({ stepId, durationMs }) => metrics.timing(stepId, durationMs) },
   *   ],
   * });
   * ```
   */
  middleware?: ReadonlyArray<StepMiddleware<TContext>>;

  // ============ Distributed Primitives ============

  /**
   * Auto-cancel workflow when any of these events fire.
   * @example `cancelOn: [{ event: 'order.cancelled' }]`
   */
  cancelOn?: Array<{ event: string }>;

  /**
   * Start-rate and concurrency controls for this workflow.
   *
   * - `limit` — best-effort cap on simultaneously *active* runs
   *   (running/waiting) per key. Excess start calls queue as drafts; the
   *   engine/scheduler promote them as slots free. **Advisory under
   *   concurrent starts** — count + create is not atomic, so brief
   *   oversubscription is possible. Use an external counter / Redis
   *   token-bucket if you need a strict distributed cap.
   * - `key` — bucket key derived from input. Required when `throttle` or
   *   `debounce` is set (use `() => 'global'` for a workflow-wide bucket).
   * - `throttle` — best-effort start-rate **smoothing**, NOT a strict
   *   distributed rate limiter. First `limit` starts per `windowMs` per key
   *   fire immediately. Excess starts queue as scheduled drafts and are
   *   spread:
   *     - First excess: `oldestInWindow + windowMs`
   *     - Each subsequent excess: `tail.executionTime + windowMs / limit`
   *   Sequential bursts smooth strictly. Parallel concurrent starts can
   *   reserve the same slot — bounded by parallelism, not by `limit`. Do
   *   not market as "≤ N per window."
   * - `debounce` — trailing-edge collapse: rapid starts within `windowMs`
   *   merge into a single fire `windowMs` after the last call. Each start
   *   atomically pushes the timer forward and overwrites `input` / `context`
   *   with the latest values. Lodash semantics.
   *
   * `throttle` and `debounce` are mutually exclusive — debounce already
   * collapses to one fire per quiet window, so layering throttle is
   * meaningless.
   *
   * Interaction note: `limit` is enforced at start time and at concurrency
   * draft promotion; throttle-queued drafts skip the limit re-check at
   * pickup. Combine the two only if a brief overshoot is acceptable.
   *
   * @example
   * ```ts
   * concurrency: {
   *   limit: 5,
   *   key: (input) => input.userId,
   *   throttle: { limit: 10, windowMs: 60_000 }, // smooth toward 10/min/user
   * }
   * ```
   */
  concurrency?: {
    limit?: number;
    key?: (input: TInput) => string;
    throttle?: { limit: number; windowMs: number };
    debounce?: { windowMs: number };
    /**
     * Strict mode for `concurrency.limit`. When `true`, starts that exceed
     * the limit throw `ConcurrencyLimitReachedError` (429) instead of
     * queueing as drafts. Backed by an atomic counter doc + mongokit's
     * `findOneAndUpdate` upsert race pattern — race-safe across parallel
     * workers and processes (the best-effort path is count-then-create
     * and oversubscribable under bursts).
     *
     * Use for workloads where queuing is unsafe — payment captures with
     * deadlines, SLA-bound tasks, partner-API quotas. The caller decides
     * whether to retry on the 429 (with backoff) or fail loudly.
     *
     * Requires `limit` and `key` to be set. Throws at workflow definition
     * time if either is missing.
     *
     * Drift recovery: the counter can leak +1 if a worker dies between
     * `claimSlot` and `repository.create` (bounded by parallelism × MTBF).
     * Call `WorkflowConcurrencyCounterRepository.reconcile(workflowId)` (repairs
     * every bucket for the workflow) or `reconcile(workflowId, key)` (one
     * bucket) periodically — a daily cron is plenty — to recount active runs
     * and reset the counter(s) to truth. Returns the corrected count.
     *
     * @example
     * concurrency: {
     *   key: (input) => input.orderId,
     *   limit: 1,           // exactly 1 capture per order
     *   strict: true,       // reject duplicates loudly
     * }
     */
    strict?: boolean;
  };

  /**
   * Auto-start workflow when this event fires on the event bus.
   *
   * **Multi-tenant note.** Auto-started runs flow through the same
   * `start()` path as direct invocations, so the same tenant-context
   * rules apply: in `multiTenant.strict: true` mode the start throws
   * `Missing tenantId` unless context is provided. Three ways to wire
   * tenant context for triggered workflows:
   *
   *   - `tenantId: (payload) => payload.orgId` — extractor function,
   *     called per event firing. Use when the tenant is in the event
   *     payload.
   *   - `staticTenantId: 'org-1'` — single-tenant deployment scoping
   *     every triggered run to the same tenant.
   *   - `bypassTenant: true` — admin/cross-tenant trigger; only
   *     honored when the multi-tenant plugin allows bypass.
   *
   * Without one of these in strict mode, the trigger fires but
   * `engine.start()` throws and surfaces via `engine:error` (the
   * trigger listener swallows the rejection by design — see
   * `define.ts` listener wiring).
   *
   * @example
   * ```ts
   * trigger: {
   *   event: 'user.created',
   *   tenantId: (payload) => payload.data.orgId,
   * }
   * ```
   */
  trigger?: {
    event: string;
    /** Extract tenantId from the event payload. Called per firing. */
    tenantId?: (payload: unknown) => string | undefined;
    /** Static tenant for every triggered run (single-tenant deployments). */
    staticTenantId?: string;
    /** Bypass tenant scoping (admin/cross-tenant triggers). */
    bypassTenant?: boolean;
  };

  /**
   * Migration hook for in-flight runs whose `definitionVersion` is older
   * than this engine's `version` AND whose original-version engine is not
   * registered. See `WorkflowEngineOptions.migrateRun` for the full
   * contract — this field is the surface hosts use through `createWorkflow`.
   *
   * The host inspects the run, returns a partial `WorkflowRun` shape (e.g.
   * a remapped `currentStepId`, backfilled `context`, rewritten `steps[]`),
   * and the engine merges + re-pins the run to its own version. Return
   * `null`/`undefined` to fall through (the engine will fail the run with
   * `VERSION_MISMATCH` if the step graph diverged).
   */
  migrateRun?: (
    run: import('../core/types.js').WorkflowRun<unknown>,
  ) =>
    | Partial<import('../core/types.js').WorkflowRun<unknown>>
    | null
    | undefined
    | Promise<Partial<import('../core/types.js').WorkflowRun<unknown>> | null | undefined>;
}

/** Options for `Workflow.start()` */
export interface StartOptions {
  /** Metadata (userId, tags, etc.) */
  meta?: Record<string, unknown>;
  /** Idempotency key — only one non-terminal run per key. Duplicate starts return the existing run. */
  idempotencyKey?: string;
  /** Execution priority (higher = picked up sooner by scheduler). @default 0 */
  priority?: number;
  /**
   * Tenant identifier — required when the container's repository is
   * configured with `multiTenant.strict: true`. Forwarded to:
   *   - the `create` operation that persists the new run (auto-injected
   *     into the document at the configured `tenantField`)
   *   - the atomic `findOneAndUpdate` for `debounce` bumps
   *   - the `count` / `findAll` queries for `throttle` window probes
   *
   * Single-tenant deployments using `staticTenantId` can omit this.
   * Strict-tenant deployments that miss it get a thrown error from the
   * tenant-filter plugin instead of a silent cross-tenant write.
   */
  tenantId?: string;
  /**
   * Bypass tenant scoping for this call — use only for admin /
   * cross-tenant operations. Honored only when the plugin was
   * constructed with `allowBypass: true` (the default).
   */
  bypassTenant?: boolean;
}

/** Options for `Workflow.waitFor()` */
export interface WaitForOptions {
  /** Poll interval in ms @default 1000 */
  pollInterval?: number;
  /** Maximum time to wait in ms @default undefined (no timeout) */
  timeout?: number;
}

/**
 * A running workflow instance returned by `createWorkflow()`.
 *
 * Exported so consumers can type variables without the `ReturnType<>` workaround.
 *
 * @example
 * ```typescript
 * import { createWorkflow, type Workflow } from '@classytic/streamline';
 *
 * export const myWorkflow: Workflow<MyCtx, MyInput> = createWorkflow('my', { ... });
 * ```
 */
export interface Workflow<TContext, TInput = unknown> {
  start: (input: TInput, options?: StartOptions) => Promise<WorkflowRun<TContext>>;
  get: (runId: string) => Promise<WorkflowRun<TContext> | null>;
  execute: (runId: string) => Promise<WorkflowRun<TContext>>;
  resume: (runId: string, payload?: unknown) => Promise<WorkflowRun<TContext>>;
  cancel: (runId: string) => Promise<WorkflowRun<TContext>>;
  pause: (runId: string) => Promise<WorkflowRun<TContext>>;
  rewindTo: (runId: string, stepId: string) => Promise<WorkflowRun<TContext>>;
  waitFor: (runId: string, options?: WaitForOptions) => Promise<WorkflowRun<TContext>>;
  shutdown: () => void;
  definition: WorkflowDefinition<TContext>;
  engine: WorkflowEngine<TContext>;
  /** The container used by this workflow (for testing or custom integrations) */
  container: StreamlineContainer;
  /**
   * Bind workflow-level failure to a parent document on a Mongoose model.
   *
   * When this workflow's run transitions to `failed`, the helper looks up the
   * parent doc id from `run.input` or `run.context` (configurable) and patches
   * the parent doc with a status field (and optionally an error message).
   *
   * Replaces the hand-rolled "subscribe to `workflow:failed` → match by
   * workflow id → look up parent → patch" boilerplate hosts otherwise repeat
   * once per workflow.
   *
   * Returns an `off()` unsubscribe function — call it on graceful shutdown if
   * the workflow's container outlives the parent-model registration.
   *
   * @example
   * ```ts
   * const off = renderVideo.bindFailureTo({
   *   model: VideoJobModel,
   *   key: 'videoJobId',          // run.input.videoJobId
   *   field: 'status',
   *   value: 'failed',
   *   errorField: 'errorMessage',
   * });
   * ```
   */
  bindFailureTo: (options: BindFailureToOptions<TContext>) => () => void;
}

/**
 * Configuration for {@link Workflow.bindFailureTo}.
 *
 * Designed to be hand-rolled-replacement minimal — every host-side
 * "on workflow failure, mark the parent doc as failed" handler should
 * collapse to one call with these fields.
 */
export interface BindFailureToOptions<TContext = Record<string, unknown>> {
  /**
   * The Mongoose model owning the parent doc. Duck-typed against
   * `findByIdAndUpdate(id, update)` so test models / custom adapters that
   * conform to the minimal contract also work.
   */
  readonly model: {
    findByIdAndUpdate: (
      id: unknown,
      update: Record<string, unknown>,
    ) =>
      | Promise<unknown>
      | {
          exec: () => Promise<unknown>;
        };
  };

  /**
   * Where to read the parent id from:
   *   - `'input'` (default): `run.input[key]` — when the host passed the id
   *     into `workflow.start({ videoJobId: '...' })`
   *   - `'context'`: `run.context[key]` — when the id was assembled by the
   *     workflow's `context: (input) => ...` builder
   *
   * Ignored when `key` is a function.
   */
  readonly source?: 'input' | 'context';

  /**
   * Either a property name (e.g. `'videoJobId'`) read from `source`, or a
   * resolver function for shapes the simple path can't reach (nested fields,
   * computed ids, parent-doc id stored in step output).
   */
  readonly key: string | ((run: WorkflowRun<TContext>) => unknown);

  /**
   * Parent-doc field to write on failure. Common: `'status'`.
   */
  readonly field: string;

  /**
   * Value to set at {@link field}. Defaults to `'failed'`.
   */
  readonly value?: unknown;

  /**
   * Optional: also write the failure error to this field. Common:
   * `'errorMessage'` or `'lastError'`.
   */
  readonly errorField?: string;

  /**
   * Optional: shape the error before writing to {@link errorField}. By default
   * we store `error.message ?? String(error)`.
   */
  readonly errorTransform?: (error: WorkflowFailedPayload['error']) => unknown;
}

// ============================================================================
// createWorkflow()
// ============================================================================

/**
 * Create a workflow with inline step handlers
 *
 * @example
 * ```typescript
 * const orderProcess = createWorkflow('order-process', {
 *   steps: {
 *     validate: async (ctx) => validateOrder(ctx.input),
 *     charge: async (ctx) => chargeCard(ctx.getOutput('validate')),
 *     fulfill: async (ctx) => shipOrder(ctx.getOutput('charge')),
 *     notify: async (ctx) => sendConfirmation(ctx.context.email),
 *   },
 *   context: (input) => ({ orderId: input.id, email: input.email }),
 * });
 *
 * await orderProcess.start({ id: '123', email: 'user@example.com' });
 * ```
 *
 * @example Per-step configuration
 * ```typescript
 * const pipeline = createWorkflow('ci-pipeline', {
 *   steps: {
 *     clone: { handler: async (ctx) => { ... }, timeout: 120_000 },
 *     build: { handler: async (ctx) => { ... }, retries: 5 },
 *     deploy: {
 *       handler: async (ctx) => { ... },
 *       skipIf: (ctx) => !ctx.shouldDeploy,
 *     },
 *   },
 * });
 * ```
 */
export function createWorkflow<
  TContext = Record<string, unknown>,
  TInput = unknown,
  TOutputs = Record<string, unknown>,
>(id: string, config: WorkflowConfig<TContext, TInput, TOutputs>): Workflow<TContext, TInput> {
  validateId(id, 'workflow');

  // Internal view of the typed steps map. The TOutputs-keyed mapped type only
  // exists for compile-time checking; at runtime it's a plain record. Same
  // widening boundary as the TContext→unknown casts below.
  const stepsRecord = config.steps as Record<
    string,
    StepHandler<unknown, TContext> | StepConfig<unknown, TContext>
  >;

  const stepIds = Object.keys(stepsRecord);
  if (stepIds.length === 0) {
    throw new Error('Workflow must have at least one step');
  }

  if (config.defaults) {
    validateRetryConfig(
      config.defaults.retries,
      config.defaults.timeout,
      config.defaults.retryDelay,
      config.defaults.retryBackoff,
    );
  }

  if (config.concurrency) {
    const { throttle, debounce, key, strict, limit } = config.concurrency;
    if (throttle && debounce) {
      throw new Error(
        `Workflow "${id}": concurrency.throttle and concurrency.debounce are mutually exclusive. ` +
          `Debounce already collapses bursts to one fire per quiet window.`,
      );
    }
    if ((throttle || debounce) && !key) {
      throw new Error(
        `Workflow "${id}": concurrency.${throttle ? 'throttle' : 'debounce'} requires a 'key' function. ` +
          `Use 'key: () => "global"' for a workflow-wide bucket.`,
      );
    }
    if (throttle && (!Number.isFinite(throttle.limit) || throttle.limit <= 0)) {
      throw new Error(`Workflow "${id}": concurrency.throttle.limit must be a positive number.`);
    }
    if (throttle && (!Number.isFinite(throttle.windowMs) || throttle.windowMs <= 0)) {
      throw new Error(`Workflow "${id}": concurrency.throttle.windowMs must be a positive number.`);
    }
    if (debounce && (!Number.isFinite(debounce.windowMs) || debounce.windowMs <= 0)) {
      throw new Error(`Workflow "${id}": concurrency.debounce.windowMs must be a positive number.`);
    }
    if (strict) {
      if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
        throw new Error(
          `Workflow "${id}": concurrency.strict requires a positive concurrency.limit. ` +
            `Strict mode is the atomic-counter version of \`limit\`; without a limit, there's nothing to gate on.`,
        );
      }
      if (!key) {
        throw new Error(
          `Workflow "${id}": concurrency.strict requires a 'key' function. ` +
            `Use 'key: () => "global"' for a workflow-wide bucket.`,
        );
      }
    }
  }

  // Normalize: separate handlers, compensation handlers, and step definitions
  const handlers: Record<string, StepHandler<unknown, TContext>> = {};
  const compensationHandlers: Record<string, StepHandler<unknown, TContext>> = {};
  const compensationConfigs: Record<
    string,
    {
      retries?: number;
      retryDelay?: number;
      retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
    }
  > = {};
  const steps: Step[] = stepIds.map((stepId) => {
    validateId(stepId, 'step');

    // stepId comes from Object.keys(stepsRecord) — always defined
    const entry = stepsRecord[stepId]!;

    if (isStepConfig(entry)) {
      validateRetryConfig(entry.retries, entry.timeout, entry.retryDelay, entry.retryBackoff);
      handlers[stepId] = entry.handler;
      if (entry.onCompensate) {
        // Reject suspending primitives in compensation handlers at define time
        // (best-effort static scan; the compensation runtime is the backstop).
        assertNonSuspendingCompensation(
          stepId,
          entry.onCompensate as StepHandler<unknown, unknown>,
        );
        compensationHandlers[stepId] = entry.onCompensate;
        const cfg: {
          retries?: number;
          retryDelay?: number;
          retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
        } = {};
        if (entry.compensateRetries !== undefined) cfg.retries = entry.compensateRetries;
        if (entry.compensateRetryDelay !== undefined) cfg.retryDelay = entry.compensateRetryDelay;
        if (entry.compensateRetryBackoff !== undefined)
          cfg.retryBackoff = entry.compensateRetryBackoff;
        if (Object.keys(cfg).length > 0) compensationConfigs[stepId] = cfg;
      }
      return toStepDef(stepId, entry);
    }

    handlers[stepId] = entry;
    return { id: stepId, name: toName(stepId) };
  });

  const definition: WorkflowDefinition<TContext> = {
    id,
    name: toName(id),
    version: config.version ?? '1.0.0',
    steps,
    createContext: (config.context ?? ((input) => input)) as (input: unknown) => TContext,
    defaults: config.defaults,
  };

  const container = config.container ?? createContainer();

  const engine = new WorkflowEngine(definition, handlers, container, {
    ...(config.autoExecute !== undefined && { autoExecute: config.autoExecute }),
    compensationHandlers:
      Object.keys(compensationHandlers).length > 0
        ? (compensationHandlers as unknown as Record<
            string,
            import('../core/types.js').StepHandler<unknown, unknown>
          >)
        : undefined,
    ...(Object.keys(compensationConfigs).length > 0 && { compensationConfigs }),
    ...(config.migrateRun !== undefined && { migrateRun: config.migrateRun }),
    ...(config.scheduler !== undefined && { scheduler: config.scheduler }),
    ...(config.maxStepLogs !== undefined && { maxStepLogs: config.maxStepLogs }),
    ...(config.maxPayloadBytes !== undefined && { maxPayloadBytes: config.maxPayloadBytes }),
    ...(config.middleware !== undefined && {
      middleware: config.middleware as ReadonlyArray<StepMiddleware>,
    }),
    // Only strict-concurrency workflows need the engine's terminal-event
    // slot-release listeners. Gating their registration keeps non-strict
    // workflows at zero engine bus listeners — which is what stops N
    // workflows on a shared `eventBus: 'global'` bus from tripping Node's
    // per-event MaxListenersExceededWarning. Behavior-preserving: a
    // non-strict run never carries the `concurrencyCounterId` marker those
    // listeners act on.
    usesStrictConcurrency: Boolean(config.concurrency?.strict),
  });

  const waitFor = async (
    runId: string,
    options: WaitForOptions = {},
  ): Promise<WorkflowRun<TContext>> => {
    const { pollInterval = 1000, timeout } = options;
    const startTime = Date.now();

    while (true) {
      const run = await engine.get(runId);

      if (!run) {
        throw new WorkflowNotFoundError(runId);
      }

      if (isTerminalState(run.status)) {
        return run;
      }

      if (timeout && Date.now() - startTime >= timeout) {
        throw new Error(
          `Timeout waiting for workflow "${runId}" to complete after ${timeout}ms. Current status: ${run.status}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  };

  // ============ Distributed Primitives Wiring ============

  // Event trigger: forward-declared, wired AFTER `start` is defined (so
  // triggered firings flow through the full gate stack — debounce / throttle
  // / concurrency.limit / tenant scoping — not just `engine.start`).
  let triggerListener: ((payload: unknown) => void) | undefined;

  const start = async (input: TInput, options?: StartOptions): Promise<WorkflowRun<TContext>> => {
    const meta = options?.meta;
    const idempotencyKey = options?.idempotencyKey;
    const priority = options?.priority;
    const concurrencyKey = config.concurrency?.key ? config.concurrency.key(input) : undefined;

    // Tenant context — propagated through every persistence path so
    // strict-mode `before:create` / `before:findOneAndUpdate` /
    // `before:getOne` hooks see the caller's scope. Single-tenant /
    // staticTenantId deployments pass nothing and the plugin no-ops.
    const tenantOpts = {
      ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options?.bypassTenant ? { bypassTenant: true } : {}),
    };

    // ============ Trailing-edge debounce ============
    // Atomically bump any pending debounce draft for this bucket. If one
    // exists, we're done — its timer just got pushed and input/context
    // refreshed to the latest values. Otherwise fall through and create a
    // new debounce draft below.
    if (config.concurrency?.debounce && concurrencyKey !== undefined) {
      const nextFireAt = new Date(Date.now() + config.concurrency.debounce.windowMs);
      const ctxValue = definition.createContext(input);
      const bumped = await container.repository.bumpDebounceDraft(
        definition.id,
        concurrencyKey,
        nextFireAt,
        input,
        ctxValue,
        tenantOpts,
      );
      if (bumped) return bumped as WorkflowRun<TContext>;
      // First call in a quiet window — create the debounce draft.
      return engine.start(input, {
        meta: { ...meta, concurrencyLimit: config.concurrency.limit, streamlineGate: 'debounce' },
        idempotencyKey,
        priority,
        concurrencyKey,
        scheduledExecutionTime: nextFireAt,
        cancelOn: config.cancelOn,
        ...tenantOpts,
      });
    }

    // ============ Throttle (queue-excess rate limit) ============
    // Count starts in the trailing window. If at/over limit, schedule the
    // new run via `nextThrottleFireAt` which staggers excess across the
    // window (`tail + windowMs/limit`) instead of bunching them at the
    // single `oldest + windowMs` slot.
    if (config.concurrency?.throttle && concurrencyKey !== undefined) {
      const { limit, windowMs } = config.concurrency.throttle;
      const since = new Date(Date.now() - windowMs);
      const inWindow = await container.repository.countStartsInWindow(
        definition.id,
        concurrencyKey,
        since,
        tenantOpts,
      );
      if (inWindow >= limit) {
        const fireAt = await container.repository.nextThrottleFireAt(
          definition.id,
          concurrencyKey,
          limit,
          windowMs,
          tenantOpts,
        );
        return engine.start(input, {
          meta: {
            ...meta,
            concurrencyLimit: config.concurrency.limit,
            streamlineGate: 'throttle',
          },
          idempotencyKey,
          priority,
          concurrencyKey,
          scheduledExecutionTime: fireAt,
          cancelOn: config.cancelOn,
          ...tenantOpts,
        });
      }
      // Under throttle limit — fall through to concurrency.limit check.
    }

    // ============ Concurrency limit (max simultaneously active) ============
    //
    // Two modes — picked by `concurrency.strict`:
    //
    //   STRICT: atomic counter via `WorkflowConcurrencyCounterRepository`.
    //   Race-safe across parallel workers and processes (best-effort path
    //   below is count-then-create and oversubscribable). Reject when full
    //   with `ConcurrencyLimitReachedError` (429) — caller decides whether
    //   to retry. Validation upstream guarantees `limit` and `key` are set.
    //
    //   BEST-EFFORT (default): count active runs, queue excess as draft.
    //   Documented as advisory; brief oversubscription is possible under
    //   bursts. Suitable for "don't overload an embedding API"; not for
    //   "exactly N payment captures."
    let startAsDraft = false;
    let counterClaimed: { id: string } | undefined;
    if (config.concurrency?.limit !== undefined && concurrencyKey !== undefined) {
      if (config.concurrency.strict) {
        // Idempotency-dedup pre-check (BEFORE claimSlot). With strict
        // concurrency + an idempotencyKey, claiming a slot here and then
        // calling engine.start would leak the slot when start short-circuits
        // to an already-active run (engine.ts returns it WITHOUT throwing, so
        // the catch-based releaseSlot below never fires). The counter would
        // drift +1 per duplicate submit — for limit:1 the bucket wedges after
        // the first dedup. Returning the existing active run here means we
        // never claim a second slot for a logical run that already holds one.
        if (idempotencyKey !== undefined) {
          const existing = await container.repository.findActiveByIdempotencyKey(
            idempotencyKey,
            tenantOpts,
          );
          if (existing) return existing as WorkflowRun<TContext>;
        }
        const counterId = makeCounterId(definition.id, concurrencyKey);
        const ok = await container.concurrencyCounterRepository.claimSlot(
          counterId,
          config.concurrency.limit,
          definition.id,
          concurrencyKey,
        );
        if (!ok) {
          throw new ConcurrencyLimitReachedError(
            definition.id,
            concurrencyKey,
            config.concurrency.limit,
          );
        }
        counterClaimed = { id: counterId };
      } else {
        const activeCount = await container.repository.countActiveByConcurrencyKey(
          definition.id,
          concurrencyKey,
          tenantOpts,
        );
        if (activeCount >= config.concurrency.limit) {
          startAsDraft = true;
        }
      }
    }

    const enrichedMeta = {
      ...(config.concurrency ? { ...meta, concurrencyLimit: config.concurrency.limit } : meta),
      // Stamp the counter id so the completion-event listener can release
      // the slot. Read at terminal-state transitions in engine.ts. Absent
      // for best-effort (no counter to release).
      ...(counterClaimed ? { concurrencyCounterId: counterClaimed.id } : {}),
    };

    try {
      return await engine.start(input, {
        meta: enrichedMeta,
        idempotencyKey,
        priority,
        concurrencyKey,
        startAsDraft,
        cancelOn: config.cancelOn,
        ...tenantOpts,
      });
    } catch (err) {
      // Roll the counter back if `engine.start` itself failed AFTER
      // we successfully claimed (validation, idempotency miss, DB error).
      // Without this the counter would leak +1 on every failed start.
      if (counterClaimed) {
        await container.concurrencyCounterRepository.releaseSlot(counterClaimed.id).catch(() => {
          // Release failures are diagnostic-only — don't override the
          // primary error or throw a secondary. Reconciliation will
          // catch persistent leaks.
        });
      }
      throw err;
    }
  };

  // Now that `start` is in scope, wire the trigger listener (if configured).
  // Triggered firings flow through the wrapped `start()` — same gate stack
  // (debounce / throttle / concurrency.limit) and tenant context as direct
  // invocations. Tenant context is derived per-firing from `config.trigger`:
  //   - extractor function (most flexible) — `tenantId: (payload) => …`
  //   - static tenant id (single-tenant deployments)
  //   - `bypassTenant: true` (admin / cross-tenant triggers)
  // None set + strict multi-tenant mode = `start()` throws → emitted via
  // `engine:error` (we deliberately swallow the rejection here so a
  // misconfigured trigger doesn't crash the event-bus listener loop).
  if (config.trigger?.event) {
    const trigger = config.trigger;
    triggerListener = (payload: unknown) => {
      const data = (payload as { data?: unknown })?.data ?? payload;
      const triggerOpts: StartOptions = {};
      if (trigger.tenantId) {
        const extracted = trigger.tenantId(payload);
        if (extracted !== undefined) triggerOpts.tenantId = extracted;
      } else if (trigger.staticTenantId !== undefined) {
        triggerOpts.tenantId = trigger.staticTenantId;
      }
      if (trigger.bypassTenant) triggerOpts.bypassTenant = true;

      start(data as TInput, triggerOpts).catch((err) => {
        // Trigger-started workflow failed — surface via engine:error so
        // hosts can wire alerting on broken triggers (vs silently dropping).
        container.eventBus.emit('engine:error', {
          runId: undefined,
          error: err instanceof Error ? err : new Error(String(err)),
          context: `trigger:${trigger.event}`,
        });
      });
    };
    container.eventBus.on(config.trigger.event, triggerListener);
  }

  // ============ bindFailureTo ============
  //
  // Subscribes to `workflow:failed` on the container's event bus and patches
  // a parent doc when a failure for THIS workflow's runs lands. Hand-rolled
  // versions of this typically: (1) listen on the same shared bus, (2) call
  // `engine.get(runId)` to read the run, (3) filter by `workflowId`, (4) walk
  // input/context for the parent id, (5) call `Model.findByIdAndUpdate`. Now
  // one call.
  const bindFailureTo = (options: BindFailureToOptions<TContext>): (() => void) => {
    const source = options.source ?? 'input';
    const errorField = options.errorField;
    const targetValue = options.value ?? 'failed';
    const errorTransform =
      options.errorTransform ??
      ((err: WorkflowFailedPayload['error']) =>
        err && typeof err === 'object' && 'message' in err
          ? (err as { message: string }).message
          : String(err));

    const handler = async (payload: WorkflowFailedPayload): Promise<void> => {
      try {
        const run = await engine.get(payload.runId);
        if (!run || run.workflowId !== definition.id) return;

        let parentId: unknown;
        if (typeof options.key === 'function') {
          parentId = options.key(run as WorkflowRun<TContext>);
        } else {
          const root = source === 'context' ? run.context : (run.input as unknown);
          parentId =
            root && typeof root === 'object'
              ? (root as Record<string, unknown>)[options.key]
              : undefined;
        }
        if (parentId == null) return;

        const update: Record<string, unknown> = { [options.field]: targetValue };
        if (errorField) update[errorField] = errorTransform(payload.error);

        const result = options.model.findByIdAndUpdate(parentId, update);
        // Mongoose returns a query that resolves on `.exec()` OR a Promise on
        // newer versions. Handle both so duck-typed test models work too.
        if (result && typeof (result as { exec?: unknown }).exec === 'function') {
          await (result as { exec: () => Promise<unknown> }).exec();
        } else {
          await result;
        }
      } catch (err) {
        // Best-effort — never let the failure-bridge itself crash the bus.
        // Surface through `engine:error` so the host's existing engine-error
        // sink picks it up rather than swallowing silently.
        container.eventBus.emit('engine:error', {
          runId: payload.runId,
          error: err instanceof Error ? err : new Error(String(err)),
          context: `bindFailureTo[${definition.id}]`,
        });
      }
    };

    container.eventBus.on('workflow:failed', handler);
    return () => {
      container.eventBus.off('workflow:failed', handler);
    };
  };

  return {
    start,
    get: (runId) => engine.get(runId),
    execute: (runId) => engine.execute(runId),
    resume: (runId, payload) => engine.resume(runId, payload),
    cancel: (runId) => engine.cancel(runId),
    pause: (runId) => engine.pause(runId),
    rewindTo: (runId, stepId) => engine.rewindTo(runId, stepId),
    waitFor,
    shutdown: () => {
      // Remove only THIS workflow's trigger listener (safe for shared buses)
      if (config.trigger?.event && triggerListener) {
        container.eventBus.off(config.trigger.event, triggerListener);
      }
      engine.shutdown();
    },
    definition,
    engine,
    container,
    bindFailureTo,
  };
}

/**
 * Hook for waiting on external input (webhooks, approvals, etc.)
 *
 * @example
 * ```typescript
 * const approval = createWorkflow('approval', {
 *   steps: {
 *     request: async (ctx) => {
 *       await sendApprovalRequest(ctx.input.documentId);
 *     },
 *     waitForApproval: async (ctx) => {
 *       // Pauses workflow until resumed with payload
 *       return ctx.wait('Waiting for approval');
 *     },
 *     process: async (ctx) => {
 *       const approval = ctx.getOutput('waitForApproval');
 *       if (approval.approved) {
 *         await processDocument(ctx.input.documentId);
 *       }
 *     },
 *   },
 * });
 *
 * // Resume from webhook handler
 * await approval.resume(runId, { approved: true, approvedBy: 'admin' });
 * ```
 */
export type { StepContext, WorkflowRun };
