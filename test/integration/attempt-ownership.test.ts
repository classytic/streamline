/**
 * Attempt ownership — an atomic claim at execution START must mean exclusive
 * ownership through execution END.
 *
 * THE BUG (review 2026-09-30): the claim was atomic, but every later write
 * (step state, retry, transition, heartbeat, checkpoint, context) was guarded
 * only against `cancelled`. Recovery re-claimed a stalled run and completed it
 * with `recovered-result`; when the original, merely-slow handler finished, it
 * overwrote that with `obsolete-result`.
 *
 * THE FIX: the claim stamps `steps.<i>.attemptId`; every write the attempt makes
 * requires it; recovery (and rewind / give-up sweeps) clears it. A superseded
 * attempt's writes match nothing and it stops with `AttemptSupersededError`.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** A one-shot latch: `wait` resolves once `open()` is called. */
function latch() {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function makeStale(runId: string): Promise<void> {
  await env.runs.update(runId, { lastHeartbeat: new Date(Date.now() - 10 * 60_000) });
}

describe('attempt ownership — a superseded worker cannot overwrite the recovered result', () => {
  it('the obsolete attempt finishing late does not replace the recovered output', async () => {
    const held = latch(); // the test releases the first (obsolete) attempt
    const entered = latch(); // the first attempt is inside its handler
    let calls = 0;
    const wf = env.workflow('owned', {
      steps: {
        work: async () => {
          calls += 1;
          if (calls === 1) {
            entered.open();
            await held.wait; // the original, merely-slow worker
            return 'obsolete-result';
          }
          return 'recovered-result';
        },
      },
    });

    const run = await wf.start({});
    const original = wf.engine.execute(run._id); // attempt 1 — blocks in the handler
    await entered.wait;

    await makeStale(run._id);
    const recovered = await wf.engine.recoverStale(run._id, 60_000); // attempt 2
    expect(recovered?.status).toBe('done');
    expect(recovered?.output).toBe('recovered-result');

    held.open(); // attempt 1 finishes AFTER being superseded
    await original; // stops cleanly — a superseded attempt is not a failure

    const stored = await env.runs.get(run._id);
    expect(stored?.status).toBe('done');
    expect(stored?.output).toBe('recovered-result');
    expect(stored?.steps?.[0]?.output).toBe('recovered-result');
  });

  it("the obsolete attempt's checkpoint is refused, so it cannot rewind the recovered one", async () => {
    const held = latch();
    const entered = latch();
    let calls = 0;
    let lateCheckpointError: unknown;
    const wf = env.workflow('owned-ckpt', {
      steps: {
        work: async (ctx) => {
          calls += 1;
          if (calls === 1) {
            entered.open();
            await held.wait;
            try {
              await ctx.checkpoint({ stale: true });
            } catch (err) {
              lateCheckpointError = err;
              throw err;
            }
            return 'obsolete-result';
          }
          return 'recovered-result';
        },
      },
    });

    const run = await wf.start({});
    const original = wf.engine.execute(run._id);
    await entered.wait;
    await makeStale(run._id);
    await wf.engine.recoverStale(run._id, 60_000);

    held.open();
    await original;

    expect((lateCheckpointError as Error | undefined)?.name).toBe('AttemptSupersededError');
    const stored = await env.runs.get(run._id);
    expect(stored?.steps?.[0]?.output).toBe('recovered-result');
  });

  it('a stalled attempt cannot write a give-up-swept run back to done', async () => {
    const held = latch();
    const entered = latch();
    let calls = 0;
    const wf = env.workflow('owned-swept', {
      steps: {
        work: async () => {
          calls += 1;
          entered.open();
          await held.wait;
          return 'late-result';
        },
      },
    });

    const run = await wf.start({});
    const original = wf.engine.execute(run._id);
    await entered.wait;
    expect(calls).toBe(1);

    await makeStale(run._id);
    const swept = await wf.engine.container.repository.markStaleAsFailed(run._id, 60_000);
    expect(swept).toBe(true);

    held.open();
    await original;

    const stored = await env.runs.get(run._id);
    expect(stored?.status).toBe('failed');
    expect((stored?.error as { code?: string } | undefined)?.code).toBe('stale_heartbeat');
    expect(stored?.steps?.[0]?.output).toBeUndefined();
  });

  it('each claim stamps a fresh attemptId; an unowned legacy step still executes', async () => {
    const wf = env.workflow('owned-token', {
      steps: { a: async () => 'A', b: async () => 'B' },
    });
    const run = await wf.start({});
    await wf.engine.execute(run._id);
    const stored = await env.runs.get(run._id);
    const [a, b] = stored?.steps ?? [];
    expect(stored?.status).toBe('done');
    expect(typeof a?.attemptId).toBe('string');
    expect(typeof b?.attemptId).toBe('string');
    expect(a?.attemptId).not.toBe(b?.attemptId);
  });
});
