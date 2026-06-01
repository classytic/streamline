import { assertAndClaim } from '@classytic/primitives/state-machine';
import { TIMING } from '../config/constants.js';
import type { StreamlineContainer } from '../core/container.js';
import { RUN_MACHINE } from '../core/status.js';
import type { StepState, WorkflowHandlers, WorkflowRun } from '../core/types.js';
import { toError } from '../utils/errors.js';
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
  const now = new Date();

  // FIRST durable action: failed → compensating. assertAndClaim runs the
  // sync state-machine assertion then an atomic CAS; null = another worker
  // already entered (multi-worker entry race resolves to one winner). The
  // loser returns the current state and does NOT build a (possibly stale)
  // compensation list.
  const claimed = await assertAndClaim(RUN_MACHINE, engine.container.repository, runId, {
    from: 'failed',
    to: 'compensating',
    patch: { lastHeartbeat: now, updatedAt: now },
    options: { bypassTenant: true },
  });

  if (!claimed) {
    // Lost the entry race (or run already past `failed`). Return current
    // persisted state; the winner (or a recovery sweep) drives compensation.
    engine.container.cache.delete(runId);
    return (await engine.get(runId)) ?? run;
  }

  engine.container.cache.delete(runId);
  return driveCompensation(engine, runId);
}

/**
 * Crash-recovery entrypoint for a run left in `compensating` after a process
 * died mid-rollback. Reclaims via a stale-heartbeat-guarded CAS
 * (compensating → compensating, so only a genuinely-stale run is reclaimed —
 * a live compensation heartbeats and won't match) and re-drives the walk.
 * The walk skips per-step compensations already `done` (effectively-once),
 * so step N+1 isn't compensated twice.
 *
 * Wired into the scheduler's poll via `getStaleCompensatingRuns`.
 */
