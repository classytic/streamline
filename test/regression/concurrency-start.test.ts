/**
 * Regression: a run under STRICT per-key concurrency must execute, not be
 * cancelled/stranded.
 *
 * Mirrors sniffer-orchestrator's `sniffer-job` workflow, which sets
 * `concurrency: { limit, key: companyId }`. Symptom in the field: the first
 * step is aborted immediately ("workflow … has been cancelled") and the run is
 * later reaped as stalled. The only config the passing core tests don't
 * exercise is strict concurrency + the draft→promote scheduler path — so this
 * isolates it.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { setupTestDB, cleanupTestDB, teardownTestDB, waitFor } from '../utils/setup.js';

const def = (key: string) => ({
  concurrency: { limit: 1, key: () => key },
  steps: {
    setup: async (ctx: { set: (k: string, v: unknown) => Promise<void> }) => {
      await ctx.set('ready', true); // same shape as sniffer-job setup
      return { ok: true };
    },
    work: async () => { await waitFor(50); return { done: true }; },
  },
  context: () => ({ ready: false }),
});

describe('Strict concurrency start regression', () => {
  beforeAll(async () => { await setupTestDB(); });
  afterEach(async () => { await cleanupTestDB(); });
  afterAll(async () => { await teardownTestDB(); });

  it('a single run under a strict concurrency limit completes (not cancelled)', async () => {
    const wf = createWorkflow('conc-repro-1', def('tenant-x') as never);
    const run = await wf.start({});
    await waitFor(600);
    const r = await wf.get(run._id);
    expect(
      r?.status,
      `status=${r?.status} steps=${JSON.stringify((r?.steps as { stepId: string; status: string }[])?.map((s) => ({ id: s.stepId, status: s.status })))}`,
    ).toBe('done');
    wf.shutdown();
  });

  it('two runs of the same key both complete (second queues + promotes, not cancelled)', async () => {
    const wf = createWorkflow('conc-repro-2', def('tenant-y') as never);
    const a = await wf.start({});
    const b = await wf.start({}); // exceeds limit=1 → should queue as draft, then promote
    await waitFor(1200);
    const ra = await wf.get(a._id);
    const rb = await wf.get(b._id);
    expect(ra?.status, `A=${ra?.status}`).toBe('done');
    expect(rb?.status, `B=${rb?.status}`).toBe('done');
    wf.shutdown();
  });
});
