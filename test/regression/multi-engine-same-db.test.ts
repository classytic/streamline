/**
 * Regression: two engine instances of the SAME workflow id sharing ONE database.
 *
 * Mirrors a real deployment hazard hit by sniffer-orchestrator: a deployed dev
 * service and a local dev server both run the `sniffer-job` workflow against the
 * same Mongo `workflow_runs` collection. Symptom: a run started by engine A is
 * aborted/cancelled almost immediately during its first step
 * ("workflow … has been cancelled"), then reaped as stalled — jobs never run.
 *
 * This test reproduces the topology in isolation: engine A starts a run; engine
 * B exists for the same workflow on the same DB (its scheduler/retention poll
 * the shared collection). The run MUST complete, not be cancelled by B.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { setupTestDB, cleanupTestDB, teardownTestDB, waitFor } from '../utils/setup.js';

describe('Multi-engine same-DB regression', () => {
  beforeAll(async () => { await setupTestDB(); });
  afterEach(async () => { await cleanupTestDB(); });
  afterAll(async () => { await teardownTestDB(); });

  it('a run started by engine A is not cancelled by a second engine B (same workflow, same DB)', async () => {
    const def = {
      steps: {
        // Same shape as sniffer-job's setup step: a quick step that calls ctx.set.
        setup: async (ctx: { set: (k: string, v: unknown) => Promise<void> }) => {
          await ctx.set('ready', true);
          return { ok: true };
        },
        work: async () => {
          await waitFor(50);
          return { done: true };
        },
      },
      context: () => ({ ready: false }),
    };

    const engineA = createWorkflow('sniffer-job-repro', def as never);
    const engineB = createWorkflow('sniffer-job-repro', def as never); // 2nd engine, same id, same DB

    const run = await engineA.start({});
    await waitFor(500);
    const result = await engineA.get(run._id);

    // The crux: B must not abort/cancel A's freshly-started run.
    expect(result?.status, `run ended ${result?.status} — steps: ${JSON.stringify(result?.steps?.map((s: { stepId: string; status: string }) => ({ id: s.stepId, status: s.status })))}`).toBe('done');

    engineA.shutdown();
    engineB.shutdown();
  });
});
