/**
 * Durable-saga compensation correctness matrix (v2.4).
 *
 * PROVES — does not implement — the documented semantics of
 * `src/execution/saga.ts`:
 *   - `runCompensation`  — failed → compensating via assertAndClaim (first
 *     durable action), multi-worker entry resolves to one winner.
 *   - `recoverCompensation` — stale-heartbeat-guarded reclaim of a crashed
 *     `compensating` run; a FRESH heartbeat (live rollback) is NOT reclaimed.
 *   - `driveCompensation` — reverse-order walk derived from a FRESH read of
 *     persisted StepState; only `done` steps WITH a handler; skip-if-done.
 *   - `compensateOneStep` — retry + numeric-index guarded pending→done CAS +
 *     non-suspending runtime guard.
 *
 * Crash simulation follows `child-workflow-reconciliation.test.ts`: persist the
 * post-crash DB shape directly (a `compensating` run with a stale heartbeat and
 * some per-step compensations already `done`), then invoke the recovery path
 * (`engine.recoverCompensation`, the same verb the scheduler poll calls) on a
 * fresh engine that has no in-memory listeners.
 *
 * Determinism: no real timers are relied on. `driveCompensation`'s real
 * heartbeat fires on a 30s interval (TIMING.HEARTBEAT_INTERVAL_MS), far beyond
 * any test's lifetime, so it never perturbs assertions. Recovery uses an
 * explicit `staleThresholdMs` and a hand-set `lastHeartbeat` to make the
 * stale-vs-live decision deterministic without waiting on wall-clock.
 */

import { describe, expect, it } from 'vitest';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import { runCompensation } from '../../src/execution/saga.js';
import type { WorkflowRef } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/**
 * Persist a `compensating` (or `failed`) run directly — the crash/entry DB
 * shape. Steps are given explicitly in execution order (the array the engine
 * appends to), with optional per-step `compensation` records to simulate
 * "already compensated" on the crash path. Returns the run id.
 */
async function persistRun(
  wf: WorkflowRef,
  opts: {
    status: WorkflowRun['status'];
    steps: Array<{
      stepId: string;
      status: StepState['status'];
      output?: unknown;
      compensation?: StepState['compensation'];
    }>;
    lastHeartbeat?: Date;
  },
): Promise<string> {
  const now = new Date();
  const steps: StepState[] = opts.steps.map((s) => ({
    stepId: s.stepId,
    status: s.status,
    attempts: 1,
    startedAt: now,
    ...(s.output !== undefined ? { output: s.output } : {}),
    ...(s.compensation ? { compensation: s.compensation } : {}),
  }));

  const run = await env.runs.insert(wf, {
    status: opts.status,
    steps,
    currentStepId: opts.steps.at(-1)?.stepId ?? null,
    startedAt: now,
    ...(opts.lastHeartbeat ? { lastHeartbeat: opts.lastHeartbeat } : {}),
  });
  return run._id;
}

// ============================================================================
// 1. Happy path — no compensation on success.
// ============================================================================

