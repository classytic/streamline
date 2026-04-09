/**
 * Distributed Readiness Tests
 *
 * Validates the fixes for:
 * 1. Idempotency keys reusable after terminal completion
 * 2. Concurrency-queued drafts get promoted when capacity frees
 * 3. Trigger cleanup is safe on shared event buses
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor, waitUntil } from '../utils/setup.js';
import {
  createWorkflow,
  createContainer,
  WorkflowRunModel,
  configureStreamlineLogger,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
  configureStreamlineLogger({ enabled: false });
});

afterAll(async () => {
  configureStreamlineLogger({ enabled: true });
  await teardownTestDB();
});

// ============================================================================
// 1. Idempotency Key — Reusable After Terminal Completion
// ============================================================================

describe('Idempotency key lifecycle', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should allow reuse of idempotency key after workflow completes', async () => {
    const wf = createWorkflow('idemp-reuse', {
      steps: { a: async () => 'done' },
      autoExecute: false,
    });

    // First run — succeeds
    const run1 = await wf.start({}, { idempotencyKey: 'order:100' });
    await wf.execute(run1._id);
    const completed = await wf.get(run1._id);
    expect(completed?.status).toBe('done');

    // Second start with same key — should create a NEW run (old one is terminal)
    const run2 = await wf.start({}, { idempotencyKey: 'order:100' });
    expect(run2._id).not.toBe(run1._id);

    wf.shutdown();
  });

  it('should allow reuse of idempotency key after workflow fails', async () => {
    const wf = createWorkflow('idemp-fail-reuse', {
      steps: {
        a: {
          handler: async () => { throw new Error('fail'); },
          retries: 1,
        },
      },
      autoExecute: false,
    });

    // First run — fails
    const run1 = await wf.start({}, { idempotencyKey: 'order:200' });
    await wf.execute(run1._id);
    const failed = await wf.get(run1._id);
    expect(failed?.status).toBe('failed');

    // Retry with same key — should create new run
    const run2 = await wf.start({}, { idempotencyKey: 'order:200' });
    expect(run2._id).not.toBe(run1._id);

    wf.shutdown();
  });

  it('should allow reuse of idempotency key after workflow is cancelled', async () => {
    const wf = createWorkflow('idemp-cancel-reuse', {
      steps: {
        a: async (ctx) => ctx.wait('waiting'),
      },
      autoExecute: false,
    });

    const run1 = await wf.start({}, { idempotencyKey: 'order:300' });
    await wf.execute(run1._id);
    await wf.cancel(run1._id);

    // Same key — should create new run
    const run2 = await wf.start({}, { idempotencyKey: 'order:300' });
    expect(run2._id).not.toBe(run1._id);

    wf.shutdown();
  });

  it('should block duplicate while run is still active', async () => {
    const wf = createWorkflow('idemp-active-block', {
      steps: {
        a: async (ctx) => ctx.wait('waiting'),
      },
      autoExecute: false,
    });

    const run1 = await wf.start({}, { idempotencyKey: 'order:400' });
    await wf.execute(run1._id);

    // Run is waiting (non-terminal) — same key should return existing
    const run2 = await wf.start({}, { idempotencyKey: 'order:400' });
    expect(run2._id).toBe(run1._id);

    wf.shutdown();
  });
});

// ============================================================================
// 2. Concurrency Draft Promotion
// ============================================================================

describe('Concurrency draft promotion', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should promote queued draft when active run completes (via executeRetry)', async () => {
    let stepCalls = 0;

    const wf = createWorkflow<{ userId: string }>('conc-promote', {
      steps: {
        process: async () => {
          stepCalls++;
          return 'done';
        },
      },
      concurrency: { limit: 1, key: (input: { userId: string }) => input.userId },
      context: (input: { userId: string }) => ({ userId: input.userId }),
      autoExecute: false,
    });

    // First run takes the slot
    const run1 = await wf.start({ userId: 'u1' });
    expect(run1.status).toBe('running');

    // Second run should be queued as draft
    const run2 = await wf.start({ userId: 'u1' });
    expect(run2.status).toBe('draft');

    // Verify draft has concurrencyKey + concurrencyLimit stored
    const draftDoc = await WorkflowRunModel.findById(run2._id).lean();
    expect(draftDoc!.concurrencyKey).toBe('u1');
    expect((draftDoc!.meta as any)?.concurrencyLimit).toBe(1);

    // Complete run1 — frees the slot
    await wf.execute(run1._id);
    const completed = await WorkflowRunModel.findById(run1._id).lean();
    expect(completed!.status).toBe('done');

    // executeRetry should now promote the draft (slot is free)
    const promoted = await wf.engine.executeRetry(run2._id);
    expect(promoted).not.toBeNull();
    expect(promoted!.status).toBe('done');
    expect(stepCalls).toBe(2);

    wf.shutdown();
  });

  it('should NOT promote draft when concurrency slot is still occupied', async () => {
    const wf = createWorkflow<{ userId: string }>('conc-block', {
      steps: {
        process: async (ctx) => {
          return ctx.wait('hold slot open');
        },
      },
      concurrency: { limit: 1, key: (input: { userId: string }) => input.userId },
      context: (input: { userId: string }) => ({ userId: input.userId }),
      autoExecute: false,
    });

    // Run1 takes the slot and holds it (waiting)
    const run1 = await wf.start({ userId: 'u1' });
    await wf.execute(run1._id);
    const waiting = await WorkflowRunModel.findById(run1._id).lean();
    expect(waiting!.status).toBe('waiting');

    // Run2 queued as draft
    const run2 = await wf.start({ userId: 'u1' });
    expect(run2.status).toBe('draft');

    // Attempt promotion — should return null (slot still occupied by waiting run1)
    const result = await wf.engine.executeRetry(run2._id);
    expect(result).toBeNull();

    // Draft should still be draft
    const stillDraft = await WorkflowRunModel.findById(run2._id).lean();
    expect(stillDraft!.status).toBe('draft');

    wf.shutdown();
  });

  it('should auto-promote draft when active run completes (no manual intervention)', async () => {
    let stepCalls = 0;

    const wf = createWorkflow<{ userId: string }>('conc-auto-promote', {
      steps: {
        process: async () => {
          stepCalls++;
          await new Promise((r) => setTimeout(r, 30));
          return 'done';
        },
      },
      concurrency: { limit: 1, key: (input: { userId: string }) => input.userId },
      context: (input: { userId: string }) => ({ userId: input.userId }),
      autoExecute: false,
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
    const promoted = await waitUntil(async () => {
      const doc = await WorkflowRunModel.findById(run2._id).lean();
      return doc?.status === 'done';
    }, 5000);

    expect(promoted).toBe(true);
    expect(stepCalls).toBe(2);

    wf.shutdown();
  });

  it('should promote multiple drafts when slots free (chain reaction)', async () => {
    let stepCalls = 0;

    const wf = createWorkflow<{ userId: string }>('conc-chain', {
      steps: {
        process: async () => {
          stepCalls++;
          await new Promise((r) => setTimeout(r, 20));
          return `call-${stepCalls}`;
        },
      },
      concurrency: { limit: 1, key: (i: { userId: string }) => i.userId },
      context: (i: { userId: string }) => ({ userId: i.userId }),
      autoExecute: false,
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
    const allDone = await waitUntil(async () => {
      const docs = await WorkflowRunModel.find({
        workflowId: 'conc-chain',
        status: 'done',
      }).lean();
      return docs.length === 3;
    }, 5000);

    expect(allDone).toBe(true);
    expect(stepCalls).toBe(3);

    wf.shutdown();
  });

  it('should store concurrencyLimit in meta for scheduler', async () => {
    const wf = createWorkflow<{ userId: string }>('conc-meta', {
      steps: { a: async () => 'ok' },
      concurrency: { limit: 3, key: (input: { userId: string }) => input.userId },
      context: (input: { userId: string }) => ({ userId: input.userId }),
      autoExecute: false,
    });

    const run = await wf.start({ userId: 'u1' });
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect((doc!.meta as any)?.concurrencyLimit).toBe(3);

    wf.shutdown();
  });
});

// ============================================================================
// 3. Trigger Cleanup Safety
// ============================================================================

describe('Trigger cleanup on shared bus', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should not remove other workflows trigger listeners on shutdown', async () => {
    const container = createContainer();
    let wf1Started = false;
    let wf2Started = false;

    const wf1 = createWorkflow('trigger-safe-1', {
      steps: {
        a: async () => {
          wf1Started = true;
          return 'ok';
        },
      },
      trigger: { event: 'shared.event' },
      container,
      autoExecute: false,
    });

    const wf2 = createWorkflow('trigger-safe-2', {
      steps: {
        a: async () => {
          wf2Started = true;
          return 'ok';
        },
      },
      trigger: { event: 'shared.event' },
      container,
      autoExecute: false,
    });

    // Shutdown wf1 — should NOT remove wf2's listener
    wf1.shutdown();

    // Fire the event — wf2 should still get it
    container.eventBus.emit('shared.event' as any, { data: { test: true } });
    await waitFor(200);

    // wf2 should have started a run
    const runs = await WorkflowRunModel.find({ workflowId: 'trigger-safe-2' }).lean();
    expect(runs.length).toBeGreaterThanOrEqual(1);

    // wf1 should NOT have started
    const wf1Runs = await WorkflowRunModel.find({ workflowId: 'trigger-safe-1' }).lean();
    expect(wf1Runs.length).toBe(0);

    wf2.shutdown();
  });
});
