/**
 * resumeViaDb rework (2.7.0) — regression suite for the three pre-2.7 defects:
 *
 *   (a) Resume writes went through the module-level repository singleton even
 *       when the host injected/owned a different repository. Now:
 *       `resumeHook(token, payload, { repository })` threads the owning repo
 *       into the DB-fallback path.
 *   (b) The step-done write and the `currentStepId` advance were TWO separate
 *       updates — a crash between them left `status: 'running'` pointing at a
 *       done step. Now: ONE atomic `updateOne` (single `findOneAndUpdate`
 *       round-trip) behind a status+step CAS guard.
 *   (c) The "no next step" completion path marked the run done via a raw
 *       write with NO `workflow:completed` emission and never released the
 *       strict-concurrency slot. Now: it mirrors the engine's completion
 *       contract — durable write first, then emission on the owning
 *       container bus (whose listener releases the slot).
 *
 * All tests force the DB-fallback path by unregistering the run from the
 * in-memory hookRegistry (simulating "the engine that parked the run is
 * gone" while the workflow's engine is still registered for continuation).
 */

import { describe, expect, it, vi } from 'vitest';
import { hookRegistry } from '../../src/execution/engine.js';
import { WorkflowConcurrencyCounterModel } from '../../src/storage/concurrency-counter.model.js';
import { createWorkflowRepository } from '../../src/storage/run.repository.js';
import { createContainer, createHook, createWorkflow, resumeHook } from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(
  wf: { get: (id: string) => Promise<{ status: string } | null> },
  runId: string,
  statuses: string[],
  timeoutMs = 8000,
): Promise<{ status: string } & Record<string, unknown>> {
  const want = new Set(statuses);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = (await wf.get(runId)) as ({ status: string } & Record<string, unknown>) | null;
    if (r && want.has(r.status)) return r;
    await sleep(30);
  }
  throw new Error(`run ${runId} did not reach [${statuses}] within ${timeoutMs}ms`);
}

/** Two-step flow: `request` parks on a hook wait, `decide` consumes it. */
function twoStepFlow(wfId: string) {
  return createWorkflow(wfId, {
    steps: {
      request: async (ctx) => {
        const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:approve` });
        return ctx.wait(hook.reason, { hookToken: hook.token });
      },
      decide: async (ctx) => ({ sawPayload: ctx.getOutput('request') }),
    },
    scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
  });
}

describe('resumeViaDb (2.7.0 rework)', () => {
  useTestDb();

  it('(a) writes the resume through the injected repository, not the singleton', async () => {
    const wfId = uid('rvdb-repo');
    const wf = twoStepFlow(wfId);

    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);

    // Force the DB-fallback path (no per-run engine registration).
    hookRegistry.unregister(run._id);

    const customRepo = createWorkflowRepository();
    const updateSpy = vi.spyOn(customRepo, 'updateOne');
    const readSpy = vi.spyOn(customRepo, 'getById');

    const { run: resumed } = await resumeHook(
      `${run._id}:approve`,
      { approved: true },
      { repository: customRepo },
    );

    // The injected repo received the resume write AND the reads.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalled();
    expect(resumed.status).toBe('running');

    const final = await waitForStatus(wf, run._id, ['done']);
    expect(final.status).toBe('done');

    wf.shutdown();
  });

  it('(b) resume advance is ONE atomic update — step-done + currentStepId in a single round-trip', async () => {
    const wfId = uid('rvdb-atomic');
    const wf = twoStepFlow(wfId);

    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);

    hookRegistry.unregister(run._id);

    const customRepo = createWorkflowRepository();
    const updateSpy = vi.spyOn(customRepo, 'updateOne');

    const { run: resumed } = await resumeHook(
      `${run._id}:approve`,
      { approved: true },
      { repository: customRepo },
    );

    // Exactly ONE write round-trip (pre-2.7: two — step-done, then advance).
    // A concurrent claim can therefore never observe the intermediate
    // "running but pointing at a done step" state.
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // The single call carries a CAS guard AND both field sets.
    const [filter, update] = updateSpy.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toMatchObject({
      _id: run._id,
      status: 'waiting',
      'steps.0.status': 'waiting',
    });
    expect(update.$set).toMatchObject({
      status: 'running',
      currentStepId: 'decide',
      'steps.0.status': 'done',
      'steps.0.output': { approved: true },
    });

    // Post-write doc shape is fully consistent.
    expect(resumed.currentStepId === 'decide' || resumed.status === 'done').toBe(true);
    const requestStep = resumed.steps.find((s) => s.stepId === 'request');
    expect(requestStep?.status).toBe('done');
    expect(requestStep?.waitingFor).toBeFalsy();

    await waitForStatus(wf, run._id, ['done']);
    wf.shutdown();
  });

  it('(c) DB-resume completion emits workflow:completed and releases the strict-concurrency slot', async () => {
    const wfId = uid('rvdb-complete');
    const container = createContainer();

    // Single-step workflow: resuming the wait IS the completion (no next step).
    const wf = createWorkflow(wfId, {
      steps: {
        hold: async (ctx) => {
          const hook = createHook(ctx, 'final approval', { token: `${ctx.runId}:approve` });
          return ctx.wait(hook.reason, { hookToken: hook.token });
        },
      },
      concurrency: { strict: true, limit: 1, key: () => 'bucket' },
      container,
      scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
    });

    const completedEvents: Array<{ runId?: string }> = [];
    container.eventBus.on('workflow:completed', (p) => {
      completedEvents.push(p as { runId?: string });
    });

    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);

    // Strict slot held while waiting.
    const counterId = `${wfId}:bucket`;
    const held = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    expect(held?.count).toBe(1);

    // Force the DB-fallback path, then resume → completion.
    hookRegistry.unregister(run._id);
    const { run: resumed } = await resumeHook(`${run._id}:approve`, { ok: true });
    expect(resumed.status).toBe('done');

    // `workflow:completed` was emitted on the owning container bus…
    await sleep(200); // let the async slot-release listener settle
    expect(completedEvents.some((e) => e.runId === run._id)).toBe(true);

    // …and the strict slot was released (counter back to 0). Pre-2.7 the
    // raw completion write skipped both — the slot leaked until recount.
    const after = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    expect(after?.count).toBe(0);

    wf.shutdown();
  });
});