describe('saga compensation matrix', () => {
  it('[1] happy path: all steps succeed → done, NO compensation runs', async () => {
    const compensated: string[] = [];
    const wf = env.workflow('happy', {
      steps: {
        a: { handler: async () => 'a', onCompensate: async () => void compensated.push('a') },
        b: { handler: async () => 'b', onCompensate: async () => void compensated.push('b') },
        c: { handler: async () => 'c', onCompensate: async () => void compensated.push('c') },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(compensated).toEqual([]); // compensation only fires on failure
  });

  // ==========================================================================
  // 2. Reverse-order compensation (A→B→C, C fails) → compensated, B then A.
  // ==========================================================================

  it('[2] C fails → A & B compensate in REVERSE order (B, then A); terminal compensated', async () => {
    const order: string[] = [];
    const events: string[] = [];
    const onCompensated = (p: { stepId?: unknown }) => events.push(p.stepId as string);
    env.container.eventBus.on('step:compensated', onCompensated);

    try {
      const wf = env.workflow('reverse', {
        steps: {
          a: { handler: async () => 'A', onCompensate: async () => void order.push('a') },
          b: { handler: async () => 'B', onCompensate: async () => void order.push('b') },
          c: {
            handler: async () => {
              throw new Error('C exploded');
            },
            retries: 1,
            onCompensate: async () => void order.push('c-should-not-run'),
          },
        },
      });

      const run = await wf.start({});
      const result = await wf.execute(run._id);

      expect(result.status).toBe('compensated');
      // Reverse of completion order [a, b] → [b, a]. c never completed → not run.
      expect(order).toEqual(['b', 'a']);
      expect(events).toEqual(['b', 'a']);

      // Per-step compensation memoization landed for the two done steps.
      const persisted = await wf.get(run._id);
      const byId = Object.fromEntries((persisted?.steps ?? []).map((s) => [s.stepId, s]));
      expect(byId.a?.compensation?.status).toBe('done');
      expect(byId.b?.compensation?.status).toBe('done');
      expect(byId.c?.compensation).toBeUndefined(); // failed step never compensated
    } finally {
      env.container.eventBus.off('step:compensated', onCompensated);
    }
  });

  // ==========================================================================
  // 3. Only `done` steps WITH a handler compensate.
  //    - a step left waiting/running at failure time is NOT compensated;
  //    - a done step WITHOUT onCompensate is skipped.
  // ==========================================================================

  it('[3] only done steps with handlers compensate (no-handler done step skipped; non-done skipped)', async () => {
    const compensated: string[] = [];

    // Build the engine so we can drive compensation from a hand-persisted
    // run shape that includes a `running` (incomplete) step at failure time.
    const wf = env.workflow('only-done', {
      steps: {
        withHandler: {
          handler: async () => 'x',
          onCompensate: async () => void compensated.push('withHandler'),
        },
        noHandler: { handler: async () => 'y' }, // done, but NO onCompensate
        leftRunning: {
          handler: async () => 'z',
          onCompensate: async () => void compensated.push('leftRunning-should-not-run'),
        },
        boom: {
          handler: async () => {
            throw new Error('boom');
          },
          retries: 1,
          onCompensate: async () => void compensated.push('boom-should-not-run'),
        },
      },
    });

    // Persist the failure-time shape directly: withHandler+noHandler done,
    // leftRunning still 'running' (incomplete effect), boom failed.
    const runId = await persistRun(wf, {
      status: 'failed',
      steps: [
        { stepId: 'withHandler', status: 'done', output: 'x' },
        { stepId: 'noHandler', status: 'done', output: 'y' },
        { stepId: 'leftRunning', status: 'running' },
        { stepId: 'boom', status: 'failed' },
      ],
    });

    const result = await wf.engine.execute(runId); // failed + handlers → compensation phase

    expect(result.status).toBe('compensated');
    // Only the done step WITH a handler ran. noHandler (no onCompensate) and
    // leftRunning (not done) were skipped; boom (failed) skipped.
    expect(compensated).toEqual(['withHandler']);
  });

  // ==========================================================================
  // 4. Crash mid-compensation → recovery (skip-if-done is idempotent).
  // ==========================================================================

  it('[4] crash mid-compensation: C already done → recovery compensates B & A only, terminal compensated', async () => {
    const compensated: string[] = [];

    // Fresh engine — NO in-memory state from a prior run (post-crash process).
    const wf = env.workflow('crash-recover', {
      steps: {
        a: { handler: async () => 'A', onCompensate: async () => void compensated.push('a') },
        b: { handler: async () => 'B', onCompensate: async () => void compensated.push('b') },
        c: { handler: async () => 'C', onCompensate: async () => void compensated.push('c') },
      },
    });

    // Post-crash shape: run is `compensating`, C's compensation ALREADY done,
    // heartbeat is stale. A & B not yet compensated.
    const runId = await persistRun(wf, {
      status: 'compensating',
      lastHeartbeat: new Date(Date.now() - 10 * 60_000), // 10 min ago — stale
      steps: [
        { stepId: 'a', status: 'done', output: 'A' },
        { stepId: 'b', status: 'done', output: 'B' },
        {
          stepId: 'c',
          status: 'done',
          output: 'C',
          compensation: { status: 'done', attempts: 1, completedAt: new Date() },
        },
      ],
    });

    // Recovery reclaims the stale `compensating` run and re-drives.
    const recovered = await wf.engine.recoverCompensation(runId, 60_000);

    expect(recovered?.status).toBe('compensated');
    // C is NOT compensated again (skip-if-done). B then A in reverse.
    expect(compensated).toEqual(['b', 'a']);

    const persisted = await wf.get(runId);
    const byId = Object.fromEntries((persisted?.steps ?? []).map((s) => [s.stepId, s]));
    expect(byId.a?.compensation?.status).toBe('done');
    expect(byId.b?.compensation?.status).toBe('done');
    expect(byId.c?.compensation?.attempts).toBe(1); // not re-incremented
  });

  // ==========================================================================
  // 5. Stale-vs-live recovery guard.
  // ==========================================================================

  it('[5] recovery reclaims a STALE compensating run but NOT a FRESH (live) one', async () => {
    const compensated: string[] = [];
    const wf = env.workflow('stale-vs-live', {
      steps: {
        a: { handler: async () => 'A', onCompensate: async () => void compensated.push('a') },
      },
    });

    // --- STALE run: heartbeat 10 min ago ---
    const staleId = await persistRun(wf, {
      status: 'compensating',
      lastHeartbeat: new Date(Date.now() - 10 * 60_000),
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });

    // --- LIVE run: heartbeat just now (a real rollback is heartbeating) ---
    const liveId = await persistRun(wf, {
      status: 'compensating',
      lastHeartbeat: new Date(), // fresh
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });

    const threshold = 60_000;

    // getStaleCompensatingRuns selects ONLY the stale one.
    const stale = await env.container.repository.getStaleCompensatingRuns(threshold, 100, {
      bypassTenant: true,
    });
    const staleIds = stale.map((r) => r._id);
    expect(staleIds).toContain(staleId);
    expect(staleIds).not.toContain(liveId);

    // recoverCompensation reclaims the stale one (non-null, drives to terminal).
    const staleResult = await wf.engine.recoverCompensation(staleId, threshold);
    expect(staleResult).not.toBeNull();
    expect(staleResult?.status).toBe('compensated');

    // recoverCompensation on the LIVE one is a no-op: the claim's
    // stale-heartbeat guard does NOT match a fresh heartbeat → returns null,
    // leaving the live run untouched in `compensating`.
    const liveResult = await wf.engine.recoverCompensation(liveId, threshold);
    expect(liveResult).toBeNull();
    const liveAfter = await wf.get(liveId);
    expect(liveAfter?.status).toBe('compensating'); // untouched by recovery
  });

  // ==========================================================================
  // 6. Multi-worker entry race — exactly one enters `compensating`.
  // ==========================================================================

  it('[6] two concurrent runCompensation on a fresh failed run → handlers run exactly once', async () => {
    let aCount = 0;
    let bCount = 0;
    const wf = env.workflow('race', {
      steps: {
        a: { handler: async () => 'A', onCompensate: async () => void aCount++ },
        b: { handler: async () => 'B', onCompensate: async () => void bCount++ },
        c: {
          handler: async () => {
            throw new Error('c');
          },
          retries: 1,
        },
      },
    });

    // Freshly-`failed` run with two done compensable steps.
    const runId = await persistRun(wf, {
      status: 'failed',
      steps: [
        { stepId: 'a', status: 'done', output: 'A' },
        { stepId: 'b', status: 'done', output: 'B' },
        { stepId: 'c', status: 'failed' },
      ],
    });

    const fresh = await wf.get(runId);
    expect(fresh).not.toBeNull();

    // Two workers race the SAME failed run. assertAndClaim makes exactly one
    // win the failed→compensating CAS. The WINNER drives the walk to a terminal
    // state. The LOSER is a no-op: its claim returns null, so it returns the
    // CURRENT persisted state WITHOUT building a (possibly stale) compensation
    // list and WITHOUT waiting for the winner (documented in saga.ts). So the
    // loser's returned status may be `compensating` (winner still driving) or
    // already `compensated` — what is NOT allowed is the loser re-running the
    // handlers. Exactly one of the two returns the winner's terminal walk.
    const [r1, r2] = await Promise.all([
      runCompensation(wf.engine, fresh as WorkflowRun),
      runCompensation(wf.engine, fresh as WorkflowRun),
    ]);

    // Exactly one returned the terminal `compensated`; the loser returned a
    // valid non-terminal/terminal snapshot but never re-ran handlers.
    const statuses = [r1.status, r2.status];
    expect(statuses).toContain('compensated');
    for (const s of statuses) expect(['compensating', 'compensated']).toContain(s);

    // THE load-bearing guarantee: each compensation handler ran EXACTLY once
    // total across both racing workers (no double-compensation).
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    // The run itself reached terminal `compensated`.
    const finalRun = await wf.get(runId);
    expect(finalRun?.status).toBe('compensated');
  });

  // ==========================================================================
  // 7. Compensation handler exhausts retries → compensation_failed.
  // ==========================================================================

  it('[7] always-throwing onCompensate with compensateRetries → retries N times, status failed, run compensation_failed', async () => {
    let attempts = 0;
    const wf = env.workflow('comp-retry', {
      steps: {
        a: {
          handler: async () => 'A',
          // 3 attempts, no delay (deterministic, no real timers).
          compensateRetries: 3,
          compensateRetryDelay: 0,
          onCompensate: async () => {
            attempts++;
            throw new Error('comp boom');
          },
        },
        b: {
          handler: async () => {
            throw new Error('b');
          },
          retries: 1,
        },
      },
    });

    const runId = await persistRun(wf, {
      status: 'failed',
      steps: [
        { stepId: 'a', status: 'done', output: 'A' },
        { stepId: 'b', status: 'failed' },
      ],
    });

    const result = await wf.engine.execute(runId);

    expect(attempts).toBe(3); // exactly compensateRetries attempts
    expect(result.status).toBe('compensation_failed'); // NOT compensated

    const persisted = await wf.get(runId);
    const stepA = persisted?.steps.find((s) => s.stepId === 'a');
    expect(stepA?.compensation?.status).toBe('failed');
    expect(stepA?.compensation?.error?.message).toContain('comp boom');
  });

  // ==========================================================================
  // 8. Idempotency CAS — second writer gets modifiedCount:0, no double-flip.
  // ==========================================================================

  it('[8] re-entrant compensation of an already-done step does not double-run the handler', async () => {
    let runs = 0;
    const wf = env.workflow('cas', {
      steps: {
        a: {
          handler: async () => 'A',
          onCompensate: async () => void runs++,
        },
      },
    });

    // Run #1: a fresh failed run → drive compensation once. Handler runs once,
    // step a's compensation flips pending→done.
    const runId = await persistRun(wf, {
      status: 'failed',
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });
    const first = await wf.engine.execute(runId);
    expect(first.status).toBe('compensated');
    expect(runs).toBe(1);

    // Re-entry: force the terminal run back to `compensating` (simulating a
    // recovery that re-drives) and invoke recovery again. The skip-if-done
    // guard + the numeric-index CAS (which would get modifiedCount:0 anyway)
    // mean the handler does NOT run a second time.
    await env.runs.update(runId, {
      status: 'compensating',
      lastHeartbeat: new Date(Date.now() - 10 * 60_000),
    });

    const second = await wf.engine.recoverCompensation(runId, 60_000);
    expect(second?.status).toBe('compensated');
    expect(runs).toBe(1); // handler side effect happened ONCE within the cluster
  });

  // ==========================================================================
  // 9. Non-suspending RUNTIME guard.
  //    The define-time static scan only matches literal `ctx.<prim>(` source,
  //    so we route the suspending call through an indirection to bypass the
  //    static check and exercise the RUNTIME guard in compensateOneStep.
  // ==========================================================================

  it('[9] onCompensate that suspends (via indirection) → that step fails with "non-suspending" error, run does not hang', async () => {
    // Indirection: a helper that closes over ctx and calls a suspending
    // primitive. The static SUSPENDING_PRIMITIVE_RE in define.ts matches
    // `ctx.sleep(` literally; passing ctx into a helper hides it, so define
    // does NOT throw and the RUNTIME guard is what we end up testing.
    const suspendVia = (c: { sleep: (ms: number) => Promise<void> }) => c.sleep(1000);

    const wf = env.workflow('suspend', {
      steps: {
        a: {
          handler: async () => 'A',
          compensateRetryDelay: 0,
          onCompensate: async (ctx) => {
            await suspendVia(ctx as unknown as { sleep: (ms: number) => Promise<void> });
          },
        },
        b: {
          handler: async () => {
            throw new Error('b');
          },
          retries: 1,
        },
      },
    });

    const runId = await persistRun(wf, {
      status: 'failed',
      steps: [
        { stepId: 'a', status: 'done', output: 'A' },
        { stepId: 'b', status: 'failed' },
      ],
    });

    // Must terminate (not hang). The suspending compensation is rejected.
    const result = await wf.engine.execute(runId);

    expect(result.status).toBe('compensation_failed');
    const stepA = result.steps.find((s) => s.stepId === 'a');
    expect(stepA?.compensation?.status).toBe('failed');
    expect(stepA?.compensation?.error?.message).toContain('non-suspending');
  });

  // ==========================================================================
  // 10. External effective-once doc check: ctx.idempotencyKey('compensate')
  //     is attempt-invariant (stable across a simulated retry).
  // ==========================================================================

  it('[10] ctx.idempotencyKey("compensate") is stable across compensation retries (external effective-once)', async () => {
    const keys: string[] = [];
    let attempt = 0;
    const wf = env.workflow('idem-key', {
      steps: {
        charge: {
          handler: async () => ({ chargeId: 'ch_1' }),
          compensateRetries: 3,
          compensateRetryDelay: 0,
          onCompensate: async (ctx) => {
            // The host would pass this key to the provider's Idempotency-Key
            // so a re-issued refund dedupes instead of double-refunding.
            keys.push(ctx.idempotencyKey('compensate'));
            attempt++;
            // Throw on the first two attempts to force two retries, proving
            // the key is identical on every attempt (attempt-invariant).
            if (attempt < 3) throw new Error('transient refund failure');
          },
        },
        boom: {
          handler: async () => {
            throw new Error('boom');
          },
          retries: 1,
        },
      },
    });

    const runId = await persistRun(wf, {
      status: 'failed',
      steps: [
        { stepId: 'charge', status: 'done', output: { chargeId: 'ch_1' } },
        { stepId: 'boom', status: 'failed' },
      ],
    });

    const result = await wf.engine.execute(runId);

    // Succeeds on the 3rd attempt → run compensated.
    expect(result.status).toBe('compensated');
    expect(keys).toHaveLength(3);
    // Attempt-invariant: same key every retry, equal to `${runId}:charge:compensate`.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`${runId}:charge:compensate`);
  });

  // A sanity assertion that the recovery path is also reachable through the
  // scheduler's documented query (defense for scenario 4/5 wiring): a stale
  // compensating run is visible to getStaleCompensatingRuns.
  it('[guard] getStaleCompensatingRuns matches a stale compensating run', async () => {
    const runId = await persistRun('guard', {
      status: 'compensating',
      lastHeartbeat: new Date(Date.now() - 10 * 60_000),
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });
    // The run is written before the query — visible on the first read, no polling.
    const rows = await env.container.repository.getStaleCompensatingRuns(60_000, 100, {
      bypassTenant: true,
    });
    expect(rows.map((r) => r._id)).toContain(runId);
  });
});
