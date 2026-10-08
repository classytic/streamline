/**
 * Focused tests for `concurrency.throttle` and `concurrency.debounce`.
 *
 * Both are start-rate gates wired into `define.ts`'s `start()` path. This
 * file pins the boundary contract — base admit/queue behavior, key isolation,
 * config validation. Burst staggering, tenant propagation, and parallel-race
 * semantics live in
 * [`test/integration/throttle-debounce-scenarios.test.ts`](../integration/throttle-debounce-scenarios.test.ts).
 *
 *  **Throttle** — best-effort start-rate smoothing, NOT a strict distributed
 *    rate limiter. First `limit` starts in any rolling window fire
 *    immediately; excess starts queue as scheduled drafts and are spread by
 *    `windowMs / limit`:
 *      - First excess: `oldestInWindow + windowMs`
 *      - Each subsequent excess: `tail.executionTime + windowMs / limit`
 *    Sequential bursts smooth strictly; parallel concurrent starts can
 *    reserve the same future slot (bounded by parallelism, not by `limit`).
 *
 *  **Debounce** — trailing-edge collapse. Within `windowMs` quiet period per
 *    `concurrencyKey`, each repeated start atomically bumps the pending
 *    draft's `executionTime` instead of creating a new run. Only the last
 *    start fires; the persisted run carries the latest input.
 *
 * Tests don't exercise the actual scheduler tick — they assert the
 * persisted run shape after `start()`, which is what the gates control.
 */

import { describe, expect, it } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

type Ctx = Record<string, unknown>;
type UserInput = { userId: string };

describe('concurrency.throttle — N starts per windowMs per key', () => {
  it('admits starts up to the limit immediately', async () => {
    const wf = env.workflow<Ctx, UserInput>('throttle-immediate', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        throttle: { limit: 3, windowMs: 60_000 },
      },
    });

    const r1 = await wf.start({ userId: 'u-1' });
    const r2 = await wf.start({ userId: 'u-1' });
    const r3 = await wf.start({ userId: 'u-1' });

    // First N starts (= limit) are admitted to immediate execution —
    // no scheduled-future timestamp injected by the throttle path.
    for (const r of [r1, r2, r3]) {
      expect(r.meta?.streamlineGate).not.toBe('throttle');
    }
  });

  it('queues the (limit + 1)th start at oldestInWindow + windowMs', async () => {
    // First excess start: no queued throttle tail yet, so the fire-at is
    // anchored to when the oldest in-window start rolls off. Deeper bursts
    // are exercised in the scenarios suite — they stagger by
    // `windowMs / limit` after the tail.
    const wf = env.workflow<Ctx, UserInput>('throttle-queue', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        throttle: { limit: 2, windowMs: 5_000 },
      },
    });

    const t0 = Date.now();
    const first = await wf.start({ userId: 'u-1' });
    await wf.start({ userId: 'u-1' });
    const queued = await wf.start({ userId: 'u-1' });

    expect(queued.meta?.streamlineGate).toBe('throttle');

    const queuedRun = await env.runs.get(queued._id);
    const fireAt = queuedRun?.scheduling?.executionTime;
    expect(fireAt).toBeInstanceOf(Date);
    const expected = new Date(first.createdAt).getTime() + 5_000;
    expect(Math.abs((fireAt as Date).getTime() - expected)).toBeLessThanOrEqual(1_000);
    expect((fireAt as Date).getTime()).toBeGreaterThanOrEqual(t0);
  });

  it('isolates throttle by concurrencyKey', async () => {
    const wf = env.workflow<Ctx, UserInput>('throttle-isolation', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        throttle: { limit: 1, windowMs: 60_000 },
      },
    });

    // u-1 fills its single slot. u-2 should still be admitted.
    await wf.start({ userId: 'u-1' });
    const u2 = await wf.start({ userId: 'u-2' });

    expect(u2.meta?.streamlineGate).not.toBe('throttle');
  });

  it('throws when throttle is set without `key`', () => {
    // Config validation at definition time — no database involved.
    expect(() =>
      createWorkflow('throttle-no-key', {
        steps: { run: async () => 'ok' },
        container: env.container,
        concurrency: {
          throttle: { limit: 5, windowMs: 1_000 },
        } as never,
      }),
    ).toThrow(/throttle requires a 'key'/);
  });
});