export async function recoverCompensation<TContext>(
  engine: SagaEngine<TContext>,
  runId: string,
  staleThresholdMs: number,
): Promise<WorkflowRun<TContext> | null> {
  const staleTime = new Date(Date.now() - staleThresholdMs);
  const claimed = await engine.container.repository.claim(
    runId,
    {
      from: 'compensating',
      to: 'compensating',
      where: {
        $or: [{ lastHeartbeat: { $lt: staleTime } }, { lastHeartbeat: { $exists: false } }],
      },
    },
    {
      $set: { lastHeartbeat: new Date(), updatedAt: new Date() },
      $inc: { recoveryAttempts: 1 },
    },
    { bypassTenant: true },
  );

  if (!claimed) return null; // live compensation or already settled — not ours

  engine.container.cache.delete(runId);
  engine.container.eventBus.emit('workflow:recovered', { runId });
  return driveCompensation(engine, runId);
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
): Promise<WorkflowRun<TContext>> {
  const compensationHandlers = engine.options.compensationHandlers ?? {};

  // Real heartbeat for the duration of the rollback so a long compensation
  // is not marked stale by markStaleAsFailed mid-flight. The AbortController
  // is wired into each compensation ctx so a cancel/timeout aborts cleanly.
  const abortController = new AbortController();
  const heartbeatTimer = setInterval(() => {
    engine.container.repository
      .updateOne({ _id: runId }, { lastHeartbeat: new Date() }, { bypassTenant: true })
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

      // Honor cancel mid-compensation: a CANCELLED_GUARD on the per-step
      // write would reject anyway, but short-circuit early. Cancellation
      // does NOT roll back already-run compensations (documented).
      const reread = await engine.get(runId);
      if (reread && reread.status !== 'compensating') {
        // Cancelled or otherwise transitioned out — stop driving.
        return reread;
      }

      const handler = compensationHandlers[stepState.stepId];
      if (!handler) continue;

      const ok = await compensateOneStep(engine, runId, stepState, handler, abortController);
      if (!ok) anyFailed = true;
    }

    // Terminal transition: compensating → compensated | compensation_failed.
    const target: 'compensated' | 'compensation_failed' = anyFailed
      ? 'compensation_failed'
      : 'compensated';
    const settled = await assertAndClaim(RUN_MACHINE, engine.container.repository, runId, {
      from: 'compensating',
      to: target,
      patch: { endedAt: new Date(), updatedAt: new Date() },
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
  }
}

/**
 * Compensate a single step with retry, then memoize the outcome DB-first via
 * a NUMERIC-INDEX guarded CAS (NOT mongokit claim() — it cannot forward
 * arrayFilters). Returns true on success (or already-done), false if the
 * handler exhausted retries / threw fatally.
 *
 * The pending→done flip is written AFTER the handler resolves and guarded on
 * `status:'compensating'` + `steps.<i>.compensation.status:'pending'` so a
 * concurrent recovery (or a re-entry) cannot double-flip — the second writer
 * gets modifiedCount:0 and treats it as already-done.
 */
export async function compensateOneStep<TContext>(
  engine: SagaEngine<TContext>,
  runId: string,
  stepState: StepState,
  handler: WorkflowHandlers<unknown>[string],
  abortController: AbortController,
): Promise<boolean> {
  const cfg = engine.options.compensationConfigs?.[stepState.stepId];
  const maxAttempts = Math.max(1, cfg?.retries ?? 1);
  const baseDelay = cfg?.retryDelay ?? 0;

  // Re-read the freshest run for the ctx (context/output the handler reads).
  const run = (await engine.get(runId)) ?? null;
  if (!run) return false;
  const stepIndex = run.steps.findIndex((s) => s.stepId === stepState.stepId);
  if (stepIndex === -1) return false;

  // Mark compensation pending + startedAt (idempotent — only sets if absent).
  if (!run.steps[stepIndex]?.compensation) {
    await engine.container.repository.updateOne(
      { _id: runId, status: 'compensating' },
      {
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
  }

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ctx = new StepContextImpl(
        runId,
        stepState.stepId,
        run.context,
        run.input,
        stepState.attempts,
        run,
        engine.container.repository,
        engine.container.eventBus,
        abortController.signal,
        engine.container.signalStore,
      );

      const result = (handler as (ctx: unknown) => Promise<unknown>)(ctx);

      // RUNTIME GUARD: a compensation handler must not suspend. If a
      // WaitSignal / GotoSignal escapes, fail the compensation rather than
      // hang (the define-time static scan is best-effort).
      const output = await result;
      if (output instanceof WaitSignal || output instanceof GotoSignal) {
        throw new Error(
          `Compensation handler for step "${stepState.stepId}" attempted to suspend — ` +
            `compensation must be non-suspending`,
        );
      }

      // Success → memoize pending→done via numeric-index guarded CAS.
      const res = await engine.container.repository.updateOne(
        {
          _id: runId,
          status: 'compensating',
          [`steps.${stepIndex}.compensation.status`]: 'pending',
        },
        {
          $set: {
            [`steps.${stepIndex}.compensation.status`]: 'done',
            [`steps.${stepIndex}.compensation.completedAt`]: new Date(),
            updatedAt: new Date(),
          },
          $inc: { [`steps.${stepIndex}.compensation.attempts`]: 1 },
        },
        { bypassTenant: true },
      );

      // modifiedCount:0 → a concurrent writer already flipped it to done, or
      // the run left `compensating` (cancel). Treat as success (idempotent).
      engine.container.cache.delete(runId);
      engine.container.eventBus.emit('step:compensated', {
        runId,
        stepId: stepState.stepId,
      });
      void res;
      return true;
    } catch (err) {
      const e = err as Error;
      // A WaitSignal/GotoSignal thrown synchronously also lands here.
      if (e instanceof WaitSignal || e instanceof GotoSignal) {
        lastError = new Error(
          `Compensation handler for step "${stepState.stepId}" attempted to suspend — ` +
            `compensation must be non-suspending`,
        );
        break; // non-retriable
      }
      lastError = e;
      engine.container.eventBus.emit('engine:error', {
        runId,
        error: toError(err),
        context: `compensation-${stepState.stepId}`,
      });
      if (attempt < maxAttempts && baseDelay > 0) {
        const mult = cfg?.retryBackoff === 'exponential' ? 2 ** (attempt - 1) : 1;
        await new Promise((r) => setTimeout(r, baseDelay * mult));
      }
    }
  }

  // Exhausted retries → record failed compensation status.
  await engine.container.repository.updateOne(
    { _id: runId, status: 'compensating' },
    {
      $set: {
        [`steps.${stepIndex}.compensation.status`]: 'failed',
        [`steps.${stepIndex}.compensation.error`]: {
          message: lastError?.message ?? 'compensation failed',
        },
        updatedAt: new Date(),
      },
      $inc: { [`steps.${stepIndex}.compensation.attempts`]: 1 },
    },
    { bypassTenant: true },
  );
  engine.container.cache.delete(runId);
  return false;
}
