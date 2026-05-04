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
import { isTerminalState } from '../core/status.js';
import type {
  Step,
  StepContext,
  StepHandler,
  WorkflowDefinition,
  WorkflowRun,
} from '../core/types.js';
import { WorkflowEngine } from '../execution/engine.js';
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
export interface StepConfig<TOutput = unknown, TContext = Record<string, unknown>> {
  handler: StepHandler<TOutput, TContext>;
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
  onCompensate?: StepHandler<unknown, TContext>;
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
export interface WorkflowConfig<TContext, TInput = unknown> {
  steps: Record<string, StepHandler<unknown, TContext> | StepConfig<unknown, TContext>>;
  context?: (input: TInput) => TContext;
  version?: string;
  defaults?: {
    retries?: number;
    timeout?: number;
    retryDelay?: number;
    retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
  };
  autoExecute?: boolean;
  /** Optional custom container for dependency injection */
  container?: StreamlineContainer;

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
     * Run `WorkflowConcurrencyCounterRepository.reconcile(workflowId)`
     * periodically (daily cron is plenty) to reset counters to truth.
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
export function createWorkflow<TContext = Record<string, unknown>, TInput = unknown>(
  id: string,
  config: WorkflowConfig<TContext, TInput>,
): Workflow<TContext, TInput> {
  validateId(id, 'workflow');

  const stepIds = Object.keys(config.steps);
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
  const steps: Step[] = stepIds.map((stepId) => {
    validateId(stepId, 'step');

    // stepId comes from Object.keys(config.steps) — always defined
    const entry = config.steps[stepId]!;

    if (isStepConfig(entry)) {
      validateRetryConfig(entry.retries, entry.timeout, entry.retryDelay, entry.retryBackoff);
      handlers[stepId] = entry.handler;
      if (entry.onCompensate) {
        compensationHandlers[stepId] = entry.onCompensate;
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