describe('concurrency.debounce — collapse to last start in quiet window', () => {
  it('first start in a quiet window creates a debounce draft', async () => {
    const wf = env.workflow<Ctx, UserInput>('debounce-first', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        debounce: { windowMs: 30_000 },
      },
    });

    const first = await wf.start({ userId: 'u-1' });

    expect(first.meta?.streamlineGate).toBe('debounce');
    expect(first.status).toBe('draft');
    // Scheduled `windowMs` in the future.
    const fireAt = first.scheduling?.executionTime;
    expect(fireAt).toBeInstanceOf(Date);
    expect((fireAt as Date).getTime()).toBeGreaterThan(Date.now() + 25_000);
  });

  it('subsequent starts within the window bump the SAME draft (no new run)', async () => {
    const wf = env.workflow<Ctx, { userId: string; rev: number }>('debounce-bump', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        debounce: { windowMs: 30_000 },
      },
    });

    const first = await wf.start({ userId: 'u-1', rev: 1 });
    const bumped = await wf.start({ userId: 'u-1', rev: 2 });
    const bumpedAgain = await wf.start({ userId: 'u-1', rev: 3 });

    // All three calls return the SAME run id — that's the contract.
    expect(String(bumped._id)).toBe(String(first._id));
    expect(String(bumpedAgain._id)).toBe(String(first._id));

    // Exactly one run persisted for this key.
    const count = await env.runModel.countDocuments({
      workflowId: wf.engine.definition.id,
      concurrencyKey: 'u-1',
    });
    expect(count).toBe(1);

    // The persisted run carries the LATEST input (trailing-edge).
    const persisted = await env.runs.get(first._id);
    expect((persisted?.input as { rev?: number } | undefined)?.rev).toBe(3);
  });

  it('extends fireAt on each bump (next quiet window restart)', async () => {
    const wf = env.workflow<Ctx, UserInput>('debounce-extend', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        debounce: { windowMs: 10_000 },
      },
    });

    const first = await wf.start({ userId: 'u-1' });
    expect(first.scheduling?.executionTime).toBeInstanceOf(Date);
    const firstFireAt = first.scheduling?.executionTime.getTime() ?? Number.NaN;

    // Let the clock move so the bump's nextFireAt is measurably later
    // (a clock gap, not a wait for an outcome).
    await new Promise((r) => setTimeout(r, 50));

    const bumped = await wf.start({ userId: 'u-1' });
    const bumpedFireAt = bumped.scheduling?.executionTime.getTime() ?? Number.NaN;

    expect(bumpedFireAt).toBeGreaterThan(firstFireAt);
  });

  it('isolates debounce by concurrencyKey', async () => {
    const wf = env.workflow<Ctx, UserInput>('debounce-isolation', {
      steps: { run: async () => 'ok' },
      concurrency: {
        key: (input) => input.userId,
        debounce: { windowMs: 30_000 },
      },
    });

    const u1 = await wf.start({ userId: 'u-1' });
    const u2 = await wf.start({ userId: 'u-2' });

    expect(String(u1._id)).not.toBe(String(u2._id));
    const count = await env.runModel.countDocuments({
      workflowId: wf.engine.definition.id,
    });
    expect(count).toBe(2);
  });

  it('throws when debounce is set without `key`', () => {
    // Config validation at definition time — no database involved.
    expect(() =>
      createWorkflow('debounce-no-key', {
        steps: { run: async () => 'ok' },
        container: env.container,
        concurrency: {
          debounce: { windowMs: 1_000 },
        } as never,
      }),
    ).toThrow(/debounce requires a 'key'/);
  });
});
