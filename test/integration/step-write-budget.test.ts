/**
 * Write budget for the hot path: a successful step costs ONE claim write and
 * ONE result write, the result write also advancing (or completing) the run.
 * A separate "advance" write doubled the round-trips and left a crash window
 * with the run `running` at a step already `done`.
 */

import { describe, expect, it } from 'vitest';
import type { Workflow } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('step write budget', () => {
  it('a 5-step run costs 2 run writes per step, and every result write advances', async () => {
    const step = async () => ({ ok: true });
    const wf = env.workflow('write-budget', {
      steps: { a: step, b: step, c: step, d: step, e: step },
    });
    const run = await wf.start({});

    const traced = await env.trace(() => wf.execute(run._id));
    const done = traced.result;
    const updates = traced.updatesTo(run._id);

    expect(done.status).toBe('done');
    const claims = updates.filter((s) => Object.keys(s).some((k) => k.endsWith('.attemptId')));
    const results = updates.filter((s) =>
      Object.entries(s).some(([k, v]) => /^steps\.\d+\.status$/.test(k) && v === 'done'),
    );
    expect(claims).toHaveLength(5);
    expect(results).toHaveLength(5);
    // Each result write carries the run's advance; the last one completes it.
    expect(results.slice(0, 4).map((s) => s.currentStepId)).toEqual(['b', 'c', 'd', 'e']);
    expect(results[4]).toMatchObject({ status: 'done', currentStepId: null });
    expect(updates).toHaveLength(10);
    expect(traced.writes).toBe(10); // nothing else on the connection wrote either
  });

  it('a plain run does no per-step run reads (the pause check rides on the claim)', async () => {
    const step = async () => ({ ok: true });
    const wf = env.workflow('read-budget', {
      steps: { a: step, b: step, c: step, d: step, e: step },
    });
    const run = await wf.start({});

    const traced = await env.trace(() => wf.execute(run._id));
    // trace() sees the whole connection (a new workflow's scheduler probes
    // too) — count only reads of THIS run.
    const runReads = traced.readsOf(run._id);

    expect(traced.result.status).toBe('done');
    // Was one full-run read after every step to probe `paused`.
    expect(runReads.length).toBeLessThanOrEqual(1);
  });

  it('a paused run does not record a conditional skip at the next boundary', async () => {
    const wf: Workflow<Record<string, unknown>> = env.workflow('pause-skip', {
      steps: {
        a: async (ctx) => {
          await wf.pause(ctx.runId); // pause while `a` is in flight
          return 'a';
        },
        b: { handler: async () => 'b', skipIf: () => true },
        c: async () => 'c',
      },
    });
    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.paused).toBe(true);
    expect(result.currentStepId).toBe('b');
    expect(result.steps.find((s) => s.stepId === 'a')?.status).toBe('done');
    expect(result.steps.find((s) => s.stepId === 'b')?.status).toBe('pending');

    const resumed = await wf.resumeOperator(run._id);
    expect(resumed.status).toBe('done');
    expect(resumed.steps.find((s) => s.stepId === 'b')?.status).toBe('skipped');
  });
});
