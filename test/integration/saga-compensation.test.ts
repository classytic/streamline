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

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createContainer, createWorkflow, WorkflowRunModel } from '../../src/index.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { runCompensation } from '../../src/execution/saga.js';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import { cleanupTestDB, setupTestDB, teardownTestDB, waitUntil } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

let wfCounter = 0;
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${++wfCounter}`;

/**
 * Persist a `compensating` (or `failed`) run directly — the crash/entry DB
 * shape. Steps are seeded as `done` (compensable), with optional per-step
 * `compensation` records to simulate "already compensated" on the crash path.
 */
async function persistRun(opts: {
  runId: string;
  workflowId: string;
  status: WorkflowRun['status'];
  /** Ordered step states (execution order — the array the engine appends to). */
  steps: Array<{
    stepId: string;
    status: StepState['status'];
    output?: unknown;
    compensation?: StepState['compensation'];
  }>;
  lastHeartbeat?: Date;
  context?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const steps: StepState[] = opts.steps.map((s) => ({
    stepId: s.stepId,
    status: s.status,
    attempts: 1,
    startedAt: now,
    ...(s.output !== undefined ? { output: s.output } : {}),
    ...(s.compensation ? { compensation: s.compensation } : {}),
  })) as StepState[];

  await WorkflowRunModel.create({
    _id: opts.runId,
    workflowId: opts.workflowId,
    status: opts.status,
    steps,
    currentStepId: opts.steps.at(-1)?.stepId ?? null,
    context: opts.context ?? {},
    input: {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    ...(opts.lastHeartbeat ? { lastHeartbeat: opts.lastHeartbeat } : {}),
  } as unknown as WorkflowRun);
}

// ============================================================================
// 1. Happy path — no compensation on success.
// ============================================================================

describe('saga compensation matrix', () => {
  it('[1] happy path: all steps succeed → done, NO compensation runs', async () => {
    const compensated: string[] = [];
    const wf = createWorkflow(uniqueId('happy'), {
      steps: {
        a: { handler: async () => 'a', onCompensate: async () => void compensated.push('a') },
        b: { handler: async () => 'b', onCompensate: async () => void compensated.push('b') },
        c: { handler: async () => 'c', onCompensate: async () => void compensated.push('c') },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(compensated).toEqual([]); // compensation only fires on failure
    wf.shutdown();
  });

  // ==========================================================================
  // 2. Reverse-order compensation (A→B→C, C fails) → compensated, B then A.
  // ==========================================================================

  it('[2] C fails → A & B compensate in REVERSE order (B, then A); terminal compensated', async () => {
    const order: string[] = [];
    const events: string[] = [];
    const container = createContainer();
    container.eventBus.on('step:compensated', (p) => events.push(p.stepId as string));

    const wf = createWorkflow(uniqueId('reverse'), {
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
      container,
      autoExecute: false,
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
    wf.shutdown();
  });

  // ==========================================================================
  // 3. Only `done` steps WITH a handler compensate.
  //    - a step left waiting/running at failure time is NOT compensated;
  //    - a done step WITHOUT onCompensate is skipped.
  // ==========================================================================

  it('[3] only done steps with handlers compensate (no-handler done step skipped; non-done skipped)', async () => {
    const compensated: string[] = [];
    const wfId = uniqueId('only-done');

    // Build the engine so we can drive compensation from a hand-persisted
    // run shape that includes a `running` (incomplete) step at failure time.
    const wf = createWorkflow(wfId, {
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
      autoExecute: false,
    });

    // Persist the failure-time shape directly: withHandler+noHandler done,
    // leftRunning still 'running' (incomplete effect), boom failed.
    const runId = uniqueId('only-done-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    wf.shutdown();
  });

  // ==========================================================================
  // 4. Crash mid-compensation → recovery (skip-if-done is idempotent).
  // ==========================================================================

  it('[4] crash mid-compensation: C already done → recovery compensates B & A only, terminal compensated', async () => {
    const compensated: string[] = [];
    const wfId = uniqueId('crash-recover');

    // Fresh engine — NO in-memory state from a prior run (post-crash process).
    const wf = createWorkflow(wfId, {
      steps: {
        a: { handler: async () => 'A', onCompensate: async () => void compensated.push('a') },
        b: { handler: async () => 'B', onCompensate: async () => void compensated.push('b') },
        c: { handler: async () => 'C', onCompensate: async () => void compensated.push('c') },
      },
      autoExecute: false,
    });

    // Post-crash shape: run is `compensating`, C's compensation ALREADY done,
    // heartbeat is stale. A & B not yet compensated.
    const runId = uniqueId('crash-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    wf.shutdown();
  });

  // ==========================================================================
  // 5. Stale-vs-live recovery guard.
  // ==========================================================================

  it('[5] recovery reclaims a STALE compensating run but NOT a FRESH (live) one', async () => {
    const wfId = uniqueId('stale-vs-live');
    const compensated: string[] = [];
    const wf = createWorkflow(wfId, {
      steps: {
        a: { handler: async () => 'A', onCompensate: async () => void compensated.push('a') },
      },
      autoExecute: false,
    });

    // --- STALE run: heartbeat 10 min ago ---
    const staleId = uniqueId('stale-run');
    await persistRun({
      runId: staleId,
      workflowId: wfId,
      status: 'compensating',
      lastHeartbeat: new Date(Date.now() - 10 * 60_000),
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });

    // --- LIVE run: heartbeat just now (a real rollback is heartbeating) ---
    const liveId = uniqueId('live-run');
    await persistRun({
      runId: liveId,
      workflowId: wfId,
      status: 'compensating',
      lastHeartbeat: new Date(), // fresh
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });

    const threshold = 60_000;

    // getStaleCompensatingRuns selects ONLY the stale one.
    const stale = await workflowRunRepository.getStaleCompensatingRuns(threshold, 100, {
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
    wf.shutdown();
  });

  // ==========================================================================
  // 6. Multi-worker entry race — exactly one enters `compensating`.
  // ==========================================================================

  it('[6] two concurrent runCompensation on a fresh failed run → handlers run exactly once', async () => {
    const wfId = uniqueId('race');
    let aCount = 0;
    let bCount = 0;
    const wf = createWorkflow(wfId, {
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
      autoExecute: false,
    });

    // Freshly-`failed` run with two done compensable steps.
    const runId = uniqueId('race-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    statuses.forEach((s) => expect(['compensating', 'compensated']).toContain(s));

    // THE load-bearing guarantee: each compensation handler ran EXACTLY once
    // total across both racing workers (no double-compensation).
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    // The run itself reached terminal `compensated`.
    const finalRun = await wf.get(runId);
    expect(finalRun?.status).toBe('compensated');
    wf.shutdown();
  });

  // ==========================================================================
  // 7. Compensation handler exhausts retries → compensation_failed.
  // ==========================================================================

  it('[7] always-throwing onCompensate with compensateRetries → retries N times, status failed, run compensation_failed', async () => {
    const wfId = uniqueId('comp-retry');
    let attempts = 0;
    const wf = createWorkflow(wfId, {
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
      container: createContainer(),
      autoExecute: false,
    });

    const runId = uniqueId('comp-retry-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    wf.shutdown();
  });

  // ==========================================================================
  // 8. Idempotency CAS — second writer gets modifiedCount:0, no double-flip.
  // ==========================================================================

  it('[8] re-entrant compensation of an already-done step does not double-run the handler', async () => {
    const wfId = uniqueId('cas');
    let runs = 0;
    const wf = createWorkflow(wfId, {
      steps: {
        a: {
          handler: async () => 'A',
          onCompensate: async () => void runs++,
        },
      },
      autoExecute: false,
    });

    // Run #1: a fresh failed run → drive compensation once. Handler runs once,
    // step a's compensation flips pending→done.
    const runId = uniqueId('cas-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    await WorkflowRunModel.updateOne(
      { _id: runId },
      { $set: { status: 'compensating', lastHeartbeat: new Date(Date.now() - 10 * 60_000) } },
    );
    wf.container.cache.delete(runId);

    const second = await wf.engine.recoverCompensation(runId, 60_000);
    expect(second?.status).toBe('compensated');
    expect(runs).toBe(1); // handler side effect happened ONCE within the cluster
    wf.shutdown();
  });

  // ==========================================================================
  // 9. Non-suspending RUNTIME guard.
  //    The define-time static scan only matches literal `ctx.<prim>(` source,
  //    so we route the suspending call through an indirection to bypass the
  //    static check and exercise the RUNTIME guard in compensateOneStep.
  // ==========================================================================

  it('[9] onCompensate that suspends (via indirection) → that step fails with "non-suspending" error, run does not hang', async () => {
    const wfId = uniqueId('suspend');

    // Indirection: a helper that closes over ctx and calls a suspending
    // primitive. The static SUSPENDING_PRIMITIVE_RE in define.ts matches
    // `ctx.sleep(` literally; passing ctx into a helper hides it, so define
    // does NOT throw and the RUNTIME guard is what we end up testing.
    const suspendVia = (c: { sleep: (ms: number) => Promise<void> }) => c.sleep(1000);

    const wf = createWorkflow(wfId, {
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
      container: createContainer(),
      autoExecute: false,
    });

    const runId = uniqueId('suspend-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    wf.shutdown();
  });

  // ==========================================================================
  // 10. External effective-once doc check: ctx.idempotencyKey('compensate')
  //     is attempt-invariant (stable across a simulated retry).
  // ==========================================================================

  it('[10] ctx.idempotencyKey("compensate") is stable across compensation retries (external effective-once)', async () => {
    const wfId = uniqueId('idem-key');
    const keys: string[] = [];
    let attempt = 0;
    const wf = createWorkflow(wfId, {
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
      autoExecute: false,
    });

    const runId = uniqueId('idem-run');
    await persistRun({
      runId,
      workflowId: wfId,
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
    wf.shutdown();
  });

  // A sanity assertion that the recovery path is also reachable through the
  // scheduler's documented query (defense for scenario 4/5 wiring): a stale
  // compensating run is visible to getStaleCompensatingRuns.
  it('[guard] getStaleCompensatingRuns matches a stale compensating run and waitUntil is available', async () => {
    const wfId = uniqueId('guard');
    const runId = uniqueId('guard-run');
    await persistRun({
      runId,
      workflowId: wfId,
      status: 'compensating',
      lastHeartbeat: new Date(Date.now() - 10 * 60_000),
      steps: [{ stepId: 'a', status: 'done', output: 'A' }],
    });
    const found = await waitUntil(async () => {
      const rows = await workflowRunRepository.getStaleCompensatingRuns(60_000, 100, {
        bypassTenant: true,
      });
      return rows.some((r) => r._id === runId);
    }, 2000);
    expect(found).toBe(true);
  });
});
