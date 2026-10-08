/**
 * Distributed Readiness Tests
 *
 * Validates the fixes for:
 * 1. Idempotency keys reusable after terminal completion
 * 2. Concurrency-queued drafts get promoted when capacity frees
 * 3. Trigger cleanup is safe on shared event buses
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureStreamlineLogger } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

beforeAll(() => {
  configureStreamlineLogger({ enabled: false });
});

afterAll(() => {
  configureStreamlineLogger({ enabled: true });
});

const concurrencyLimitOf = (meta: unknown) =>
  (meta as { concurrencyLimit?: number } | undefined)?.concurrencyLimit;

// ============================================================================
// 1. Idempotency Key — Reusable After Terminal Completion
// ============================================================================

describe('Idempotency key lifecycle', () => {
  it('should allow reuse of idempotency key after workflow completes', async () => {
    const wf = env.workflow('idemp-reuse', {
      steps: { a: async () => 'done' },
    });

    // First run — succeeds
    const run1 = await wf.start({}, { idempotencyKey: 'order:100' });
    await wf.execute(run1._id);
    const completed = await wf.get(run1._id);
    expect(completed?.status).toBe('done');

    // Second start with same key — should create a NEW run (old one is terminal)
    const run2 = await wf.start({}, { idempotencyKey: 'order:100' });
    expect(run2._id).not.toBe(run1._id);
  });

  it('should allow reuse of idempotency key after workflow fails', async () => {
    const wf = env.workflow('idemp-fail-reuse', {
      steps: {
        a: {
          handler: async () => {
            throw new Error('fail');
          },
          retries: 1,
        },
      },
    });

    // First run — fails
    const run1 = await wf.start({}, { idempotencyKey: 'order:200' });
    await wf.execute(run1._id);
    const failed = await wf.get(run1._id);
    expect(failed?.status).toBe('failed');

    // Retry with same key — should create new run
    const run2 = await wf.start({}, { idempotencyKey: 'order:200' });
    expect(run2._id).not.toBe(run1._id);
  });

  it('should allow reuse of idempotency key after workflow is cancelled', async () => {
    const wf = env.workflow('idemp-cancel-reuse', {
      steps: {
        a: async (ctx) => ctx.wait('waiting'),
      },
    });

    const run1 = await wf.start({}, { idempotencyKey: 'order:300' });
    await wf.execute(run1._id);
    await wf.cancel(run1._id);

    // Same key — should create new run
    const run2 = await wf.start({}, { idempotencyKey: 'order:300' });
    expect(run2._id).not.toBe(run1._id);
  });

  it('should block duplicate while run is still active', async () => {
    const wf = env.workflow('idemp-active-block', {
      steps: {
        a: async (ctx) => ctx.wait('waiting'),
      },
    });

    const run1 = await wf.start({}, { idempotencyKey: 'order:400' });
    await wf.execute(run1._id);

    // Run is waiting (non-terminal) — same key should return existing
    const run2 = await wf.start({}, { idempotencyKey: 'order:400' });
    expect(run2._id).toBe(run1._id);
  });
});

// ============================================================================
// 2. Concurrency Draft Promotion
// ============================================================================

describe('Concurrency draft promotion', () => {
  it('should promote queued draft when active run completes (via executeRetry)', async () => {
    let stepCalls = 0;

    const wf = env.workflow<{ userId: string }, { userId: string }>('conc-promote', {
      steps: {
        process: async () => {
          stepCalls++;
          return 'done';
        },
      },
      concurrency: { limit: 1, key: (input) => input.userId },
      context: (input) => ({ userId: input.userId }),
    });

    // First run takes the slot
    const run1 = await wf.start({ userId: 'u1' });
    expect(run1.status).toBe('running');

    // Second run should be queued as draft
    const run2 = await wf.start({ userId: 'u1' });
    expect(run2.status).toBe('draft');

    // Verify draft has concurrencyKey + concurrencyLimit stored
    const draftDoc = await env.runs.get(run2._id);
    expect(draftDoc?.concurrencyKey).toBe('u1');
    expect(concurrencyLimitOf(draftDoc?.meta)).toBe(1);

    // Complete run1 — frees the slot
    await wf.execute(run1._id);
    const completed = await env.runs.get(run1._id);
    expect(completed?.status).toBe('done');

    // executeRetry should now promote the draft (slot is free). Completing run1
    // also fires the engine's own immediate promotion; the two race for ONE
    // claim, so assert the outcome — promoted, run exactly once — not the winner.
    await wf.engine.executeRetry(run2._id);
    await env.until(run2._id, 'done', { timeout: 2000 });
    expect(stepCalls).toBe(2);
  });

  it('should NOT promote draft when concurrency slot is still occupied', async () => {
    const wf = env.workflow<{ userId: string }, { userId: string }>('conc-block', {
      steps: {
        process: async (ctx) => {
          return ctx.wait('hold slot open');
        },
      },
      concurrency: { limit: 1, key: (input) => input.userId },
      context: (input) => ({ userId: input.userId }),
    });

    // Run1 takes the slot and holds it (waiting)
    const run1 = await wf.start({ userId: 'u1' });
    await wf.execute(run1._id);
    const waiting = await env.runs.get(run1._id);
    expect(waiting?.status).toBe('waiting');

    // Run2 queued as draft
    const run2 = await wf.start({ userId: 'u1' });
    expect(run2.status).toBe('draft');

    // Attempt promotion — should return null (slot still occupied by waiting run1)
    const result = await wf.engine.executeRetry(run2._id);
    expect(result).toBeNull();

    // Draft should still be draft
    const stillDraft = await env.runs.get(run2._id);
    expect(stillDraft?.status).toBe('draft');
  });

  it('should auto-promote draft when active run completes (no manual intervention)', async () => {
    let stepCalls = 0;

    const wf = env.workflow<{ userId: string }, { userId: string }>('conc-auto-promote', {
      steps: {
        process: async () => {
          stepCalls++;
          await new Promise((r) => setTimeout(r, 30));
          return 'done';
        },
      },
      concurrency: { limit: 1, key: (input) => input.userId },
      context: (input) => ({ userId: input.userId }),
    });

    // Run1 takes the slot
    const run1 = await wf.start({ userId: 'u1' });
    expect(run1.status).toBe('running');

    // Run2 queued as draft
    const run2 = await wf.start({ userId: 'u1' });
    expect(run2.status).toBe('draft');

    // Complete run1 — engine.execute() reaches terminal state,
    // which triggers promoteConcurrencyDrafts() via setImmediate
    await wf.execute(run1._id);

    // Wait for the automatic promotion (setImmediate + execute)
    const promoted = await env.until(run2._id, 'done');

    expect(promoted.status).toBe('done');
    expect(stepCalls).toBe(2);
  });

  it('should promote multiple drafts when slots free (chain reaction)', async () => {
    let stepCalls = 0;

    const wf = env.workflow<{ userId: string }, { userId: string }>('conc-chain', {
      steps: {
        process: async () => {
          stepCalls++;
          await new Promise((r) => setTimeout(r, 20));
          return `call-${stepCalls}`;
        },
      },
      concurrency: { limit: 1, key: (i) => i.userId },
      context: (i) => ({ userId: i.userId }),
    });

    // Fill slot
    const run1 = await wf.start({ userId: 'u1' });

    // Queue 2 drafts
    const run2 = await wf.start({ userId: 'u1' });
    const run3 = await wf.start({ userId: 'u1' });
    expect(run2.status).toBe('draft');
    expect(run3.status).toBe('draft');

    // Complete run1 — triggers auto-promotion of run2
    // run2 completing triggers auto-promotion of run3 (chain reaction)
    await wf.execute(run1._id);

    // Wait for the chain to complete all 3
    const done = await env.untilCount({ workflowId: wf.engine.definition.id, status: 'done' }, 3);

    expect(done).toHaveLength(3);
    expect(stepCalls).toBe(3);
  });

  it('should store concurrencyLimit in meta for scheduler', async () => {
    const wf = env.workflow<{ userId: string }, { userId: string }>('conc-meta', {
      steps: { a: async () => 'ok' },
      concurrency: { limit: 3, key: (input) => input.userId },
      context: (input) => ({ userId: input.userId }),
    });

    const run = await wf.start({ userId: 'u1' });
    const doc = await env.runs.get(run._id);
    expect(concurrencyLimitOf(doc?.meta)).toBe(3);
  });
});

// ============================================================================
// 3. Trigger Cleanup Safety
// ============================================================================

describe('Trigger cleanup on shared bus', () => {
  it('should not remove other workflows trigger listeners on shutdown', async () => {
    // Both workflows share the env container — and so one event bus.
    const wf1 = env.workflow('trigger-safe-1', {
      steps: { a: async () => 'ok' },
      trigger: { event: 'shared.event' },
    });

    const wf2 = env.workflow('trigger-safe-2', {
      steps: { a: async () => 'ok' },
      trigger: { event: 'shared.event' },
    });

    // Shutdown wf1 — should NOT remove wf2's listener
    wf1.shutdown();

    // Fire the event — wf2 should still get it
    env.container.eventBus.emit('shared.event', { data: { test: true } });

    // wf2 should have started a run
    const wf2Runs = await env.untilCount({ workflowId: wf2.engine.definition.id }, 1);
    expect(wf2Runs.length).toBeGreaterThanOrEqual(1);

    // wf1 should NOT have started — give a live listener the same window again
    // to land a run before asserting none did.
    await new Promise((r) => setTimeout(r, 100));
    const wf1Runs = await env.runModel.countDocuments({ workflowId: wf1.engine.definition.id });
    expect(wf1Runs).toBe(0);
  });
});
