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

import { describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowRun } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

type Ctx = { ready: boolean };

const def = (key: string): WorkflowConfig<Ctx> => ({
  concurrency: { limit: 1, key: () => key },
  steps: {
    setup: async (ctx) => {
      await ctx.set('ready', true); // same shape as sniffer-job setup
      return { ok: true };
    },
    work: async () => {
      await new Promise((r) => setTimeout(r, 50)); // simulated work
      return { done: true };
    },
  },
  context: () => ({ ready: false }),
  // The field symptom is on the engine's own execution path.
  autoExecute: true,
});

const terminal = (run: WorkflowRun) => ['done', 'failed', 'cancelled'].includes(run.status);
const describeSteps = (run: WorkflowRun) =>
  JSON.stringify(run.steps.map((s) => ({ id: s.stepId, status: s.status })));

describe('Strict concurrency start regression', () => {
  it('a single run under a strict concurrency limit completes (not cancelled)', async () => {
    const wf = env.workflow('conc-repro-1', def('tenant-x'));
    const run = await wf.start({});
    const r = await env.until(run._id, terminal);
    expect(r.status, `status=${r.status} steps=${describeSteps(r)}`).toBe('done');
  });

  it('two runs of the same key both complete (second queues + promotes, not cancelled)', async () => {
    const wf = env.workflow('conc-repro-2', def('tenant-y'));
    const a = await wf.start({});
    const b = await wf.start({}); // exceeds limit=1 → should queue as draft, then promote
    // No tick: the engine must promote B on its own once A frees the slot.
    const ra = await env.until(a._id, terminal);
    const rb = await env.until(b._id, terminal);
    expect(ra.status, `A=${ra.status}`).toBe('done');
    expect(rb.status, `B=${rb.status}`).toBe('done');
  });
});
