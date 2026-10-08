import { randomUUID } from 'node:crypto';
import { assertAndClaim } from '@classytic/primitives/state-machine';
import { TIMING } from '../config/constants.js';
import type { StreamlineContainer } from '../core/container.js';
import { RUN_MACHINE } from '../core/status.js';
import type { StepState, WorkflowHandlers, WorkflowRun } from '../core/types.js';
import { staleHeartbeatOr } from '../storage/query-builder.js';
import { toError } from '../utils/errors.js';
import { calculateRetryDelay, resolveBackoffMultiplier } from '../utils/helpers.js';
import { GotoSignal, StepContextImpl, WaitSignal } from './context.js';
import type { WorkflowEngineOptions } from './engine.js';

/**
 * Minimal view of `WorkflowEngine` the durable-saga compensation helpers need.
 * Extracted so `runCompensation` / `recoverCompensation` / `driveCompensation`
 * / `compensateOneStep` can live in their own focused module while reaching
 * exactly the engine collaborators they used as private methods — no behavior
 * change, just a relocation of the bodies.
 */
export interface SagaEngine<TContext> {
  readonly container: StreamlineContainer;
  readonly options: WorkflowEngineOptions;
  get(runId: string): Promise<WorkflowRun<TContext> | null>;
  /** Let `cancel()` / `shutdown()` abort the walk's `ctx.signal` in-process. */
  trackAbort(runId: string, controller: AbortController): () => void;
}

/** Claim patch that hands the walk to a fresh owner and clears the crash marker. */
function ownWalk(token: string, now: Date): Record<string, unknown> {
  return {
    $set: { compensationAttemptId: token, lastHeartbeat: now, updatedAt: now },
    $unset: { compensationDue: '' },
  };
}

/**
 * Durable saga compensation phase (v2.4).
 *
 * Inline entry from a freshly-`failed` run: transitions `failed →
 * compensating` via `assertAndClaim` as the FIRST durable action (so in a
 * multi-worker setup exactly one worker enters — the loser's claim returns
 * null and this is a no-op), then drives the compensation walk.
 *
 * EXACTLY-ONCE BOUNDARY (documented honestly): per-step compensation
 * memoization (`steps.<i>.compensation.status` flipped pending→done via a
 * numeric-index guarded CAS, written DB-first AFTER the handler resolves) is
 * effectively-once for SAME-CLUSTER writes only. For EXTERNAL side effects
 * (Stripe refund, etc.) it provides NOTHING by itself: there is a crash
 * window AFTER the external call succeeds but BEFORE the pending→done CAS
 * lands, during which recovery re-runs the handler. External compensation is
 * effectively-once ONLY if the handler passes `ctx.idempotencyKey('compensate')`
 * (attempt-invariant, stable across crash/resume) to the provider so the
 * provider dedupes. We make NO "exactly-once against external APIs" claim.
 */
export async function runCompensation<TContext>(
  engine: SagaEngine<TContext>,
  run: WorkflowRun<TContext>,
): Promise<WorkflowRun<TContext>> {
  const compensationHandlers = engine.options.compensationHandlers;
  if (!compensationHandlers) return run;

  const runId = run._id;
  const token = randomUUID();

  // FIRST durable action: failed → compensating, stamping this walk's owner
  // token. assertAndClaim runs the sync state-machine assertion then an atomic
  // CAS; null = another worker already entered (one winner). The loser
  // returns the current state and does NOT build a (possibly stale) list.
  const claimed = await assertAndClaim(RUN_MACHINE, engine.container.repository, runId, {
    from: 'failed',
    to: 'compensating',
    patch: ownWalk(token, new Date()),
    options: { bypassTenant: true },
  });

  if (!claimed) {
    // Lost the entry race (or run already past `failed`). Return current
    // persisted state; the winner (or a recovery sweep) drives compensation.
    engine.container.cache.delete(runId);
    return (await engine.get(runId)) ?? run;
  }

  engine.container.cache.delete(runId);
  return driveCompensation(engine, runId, token);
}

/**
 * Crash-recovery entrypoint for the two stuck saga shapes:
 *   - `compensating` with a stale heartbeat: the walker died mid-rollback.
 *     Reclaimed compensating → compensating under a NEW owner token, so a
 *     stalled-but-alive old walker's writes are refused from here on.
 *   - `failed` + `compensationDue`, untouched past the threshold: the process
 *     died between the failure write and `failed → compensating`. Entered now.
 * Either way the walk skips per-step compensations already `done`
 * (effectively-once), so step N+1 isn't compensated twice.
 *
 * Wired into the scheduler's poll via `getStaleCompensatingRuns`.
 */
