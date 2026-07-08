import { describe, expect, it } from 'vitest';
import type { WorkflowEventBus } from '../../src/core/events.js';
import type { WorkflowRun } from '../../src/core/types.js';
import { StepContextImpl } from '../../src/execution/context.js';
import type { WorkflowRunRepository } from '../../src/storage/run.repository.js';

/**
 * A step has ONE checkpoint slot (`output.__checkpoint`). `scatter()` and
 * `loop()` claim it for durable recovery, and a user `checkpoint()` — or a
 * nested `scatter()`/`loop()` — would clobber it and silently re-run completed
 * work. The guard turns that latent data-loss footgun into a loud throw. These
 * exercise the guard directly; only `writeCheckpoint`'s DB call is stubbed.
 */
function makeCtx(): StepContextImpl {
  const run = { _id: 'run-1', steps: [{ stepId: 'work', status: 'running' }] } as unknown as WorkflowRun;
  const repo = {
    updateOne: async () => ({ modifiedCount: 1 }),
  } as unknown as WorkflowRunRepository;
  return new StepContextImpl('run-1', 'work', {}, undefined, 0, run, repo, {} as unknown as WorkflowEventBus);
}

const doneOnce = async (s: number) => ({ state: s, done: true });

describe('checkpoint-slot guard', () => {
  it('rejects checkpoint() called inside scatter()', async () => {
    const ctx = makeCtx();
    await expect(
      ctx.scatter({
        a: async () => {
          await ctx.checkpoint('nope');
          return 1;
        },
      }),
    ).rejects.toThrow(/checkpoint\(\) cannot run inside ctx\.scatter\(\)/);
  });

  it('rejects a nested scatter() inside scatter()', async () => {
    const ctx = makeCtx();
    await expect(
      ctx.scatter({ a: async () => ctx.scatter({ b: async () => 1 }) }),
    ).rejects.toThrow(/scatter\(\) cannot be nested inside ctx\.scatter\(\)/);
  });

  it('rejects loop() inside scatter()', async () => {
    const ctx = makeCtx();
    await expect(
      ctx.scatter({ a: async () => ctx.loop(0, doneOnce) }),
    ).rejects.toThrow(/loop\(\) cannot be nested inside ctx\.scatter\(\)/);
  });

  it('rejects checkpoint() called inside loop()', async () => {
    const ctx = makeCtx();
    await expect(
      ctx.loop(0, async (s) => {
        await ctx.checkpoint('nope');
        return { state: s, done: true };
      }),
    ).rejects.toThrow(/checkpoint\(\) cannot run inside ctx\.loop\(\)/);
  });

  it('rejects scatter() inside loop()', async () => {
    const ctx = makeCtx();
    await expect(
      ctx.loop(0, async (s) => {
        await ctx.scatter({ a: async () => 1 });
        return { state: s, done: true };
      }),
    ).rejects.toThrow(/scatter\(\) cannot be nested inside ctx\.loop\(\)/);
  });

  it('releases the slot after scatter completes — a later checkpoint is allowed', async () => {
    const ctx = makeCtx();
    await ctx.scatter({ a: async () => 1 });
    await expect(ctx.checkpoint('after')).resolves.toBeUndefined();
  });

  it('releases the slot even when scatter throws (finally), so recovery is not wedged', async () => {
    const ctx = makeCtx();
    await expect(
      ctx.scatter({
        a: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    await expect(ctx.checkpoint('after')).resolves.toBeUndefined();
  });

  it('a plain top-level checkpoint (no slot owner) still works', async () => {
    const ctx = makeCtx();
    await expect(ctx.checkpoint('plain')).resolves.toBeUndefined();
  });
});
