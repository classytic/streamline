/**
 * `@classytic/streamline/testkit` — the harness itself, and proof the engine
 * runs fully isolated on a non-default connection (no fallback to the global
 * mongoose models anywhere on these paths).
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHook, resumeHook } from '../../src/index.js';
import { WorkflowRunModel } from '../../src/storage/models.js';
import { createStreamlineTestEnv } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/env.js';

const env = useStreamlineEnv();

describe('testkit — env', () => {
  it('workflows get unique ids, this env’s container, and manual execution', async () => {
    const a = env.workflow('order', { steps: { only: async () => 'a' } });
    const b = env.workflow('order', { steps: { only: async () => 'b' } });
    expect(a.engine.definition.id).not.toBe(b.engine.definition.id);
    expect(a.engine.container).toBe(env.container);

    const run = await a.start({});
    expect(run.status).not.toBe('done'); // autoExecute: false
    expect((await a.execute(run._id)).status).toBe('done');
  });

  it('runs live on the env’s own database, never the global model', async () => {
    const wf = env.workflow('isolated', { steps: { only: async () => 'ok' } });
    const run = await wf.start({});
    await wf.execute(run._id);

    expect((await env.runModel.findById(run._id).lean())?.status).toBe('done');
    // Bound to the env's connection — not the default-connection singleton
    // (which isn't even connected in this file: any fallback to it would hang).
    expect(env.runModel).not.toBe(WorkflowRunModel);
    expect(env.runModel.db).toBe(env.connection);
    expect(env.container.repository.runModel.db).toBe(env.connection);
  });

  it('until() returns the stored run, and names the last status on timeout', async () => {
    const wf = env.workflow('until', { steps: { gate: async (ctx) => ctx.waitFor('go') } });
    const run = await wf.start({});
    await wf.execute(run._id);

    expect((await env.until(run._id, 'waiting')).currentStepId).toBe('gate');
    await expect(env.until(run._id, 'done', { timeout: 60 })).rejects.toThrow(
      /status "done" not reached within 60ms — last status "waiting" at step "gate"/,
    );
  });

  it('trace() counts the writes and reads a block sends', async () => {
    const step = async () => ({ ok: true });
    const wf = env.workflow('trace', { steps: { a: step, b: step, c: step } });
    const run = await wf.start({});

    const traced = await env.trace(() => wf.execute(run._id));
    expect(traced.result.status).toBe('done');
    expect(traced.writes).toBe(6); // claim + result per step
    // trace() sees the whole connection (a new workflow's scheduler probes
    // too) — so assert on what THIS run cost: no reads of it at all.
    const readsOfRun = traced.commands.filter(
      (c) => c.name === 'find' && JSON.stringify(c.command.filter).includes(run._id),
    );
    expect(readsOfRun).toEqual([]);
    expect(traced.bytesSent).toBeGreaterThan(0);
  });

  it('clear() shuts workflows down and empties the database', async () => {
    const wf = env.workflow('clear', { steps: { gate: async (ctx) => ctx.waitFor('go') } });
    const run = await wf.start({});
    await wf.execute(run._id);

    await env.clear();
    expect(await env.runs.get(run._id)).toBeNull();
  });

  it('two envs never see each other', async () => {
    const other = await createStreamlineTestEnv(
      process.env.STREAMLINE_TEST_MONGODB_URI
        ? { uri: process.env.STREAMLINE_TEST_MONGODB_URI }
        : {},
    );
    try {
      const wf = other.workflow('elsewhere', { steps: { only: async () => 1 } });
      const run = await wf.start({});
      expect(await other.runs.get(run._id)).not.toBeNull();
      expect(await env.runs.get(run._id)).toBeNull();
    } finally {
      await other.close();
    }
  });
});

describe('testkit — run fixtures drive the real recovery paths', () => {
  it('staleRunning → one tick recovers and finishes it', async () => {
    const wf = env.workflow('stale', { steps: { a: async () => 'A', b: async () => 'B' } });
    const run = await env.runs.staleRunning(wf);

    await env.tick(wf);
    const done = await env.until(run._id, 'done');
    expect(done.output).toBe('B');
  });

  it('retryDue / timerDue / scheduledDue are each picked up by a tick', async () => {
    const wf = env.workflow('due', {
      steps: { s: { handler: async () => 'ok', retries: 3 }, t: async () => 'end' },
    });
    const retry = await env.runs.retryDue(wf);
    const timer = await env.runs.timerDue(wf);
    const scheduled = await env.runs.scheduledDue(wf);

    await env.tick(wf);
    for (const r of [retry, timer, scheduled]) {
      expect((await env.until(r._id, 'done')).status).toBe('done');
    }
  });

  it('waitingFor + signal delivers durably', async () => {
    const wf = env.workflow('signal', {
      steps: {
        gate: async (ctx) => ctx.waitFor('approved'),
        after: async (ctx) => ctx.getOutput('gate'),
      },
    });
    const run = await env.runs.waitingFor(wf, 'approved');

    expect((await wf.signal(run._id, 'approved', { by: 'ops' })).status).toBe('delivered');
    expect((await env.until(run._id, 'done')).output).toEqual({ by: 'ops' });
  });

  it('failedAwaitingCompensation → the saga sweep compensates it', async () => {
    const undone: string[] = [];
    const wf = env.workflow('saga', {
      steps: {
        charge: { handler: async () => 'c', onCompensate: async () => void undone.push('charge') },
        ship: { handler: async () => 's', onCompensate: async () => void undone.push('ship') },
        fail: async () => 'f',
      },
    });
    const run = await env.runs.failedAwaitingCompensation(wf, {
      done: ['charge', 'ship'],
      failed: 'fail',
    });

    await env.tick(wf);
    expect((await env.until(run._id, 'compensated')).status).toBe('compensated');
    expect(undone).toEqual(['ship', 'charge']);
  });
});

describe('testkit — helpers', () => {
  it('eventually() retries until the check passes, and names the last failure', async () => {
    let n = 0;
    await env.eventually(() => {
      n++;
      expect(n).toBeGreaterThanOrEqual(3);
    });
    expect(n).toBe(3);
    await expect(env.eventually(() => false, { timeout: 40 })).rejects.toThrow(
      /not satisfied within 40ms — check returned false/,
    );
  });

  it('untilCount() waits for runs whose ids you do not know', async () => {
    const wf = env.workflow('count', { steps: { only: async () => 1 }, autoExecute: true });
    await Promise.all([wf.start({}), wf.start({})]);
    const done = await env.untilCount({ workflowId: wf.engine.definition.id, status: 'done' }, 2);
    expect(done).toHaveLength(2);
  });

  it('worker() is the same workflow on its own container; redefine() shares this one', async () => {
    const wf = env.workflow('multi', { steps: { only: async () => 'v1' } });
    const worker = env.worker(wf, { steps: { only: async () => 'worker' } });
    const v2 = env.redefine(wf, { steps: { only: async () => 'v2' }, version: '1.1.0' });

    expect(worker.engine.definition.id).toBe(wf.engine.definition.id);
    expect(worker.container).not.toBe(env.container);
    expect(worker.container.repository.runModel.db).toBe(env.connection);
    expect(v2.container).toBe(env.container);

    const run = await wf.start({});
    expect((await worker.execute(run._id)).output).toBe('worker'); // another process ran it
  });

  it('runs.update() drops the engine cache, so the engine sees the edit', async () => {
    const wf = env.workflow('edit', { steps: { gate: async (ctx) => ctx.waitFor('go') } });
    const run = await wf.start({});
    await wf.execute(run._id);
    expect((await wf.get(run._id))?.paused).toBeFalsy(); // now cached

    await env.runs.update(run._id, { paused: true });
    expect((await wf.get(run._id))?.paused).toBe(true);
  });

  it('runs.makeDue() pulls a far-off retry to now; a tick then runs it', async () => {
    let calls = 0;
    const wf = env.workflow('due-later', {
      steps: {
        flaky: {
          handler: async () => {
            if (++calls === 1) throw new Error('first try fails');
            return 'ok';
          },
          retries: 2,
          retryDelay: 60_000, // a real minute — the test does not wait it out
        },
      },
    });
    const run = await wf.start({});
    expect((await wf.execute(run._id)).status).toBe('waiting');

    await env.tick(wf);
    expect(calls).toBe(1); // not due yet

    await env.runs.makeDue(run._id);
    await env.tick(wf);
    expect((await env.until(run._id, 'done')).output).toBe('ok');
    await expect(env.runs.makeDue(run._id)).rejects.toThrow(/nothing to make due/);
  });

  it('counter() reads a strict-concurrency bucket', async () => {
    const wf = env.workflow<Record<string, unknown>, { k: string }>('strict', {
      steps: { hold: async (ctx) => ctx.waitFor('release') },
      concurrency: { key: (i) => i.k, limit: 2, strict: true },
    });
    expect(await env.counter(wf, 'a')).toBeNull();
    await wf.start({ k: 'a' });
    await wf.start({ k: 'a' });
    expect((await env.counter(wf, 'a'))?.count).toBe(2);
  });

  it('trace.updatesTo / readsOf isolate one run from the connection’s noise', async () => {
    const step = async () => 1;
    const wf = env.workflow('trace-helpers', { steps: { a: step, b: step } });
    const run = await wf.start({});

    const traced = await env.trace(() => wf.execute(run._id));
    const updates = traced.updatesTo(run._id);
    expect(updates).toHaveLength(4); // claim + result, per step
    expect(updates.at(-1)).toMatchObject({ status: 'done', currentStepId: null });
    expect(traced.readsOf(run._id)).toEqual([]);
  });

  it('clear() disposes the extra containers it handed out', async () => {
    const extra = env.createContainer();
    const disposed = vi.spyOn(extra, 'dispose');
    await env.clear();
    expect(disposed).toHaveBeenCalledOnce();
  });
});

describe('testkit — hooks resolve through the env’s container', () => {
  it('resumeHook’s DB path (no engine in process) writes on the env connection', async () => {
    const wf = env.workflow('hook', {
      steps: {
        approve: async (ctx) => {
          const hook = createHook(ctx, 'approval');
          return ctx.wait(hook.reason, { hookToken: hook.token });
        },
      },
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    const waitData = (await env.runs.get(run._id))?.steps[0]?.waitingFor?.data as {
      hookToken: string;
    };
    const token = waitData.hookToken;
    wf.shutdown(); // the engine is gone — resume must go through the DB path

    const result = await resumeHook(token, { ok: true }, { container: env.container });
    expect(result.run.status).toBe('done');
    expect((await env.runs.get(run._id))?.status).toBe('done');
  });
});

afterAll(() => undefined);
