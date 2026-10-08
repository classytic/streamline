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

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('multi-workflow isolation (distributed correctness)', () => {
  it('B.executeRetry(aRunId) does NOT claim/execute A run; only A engine advances it', async () => {
    let aRan = 0;
    let bRan = 0;

    // A and B have DIFFERENT step graphs — running B's graph against A's run
    // would hit a step B doesn't define (or vice-versa).
    const a = env.workflow('iso-A', {
      steps: {
        'a-step': async () => {
          aRan++;
          return 'a-done';
        },
      },
    });
    const b = env.workflow('iso-B', {
      steps: {
        'b-step': async () => {
          bRan++;
          return 'b-done';
        },
      },
    });
    const wfA = a.engine.definition.id;

    // `waiting` on a due retry-backoff — exactly the shape `executeRetry`'s
    // retry-claim filter matches.
    const aRun = await env.runs.retryDue(a, { step: 'a-step' });

    // (2) Direct foreign call: B.executeRetry on A's run must NOT run B's
    // handler and must NOT corrupt A's run.
    const retryResult = await b.engine.executeRetry(aRun._id);
    expect(bRan).toBe(0); // B's step graph never ran
    // It either no-ops (no engine delegation needed) or routes to A. Because A
    // IS registered, the guard routes to A's engine — which legitimately runs
    // A's step. Either way, B's handler stayed at 0 and A's run is intact.
    expect(retryResult === null || retryResult?.workflowId === wfA).toBe(true);

    // A's run must reach A's correct terminal state, run by A's graph only.
    const final = await a.get(aRun._id);
    expect(final?.workflowId).toBe(wfA);
    expect(final?.status).toBe('done');
    expect(final?.error).toBeUndefined(); // never failed-by-B / step-not-found
    expect(bRan).toBe(0);
    expect(aRan).toBeGreaterThanOrEqual(1);
  });

  it('B.resume(aRunId) is a no-op-or-route; never runs B handlers on A run', async () => {
    let bRan = 0;

    const a = env.workflow('iso2-A', {
      steps: {
        'a-only': async () => 'a-out',
      },
    });
    const b = env.workflow('iso2-B', {
      steps: {
        'b-only': async () => {
          bRan++;
          return 'b-out';
        },
      },
    });
    const wfA = a.engine.definition.id;

    // A run waiting on a human-input style wait (step waiting, no payload-less
    // reconcile type). We persist it as a plain retryable waiting run.
    const aRun = await env.runs.retryDue(a, { step: 'a-only' });

    // Direct foreign resume — must not run B's graph.
    const resumed = await b.engine.resume(aRun._id).catch(() => null);
    expect(bRan).toBe(0);
    // Routed to A (A registered) → A's run advances under A. Result, if any,
    // belongs to A.
    if (resumed) expect(resumed.workflowId).toBe(wfA);

    const final = await a.get(aRun._id);
    expect(final?.workflowId).toBe(wfA);
    expect(final?.status).toBe('done');
    expect(final?.error).toBeUndefined();
    expect(bRan).toBe(0);
  });

  it('foreign run with NO registered owner engine is a no-op (never executed)', async () => {
    let bRan = 0;
    const b = env.workflow('iso3-B', {
      steps: {
        'b-step': async () => {
          bRan++;
          return 'b-done';
        },
      },
    });

    // A due-retry run of a workflow that is never registered. A bare id gives
    // the fixture no step graph, so the retry-due step is spelled out.
    const orphanWfId = 'iso3-orphan';
    const orphan = await env.runs.insert(orphanWfId, {
      status: 'waiting',
      definitionVersion: '1.0.0',
      currentStepId: 'x-step',
      steps: [
        {
          stepId: 'x-step',
          status: 'pending',
          attempts: 1,
          retryAfter: new Date(Date.now() - 60_000),
        },
      ],
    });

    const r1 = await b.engine.executeRetry(orphan._id);
    const r2 = await b.engine.recoverStale(orphan._id, 0).catch(() => null);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(bRan).toBe(0);

    // The orphan run was NOT executed by B — still waiting, unchanged graph.
    const final = await b.engine.get(orphan._id);
    expect(final?.workflowId).toBe(orphanWfId);
    expect(final?.status).toBe('waiting');
  });

  it('childWorkflow across two DIFFERENT workflows still works end-to-end', async () => {
    // Proves the routing guard did NOT break legitimate cross-engine flows:
    // parent (wfP) starts a child (wfC) — different workflowIds — and resumes
    // with the child output.
    const child = env.workflow<{ doubled: number }>('iso-child', {
      steps: {
        compute: async (ctx) => {
          const input = ctx.input as { value: number };
          return { result: input.value * 2 };
        },
      },
      context: () => ({ doubled: 0 }),
      autoExecute: true,
    });
    const wfC = child.engine.definition.id;

    const parent = env.workflow<{ childResult?: unknown }>('iso-parent', {
      steps: {
        delegate: async (ctx) => ctx.startChildWorkflow(wfC, { value: 21 }),
        finish: async (ctx) => {
          await ctx.set('childResult', ctx.getOutput('delegate'));
          return 'done';
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const parentRun = await parent.start({});
    await env.until(parentRun._id, 'done', { timeout: 10_000 });

    const final = await parent.get(parentRun._id);
    expect(final?.status).toBe('done');
    expect(final?.context.childResult).toEqual({ result: 42 });
  });
});
