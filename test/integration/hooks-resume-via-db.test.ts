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
 *
 * The no-container default path (the free functions falling back to the
 * default-connection singletons) is covered by the files dedicated to the
 * default-connection API; here every resume names the env's container or an
 * injected repository on the env's connection.
 */

import { describe, expect, it, vi } from 'vitest';
import { hookRegistry } from '../../src/execution/engine.js';
import { createHook, resumeHook } from '../../src/index.js';
import { createWorkflowRepository } from '../../src/storage/run.repository.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** Two-step flow: `request` parks on a hook wait, `decide` consumes it. */
function twoStepFlow() {
  return env.workflow('rvdb', {
    steps: {
      request: async (ctx) => {
        const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:approve` });
        return ctx.wait(hook.reason, { hookToken: hook.token });
      },
      decide: async (ctx) => ({ sawPayload: ctx.getOutput('request') }),
    },
    autoExecute: true,
    scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
  });
}

/** A repository distinct from the engine's (and the singleton), on the env's database. */
const injectedRepository = () => createWorkflowRepository({ model: env.runModel });

describe('resumeViaDb (2.7.0 rework)', () => {
  it('(a) writes the resume through the injected repository, not the singleton', async () => {
    const wf = twoStepFlow();

    const run = await wf.start({});
    await env.until(run._id, 'waiting');

    // Force the DB-fallback path (no per-run engine registration).
    hookRegistry.unregister(run._id);

    const customRepo = injectedRepository();
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

    const final = await env.until(run._id, 'done', { timeout: 8000 });
    expect(final.status).toBe('done');
  });

  it('(b) resume advance is ONE atomic update — step-done + currentStepId in a single round-trip', async () => {
    const wf = twoStepFlow();

    const run = await wf.start({});
    await env.until(run._id, 'waiting');

    hookRegistry.unregister(run._id);

    const customRepo = injectedRepository();
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

    await env.until(run._id, 'done', { timeout: 8000 });
  });

  it('(c) DB-resume completion emits workflow:completed and releases the strict-concurrency slot', async () => {
    // Single-step workflow: resuming the wait IS the completion (no next step).
    const wf = env.workflow('rvdb-complete', {
      steps: {
        hold: async (ctx) => {
          const hook = createHook(ctx, 'final approval', { token: `${ctx.runId}:approve` });
          return ctx.wait(hook.reason, { hookToken: hook.token });
        },
      },
      concurrency: { strict: true, limit: 1, key: () => 'bucket' },
      autoExecute: true,
      scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
    });

    const completedEvents: Array<{ runId?: string }> = [];
    const onCompleted = (p: unknown) => {
      completedEvents.push(p as { runId?: string });
    };
    env.container.eventBus.on('workflow:completed', onCompleted);

    try {
      const run = await wf.start({});
      await env.until(run._id, 'waiting');

      // Strict slot held while waiting.
      const held = await env.counter(wf, 'bucket');
      expect(held?.count).toBe(1);

      // Force the DB-fallback path, then resume → completion.
      hookRegistry.unregister(run._id);
      const { run: resumed } = await resumeHook(
        `${run._id}:approve`,
        { ok: true },
        { container: env.container },
      );
      expect(resumed.status).toBe('done');

      // `workflow:completed` was emitted on the owning container bus, and the
      // async slot-release listener brought the strict slot back to 0. Pre-2.7
      // the raw completion write skipped both — the slot leaked until recount.
      await env.eventually(
        async () => {
          expect(completedEvents.some((e) => e.runId === run._id)).toBe(true);
          const after = await env.counter(wf, 'bucket');
          expect(after?.count).toBe(0);
        },
        { timeout: 5000 },
      );
    } finally {
      env.container.eventBus.off('workflow:completed', onCompleted);
    }
  });
});
