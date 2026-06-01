/**
 * Integration regression suite for MULTI-WORKFLOW isolation
 * (v2.4.0 distributed-correctness fix).
 *
 * THE BUG (confirmed): in a process with multiple registered workflows, every
 * WorkflowEngine creates its OWN SmartScheduler that polled the GLOBAL
 * `workflow_runs` collection with NO `workflowId` filter, then called THIS
 * engine's resume/executeRetry/recoverStale callbacks on whatever run it found.
 * `executeRetry` claimed by `runId` only (no `run.workflowId === this.id`
 * guard). Result: workflow B's engine claims workflow A's run and runs B's step
 * graph against it → A's run fails with step-not-found (or a wrong handler
 * runs). Affects any multi-workflow deployment.
 *
 * THE FIX — two layers:
 *   (a) PRIMARY: every scheduler pickup query is scoped to the engine's own
 *       workflowId (so B's scheduler never even SEES A's runs).
 *   (b) DEFENSE-IN-DEPTH: a workflowId routing guard at execute / executeRetry /
 *       recoverStale / resume routes (or no-ops) a foreign run instead of
 *       running this engine's step graph against it.
 *
 * This suite proves all three required guarantees:
 *   1. B's executeRetry/resume does NOT claim/execute A's run; A only ever
 *      advances under A's engine to its correct terminal state.
 *   2. Directly calling B.executeRetry(aRunId) / B.resume(aRunId) is a
 *      no-op-or-route (never runs B's handlers on A's run).
 *   3. A childWorkflow across two DIFFERENT workflows still works end-to-end
 *      (proves the routing guard didn't break legitimate cross-engine flows).
 *
 * NOTE (pre-fix confirmation): against the pre-fix code, scenario (2)'s
 * `B.executeRetry(aRunId)` claimed A's `waiting` run (CAS by id only) and ran
 * B's step graph against A's step list → A's run went `failed` with a
 * VERSION_MISMATCH/step-not-found error. The assertions below
 * (`a-step` reaches `done`, run is never failed-by-B) fail in that world. With
 * the fix they pass. Confirmed manually by reverting the guard.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, createWorkflow, WorkflowRunModel } from '../../src/index.js';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import { cleanupTestDB, setupTestDB, teardownTestDB, waitUntil } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

let wfCounter = 0;
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${++wfCounter}`;

/**
 * Persist a run that is `waiting` on a retry-backoff (step `pending` with a
 * due `retryAfter`) — exactly the shape `executeRetry`'s retry-claim filter
 * matches. The step graph is `allStepIds` so we can assert which engine's
 * graph advanced it.
 */