export async function recoverCompensation<TContext>(
  engine: SagaEngine<TContext>,
  runId: string,
  staleThresholdMs: number,
): Promise<WorkflowRun<TContext> | null> {
  if (!engine.options.compensationHandlers) return null;
  const staleTime = new Date(Date.now() - staleThresholdMs);
  const token = randomUUID();
  const repo = engine.container.repository;

  const reclaimed = await repo.claim(
    runId,
    {
      from: 'compensating',
      to: 'compensating',
      where: {
        $or: staleHeartbeatOr(staleTime),
      },
    },
    { ...ownWalk(token, new Date()), $inc: { recoveryAttempts: 1 } },
    { bypassTenant: true },
  );
  const claimed =
    reclaimed ??
    (await assertAndClaim(RUN_MACHINE, repo, runId, {
      from: 'failed',
      to: 'compensating',
      where: { compensationDue: true, updatedAt: { $lt: staleTime } },
      patch: ownWalk(token, new Date()),
      options: { bypassTenant: true },
    }));

  if (!claimed) return null; // live, settled, or not ours

  engine.container.cache.delete(runId);
  engine.container.eventBus.emit('workflow:recovered', { runId });
  return driveCompensation(engine, runId, token);
}

/**
 * Core compensation walk. Assumes the run is already in `compensating`
 * (claimed by the inline entry or the recovery reclaim). Always re-reads
 * persisted `StepState` (never a stale in-memory snapshot) to derive the
 * reverse-ordered set of completed steps. Runs a real heartbeat for the
 * duration so the StaleRunSweeper does not race-kill an in-flight rollback.
 *
 * COMPENSATION SEMANTICS (documented):
 *   - Only steps with `status === 'done'` AND a registered `onCompensate`
 *     handler are compensated, in REVERSE completion order (reverse of the
 *     persisted `steps[]` array, which the engine appends/advances in
 *     execution order).
 *   - Steps left `waiting` / `running` at failure time are NOT compensated:
 *     they have no committed `done` output to roll back. (If such a step had
 *     an external side effect that needs undoing, the host must model it as a
 *     `done` step — a partially-applied `waiting`/`running` step is an
 *     incomplete effect, not a committed one.)
 *   - A step run multiple times via goto-loops appears ONCE in `steps[]` and
 *     is compensated exactly ONCE. If a step's effect is cumulative across
 *     loop iterations, a single compensation under-rolls-back — the host must
 *     make `onCompensate` idempotently undo the net effect (e.g. via the
 *     idempotency key + a host-side ledger).
 */
export async function driveCompensation<TContext>(
  engine: SagaEngine<TContext>,
  runId: string,
  token: string,
): Promise<WorkflowRun<TContext>> {
  const compensationHandlers = engine.options.compensationHandlers ?? {};
  const owned = ownedWalk(runId, token);

  // Owned heartbeat for the duration of the rollback, so a long compensation
  // is not reclaimed as stale. When it matches nothing, this walk was
  // cancelled (any process) or superseded by recovery: abort `ctx.signal` so
  // the handler can stop, and the walk stops claiming further steps.
  const abortController = new AbortController();
  const untrack = engine.trackAbort(runId, abortController);
  const heartbeatTimer = setInterval(() => {
    engine.container.repository
      .updateOne(owned, { lastHeartbeat: new Date() }, { bypassTenant: true })
      .then((res) => {
        if (res.modifiedCount === 0 && !abortController.signal.aborted) {
          abortController.abort(new Error('Compensation no longer owned (cancelled or recovered)'));
        }
      })
      .catch(() => {
        // ignore — the stale threshold is far longer than the interval
      });
  }, TIMING.HEARTBEAT_INTERVAL_MS);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  try {
    // FRESH read of persisted state — derive the reverse-ordered completed
    // step list from the database, not an in-memory snapshot (correct on
    // both the inline and the crash-recovery path).
    const fresh = await engine.get(runId);
    if (!fresh) return (await engine.get(runId)) ?? ({} as WorkflowRun<TContext>);

    const toCompensate = fresh.steps
      .filter((s) => s.status === 'done' && compensationHandlers[s.stepId])
      .reverse();

    // Emit once (idempotent on recovery — purely advisory).
    engine.container.eventBus.emit('workflow:compensating', {
      runId,
      data: { steps: toCompensate.map((s) => s.stepId) },
    });

    let anyFailed = false;

    for (const stepState of toCompensate) {
      // Skip steps already compensated (effectively-once on re-entry).
      if (stepState.compensation?.status === 'done') continue;
      // Cancelled or superseded: stop. Cancellation does NOT roll back
      // compensations that already ran (documented).
      if (abortController.signal.aborted) break;

      const handler = compensationHandlers[stepState.stepId];
      if (!handler) continue;

      const outcome = await compensateOneStep(
        engine,
        runId,
        token,
        stepState,
        handler,
        abortController,
      );
      if (outcome === 'stopped') break;
      if (outcome === 'failed') anyFailed = true;
    }

    // Terminal transition: compensating → compensated | compensation_failed,
    // only by the owner. A cancelled or superseded walk matches nothing here
    // and returns the persisted state; the new owner settles the run.
    const target: 'compensated' | 'compensation_failed' = anyFailed
      ? 'compensation_failed'
      : 'compensated';
    const settled = abortController.signal.aborted
      ? null
      : await assertAndClaim(RUN_MACHINE, engine.container.repository, runId, {
          from: 'compensating',
          to: target,
          where: { compensationAttemptId: token },
          patch: {
            $set: { endedAt: new Date(), updatedAt: new Date() },
            $unset: { compensationAttemptId: '' },
          },
          options: { bypassTenant: true },
        });

    engine.container.cache.delete(runId);

    if (settled) {
      engine.container.eventBus.emit(
        target === 'compensated' ? 'workflow:compensated' : 'workflow:compensation_failed',
        { runId },
      );
    }

    return (await engine.get(runId)) ?? fresh;
  } finally {
    clearInterval(heartbeatTimer);
    untrack();
  }
}

