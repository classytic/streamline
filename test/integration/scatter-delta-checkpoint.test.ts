/**
 * Scatter checkpoints write per-task DELTAS (`…__checkpoint.<taskId>`), not
 * the whole task map per success — O(N) bytes for N tasks instead of O(N²).
 * Recovery reads the same map either way.
 */

import { describe, expect, it, vi } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/**
 * Every `$set` key the run repository wrote during `fn`. A spy, not
 * `env.trace()`: the subject is the SHAPE of each update (which keys), not
 * how many commands it cost.
 */
async function setKeysDuring(fn: () => Promise<unknown>): Promise<string[][]> {
  const spy = vi.spyOn(env.container.repository, 'updateOne');
  try {
    await fn();
    return spy.mock.calls.map(([, update]) =>
      Object.keys(((update as { $set?: Record<string, unknown> }).$set ?? {}) as object),
    );
  } finally {
    spy.mockRestore();
  }
}

const tasks = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`t${i}`, async () => ({ i, pad: 'x'.repeat(200) })]),
  );

describe('scatter — delta checkpoints', () => {
  it('each success writes only its own entry, and the stored map is complete', async () => {
    const wf = env.workflow('delta', {
      steps: { fan: async (ctx) => ctx.scatter(tasks(20), { concurrency: 4 }) },
    });
    const run = await wf.start({});

    const writes = await setKeysDuring(() => wf.execute(run._id));
    // One slot initialization (`steps.0.output`), then one dotted entry per task.
    const firstDelta = writes.findIndex((keys) => keys.some((k) => k.includes('__checkpoint.')));
    const init = writes.findIndex((keys) => keys.includes('steps.0.output'));
    expect(init).toBeGreaterThanOrEqual(0);
    expect(init).toBeLessThan(firstDelta);
    const deltas = writes.flat().filter((k) => k.includes('__checkpoint.'));
    expect(deltas).toHaveLength(20);
    expect(new Set(deltas)).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `steps.0.output.__checkpoint.t${i}`)),
    );

    const done = await env.runs.get(run._id);
    expect(done?.status).toBe('done');
    expect(Object.keys(done?.output as object)).toHaveLength(20);
  });

  it('recovery re-runs only the tasks without a persisted entry', async () => {
    const calls: string[] = [];
    let failT2 = true;
    const wf = env.workflow('delta-recover', {
      steps: {
        fan: async (ctx) =>
          ctx.scatter({
            t0: async () => void calls.push('t0'),
            t1: async () => void calls.push('t1'),
            t2: async () => {
              calls.push('t2');
              if (failT2) throw new Error('flaky');
            },
          }),
      },
      defaults: { retries: 2, retryDelay: 60_000 }, // the scheduler must not retry first
    });
    const run = await wf.start({});
    await wf.execute(run._id); // t2 fails → step waits for retry

    const mid = await env.runs.get(run._id);
    const slot = (mid?.steps[0]?.output as { __checkpoint?: Record<string, unknown> } | undefined)
      ?.__checkpoint;
    expect(Object.keys(slot ?? {}).sort()).toEqual(['t0', 't1']);

    failT2 = false;
    calls.length = 0;
    // Due now — driven here, not by the background scheduler.
    await env.runs.makeDue(run._id);
    await wf.engine.executeRetry(run._id);
    expect(calls).toEqual(['t2']);
    expect((await env.runs.get(run._id))?.status).toBe('done');
  });

  it('task ids that are not field-path segments fall back to whole-map writes', async () => {
    const wf = env.workflow('delta-dotted', {
      steps: {
        fan: async (ctx) =>
          ctx.scatter({ 'a.b': async () => 1, $c: async () => 2, plain: async () => 3 }),
      },
    });
    const run = await wf.start({});

    const writes = await setKeysDuring(() => wf.execute(run._id));
    expect(writes.flat().some((k) => k.includes('__checkpoint.'))).toBe(false);
    const done = await env.runs.get(run._id);
    expect(done?.output).toEqual({ 'a.b': 1, $c: 2, plain: 3 });
  });

  it('a scalar checkpoint left earlier in the step does not swallow task entries', async () => {
    const wf = env.workflow('delta-scalar', {
      steps: {
        fan: async (ctx) => {
          await ctx.checkpoint(5);
          return ctx.scatter({ a: async () => 'A', b: async () => 'B' });
        },
      },
    });
    const run = await wf.start({});
    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');
    expect(result.output).toEqual({ a: 'A', b: 'B' });
  });
});