async function persistRetryableRun(opts: {
  runId: string;
  workflowId: string;
  allStepIds: string[];
  /** The pending+retryAfter step (the one a retry sweep would re-run). */
  pendingStepId: string;
}): Promise<void> {
  const now = new Date();
  const steps: StepState[] = opts.allStepIds.map((id) => {
    if (id === opts.pendingStepId) {
      return {
        stepId: id,
        status: 'pending',
        attempts: 1,
        // retryAfter in the past → due for retry.
        retryAfter: new Date(now.getTime() - 60_000),
      } as StepState;
    }
    return { stepId: id, status: 'pending', attempts: 0 } as StepState;
  });

  await WorkflowRunModel.create({
    _id: opts.runId,
    workflowId: opts.workflowId,
    status: 'waiting',
    steps,
    currentStepId: opts.pendingStepId,
    context: {},
    input: {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    definitionVersion: '1.0.0',
  } as unknown as WorkflowRun);
}

describe('multi-workflow isolation (distributed correctness)', () => {
  it('B.executeRetry(aRunId) does NOT claim/execute A run; only A engine advances it', async () => {
    const container = createContainer();
    const wfA = uniqueId('iso-A');
    const wfB = uniqueId('iso-B');

    let aRan = 0;
    let bRan = 0;

    // A and B have DIFFERENT step graphs — running B's graph against A's run
    // would hit a step B doesn't define (or vice-versa).
    const a = createWorkflow(wfA, {
      steps: {
        'a-step': async () => {
          aRan++;
          return 'a-done';
        },
      },
      container,
      autoExecute: false,
    });
    const b = createWorkflow(wfB, {
      steps: {
        'b-step': async () => {
          bRan++;
          return 'b-done';
        },
      },
      container,
      autoExecute: false,
    });

    const aRunId = uniqueId('a-run');
    await persistRetryableRun({
      runId: aRunId,
      workflowId: wfA,
      allStepIds: ['a-step'],
      pendingStepId: 'a-step',
    });

    // (2) Direct foreign call: B.executeRetry on A's run must NOT run B's
    // handler and must NOT corrupt A's run.
    const retryResult = await b.engine.executeRetry(aRunId);
    expect(bRan).toBe(0); // B's step graph never ran
    // It either no-ops (no engine delegation needed) or routes to A. Because A
    // IS registered, the guard routes to A's engine — which legitimately runs
    // A's step. Either way, B's handler stayed at 0 and A's run is intact.
    expect(retryResult === null || retryResult?.workflowId === wfA).toBe(true);

    // A's run must reach A's correct terminal state, run by A's graph only.
    const final = await a.get(aRunId);
    expect(final?.workflowId).toBe(wfA);
    expect(final?.status).toBe('done');
    expect(final?.error).toBeUndefined(); // never failed-by-B / step-not-found
    expect(bRan).toBe(0);
    expect(aRan).toBeGreaterThanOrEqual(1);

    a.shutdown();
    b.shutdown();
  });

  it('B.resume(aRunId) is a no-op-or-route; never runs B handlers on A run', async () => {
    const container = createContainer();
    const wfA = uniqueId('iso2-A');
    const wfB = uniqueId('iso2-B');

    let bRan = 0;

    const a = createWorkflow(wfA, {
      steps: {
        'a-only': async () => 'a-out',
      },
      container,
      autoExecute: false,
    });
    const b = createWorkflow(wfB, {
      steps: {
        'b-only': async () => {
          bRan++;
          return 'b-out';
        },
      },
      container,
      autoExecute: false,
    });

    // A run waiting on a human-input style wait (step waiting, no payload-less
    // reconcile type). We persist it as a plain retryable waiting run.
    const aRunId = uniqueId('a2-run');
    await persistRetryableRun({
      runId: aRunId,
      workflowId: wfA,
      allStepIds: ['a-only'],
      pendingStepId: 'a-only',
    });

    // Direct foreign resume — must not run B's graph.
    const resumed = await b.engine.resume(aRunId).catch(() => null);
    expect(bRan).toBe(0);
    // Routed to A (A registered) → A's run advances under A. Result, if any,
    // belongs to A.
    if (resumed) expect(resumed.workflowId).toBe(wfA);

    const final = await a.get(aRunId);
    expect(final?.workflowId).toBe(wfA);
    expect(final?.status).toBe('done');
    expect(final?.error).toBeUndefined();
    expect(bRan).toBe(0);

    a.shutdown();
    b.shutdown();
  });

  it('foreign run with NO registered owner engine is a no-op (never executed)', async () => {
    const container = createContainer();
    const wfB = uniqueId('iso3-B');
    const orphanWfId = uniqueId('iso3-orphan'); // never registered

    let bRan = 0;
    const b = createWorkflow(wfB, {
      steps: {
        'b-step': async () => {
          bRan++;
          return 'b-done';
        },
      },
      container,
      autoExecute: false,
    });

    const orphanRunId = uniqueId('orphan-run');
    await persistRetryableRun({
      runId: orphanRunId,
      workflowId: orphanWfId,
      allStepIds: ['x-step'],
      pendingStepId: 'x-step',
    });

    const r1 = await b.engine.executeRetry(orphanRunId);
    const r2 = await b.engine.recoverStale(orphanRunId, 0).catch(() => null);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(bRan).toBe(0);

    // The orphan run was NOT executed by B — still waiting, unchanged graph.
    const final = await b.engine.get(orphanRunId);
    expect(final?.workflowId).toBe(orphanWfId);
    expect(final?.status).toBe('waiting');

    b.shutdown();
  });

  it('childWorkflow across two DIFFERENT workflows still works end-to-end', async () => {
    // Proves the routing guard did NOT break legitimate cross-engine flows:
    // parent (wfP) starts a child (wfC) — different workflowIds — and resumes
    // with the child output.
    const container = createContainer();
    const wfC = uniqueId('iso-child');
    const wfP = uniqueId('iso-parent');

    const child = createWorkflow<{ doubled: number }>(wfC, {
      steps: {
        compute: async (ctx) => {
          const input = ctx.input as { value: number };
          return { result: input.value * 2 };
        },
      },
      context: () => ({ doubled: 0 }),
      container,
    });

    const parent = createWorkflow<{ childResult?: unknown }>(wfP, {
      steps: {
        delegate: async (ctx) => ctx.startChildWorkflow(wfC, { value: 21 }),
        finish: async (ctx) => {
          await ctx.set('childResult', ctx.getOutput('delegate'));
          return 'done';
        },
      },
      context: () => ({}),
      container,
    });

    const parentRun = await parent.start({});
    const done = await waitUntil(async () => {
      const r = await parent.get(parentRun._id);
      return r?.status === 'done';
    }, 10_000);
    expect(done).toBe(true);

    const final = await parent.get(parentRun._id);
    expect(final?.status).toBe('done');
    expect(final?.context.childResult).toEqual({ result: 42 });

    parent.shutdown();
    child.shutdown();
  });
});