/** Filter every write of one compensation walk carries: still compensating, still ours. */
function ownedWalk(runId: string, token: string): Record<string, unknown> {
  return { _id: runId, status: 'compensating', compensationAttemptId: token };
}

/**
 * Compensate a single step with retry, then memoize the outcome DB-first via
 * a NUMERIC-INDEX guarded CAS (NOT mongokit claim() — it cannot forward
 * arrayFilters).
 *
 * Every write is owned by this walk (`compensationAttemptId`), so after a
 * cancel or a recovery reclaim none of them land: `'stopped'` tells the walk
 * to stop. Attempts are PERSISTED per try, so a crash mid-retry resumes the
 * budget instead of restarting it. Defaults follow the documented contract:
 * 3 attempts, 1000ms base delay, exponential backoff; `compensateTimeout`
 * bounds one attempt (it aborts `ctx.signal` and counts as a failed try).
 *
 * Delivery is at-least-once: a crash after the handler's side effect but
 * before the done flip re-runs it. Pass `ctx.idempotencyKey('compensate')` to
 * external providers.
 */
export async function compensateOneStep<TContext>(
  engine: SagaEngine<TContext>,
  runId: string,
  token: string,
  stepState: StepState,
  handler: WorkflowHandlers<unknown>[string],
  abortController: AbortController,
): Promise<'done' | 'failed' | 'stopped'> {
  const cfg = engine.options.compensationConfigs?.[stepState.stepId];
  const maxAttempts = Math.max(1, cfg?.retries ?? COMPENSATION_DEFAULTS.retries);
  const baseDelay = cfg?.retryDelay ?? COMPENSATION_DEFAULTS.retryDelay;
  const multiplier = resolveBackoffMultiplier(cfg?.retryBackoff, TIMING.RETRY_MULTIPLIER);
  const owned = ownedWalk(runId, token);

  // Re-read the freshest run for the ctx (context/output the handler reads).
  const run = (await engine.get(runId)) ?? null;
  if (!run) return 'stopped';
  const stepIndex = run.steps.findIndex((s) => s.stepId === stepState.stepId);
  if (stepIndex === -1) return 'failed';

  // Owned "begin" write BEFORE the handler: marks the compensation pending on
  // first entry (a touch on re-entry). Matching nothing means the walk was
  // cancelled or superseded — stop before running another side effect.
  const begun = await engine.container.repository.updateOne(
    owned,
    run.steps[stepIndex]?.compensation
      ? { $set: { updatedAt: new Date() } }
      : {
          $set: {
            [`steps.${stepIndex}.compensation`]: {
              status: 'pending',
              attempts: 0,
              startedAt: new Date(),
            },
            updatedAt: new Date(),
          },
        },
    { bypassTenant: true },
  );
  if (begun.modifiedCount === 0) return 'stopped';

  const prior = run.steps[stepIndex]?.compensation;
  // A previous walker already exhausted this step and recorded it — the
  // outcome is settled; only the run-level settle was lost.
  if (prior?.status === 'failed') return 'failed';

  const statusPath = `steps.${stepIndex}.compensation.status`;
  const attemptsPath = `steps.${stepIndex}.compensation.attempts`;
  let lastError: Error | undefined = prior?.error ? new Error(prior.error.message) : undefined;

  // Resume the persisted budget: a crash mid-retry must not hand the step a
  // fresh set of attempts.
  for (let attempt = (prior?.attempts ?? 0) + 1; attempt <= maxAttempts; attempt++) {
    if (abortController.signal.aborted) return 'stopped';

    // Per-attempt signal: aborted by the walk (cancel/superseded) or by this
    // attempt's timeout — a timeout must not stop the whole walk.
    const attemptCtl = new AbortController();
    const relay = () => attemptCtl.abort(abortController.signal.reason);
    abortController.signal.addEventListener('abort', relay, { once: true });
    let timer: NodeJS.Timeout | undefined;

    try {
      const ctx = new StepContextImpl(
        runId,
        stepState.stepId,
        run.context,
        run.input,
        attempt,
        run,
        engine.container.repository,
        engine.container.eventBus,
        attemptCtl.signal,
        engine.container.signalStore,
        engine.options.maxStepLogs,
        engine.options.maxPayloadBytes,
        undefined,
        // ctx writes (set/checkpoint/heartbeat) are owned by this walk too.
        { status: 'compensating', compensationAttemptId: token },
      );

      const handlerRun = Promise.resolve((handler as (ctx: unknown) => Promise<unknown>)(ctx));
      const output = await (cfg?.timeout
        ? Promise.race([
            handlerRun,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const err = new Error(`Compensation timeout after ${cfg.timeout}ms`);
                attemptCtl.abort(err);
                reject(err);
              }, cfg.timeout);
            }),
          ])
        : handlerRun);

      // RUNTIME GUARD: a compensation handler must not suspend. If a
      // WaitSignal / GotoSignal escapes, fail the compensation rather than
      // hang (the define-time static scan is best-effort).
      if (output instanceof WaitSignal || output instanceof GotoSignal) {
        throw new SuspendInCompensationError(stepState.stepId);
      }

      // Success → memoize pending→done, owned. Matching nothing means the walk
      // lost ownership while the handler ran: the effect happened, but the new
      // owner decides (it re-runs this step — at-least-once, documented).
      const flipped = await engine.container.repository.updateOne(
        { ...owned, [statusPath]: 'pending' },
        {
          $set: {
            [statusPath]: 'done',
            [`steps.${stepIndex}.compensation.completedAt`]: new Date(),
            updatedAt: new Date(),
          },
          $inc: { [attemptsPath]: 1 },
        },
        { bypassTenant: true },
      );
      engine.container.cache.delete(runId);
      if (flipped.modifiedCount === 0) return 'stopped';

      engine.container.eventBus.emit('step:compensated', {
        runId,
        stepId: stepState.stepId,
      });
      return 'done';
    } catch (err) {
      if (abortController.signal.aborted) return 'stopped';
      const suspended =
        err instanceof SuspendInCompensationError ||
        err instanceof WaitSignal ||
        err instanceof GotoSignal;
      lastError = suspended ? new SuspendInCompensationError(stepState.stepId) : toError(err);
      engine.container.eventBus.emit('engine:error', {
        runId,
        error: lastError,
        context: `compensation-${stepState.stepId}`,
      });

      // Persist the spent attempt before waiting — the budget survives a crash.
      const recorded = await engine.container.repository.updateOne(
        owned,
        {
          $set: {
            [`steps.${stepIndex}.compensation.error`]: { message: lastError.message },
            updatedAt: new Date(),
          },
          $inc: { [attemptsPath]: 1 },
        },
        { bypassTenant: true },
      );
      if (recorded.modifiedCount === 0) return 'stopped';
      if (suspended) break; // non-retriable

      if (attempt < maxAttempts && baseDelay > 0) {
        const delay = calculateRetryDelay(
          baseDelay,
          attempt - 1,
          multiplier,
          TIMING.MAX_RETRY_DELAY_MS,
          0,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      if (timer) clearTimeout(timer);
      abortController.signal.removeEventListener('abort', relay);
    }
  }

  // Exhausted (or non-retriable) → record the failed outcome, owned.
  const failed = await engine.container.repository.updateOne(
    owned,
    {
      $set: {
        [statusPath]: 'failed',
        [`steps.${stepIndex}.compensation.error`]: {
          message: lastError?.message ?? 'compensation failed',
        },
        updatedAt: new Date(),
      },
    },
    { bypassTenant: true },
  );
  engine.container.cache.delete(runId);
  return failed.modifiedCount === 0 ? 'stopped' : 'failed';
}

/** Documented `compensateRetries` / `compensateRetryDelay` defaults. */
const COMPENSATION_DEFAULTS = { retries: 3, retryDelay: 1000 } as const;

/** A compensation handler tried to wait/goto — never retried. */
class SuspendInCompensationError extends Error {
  constructor(stepId: string) {
    super(
      `Compensation handler for step "${stepId}" attempted to suspend — ` +
        `compensation must be non-suspending`,
    );
    this.name = 'SuspendInCompensationError';
  }
}
