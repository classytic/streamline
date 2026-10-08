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

import { describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowRun } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Multi-engine same-DB regression', () => {
  it('a run started by engine A is not cancelled by a second engine B (same workflow, same DB)', async () => {
    const def: WorkflowConfig<{ ready: boolean }> = {
      steps: {
        // Same shape as sniffer-job's setup step: a quick step that calls ctx.set.
        setup: async (ctx) => {
          await ctx.set('ready', true);
          return { ok: true };
        },
        work: async () => {
          await new Promise((r) => setTimeout(r, 50)); // simulated work
          return { done: true };
        },
      },
      context: () => ({ ready: false }),
      autoExecute: true,
    };

    const engineA = env.workflow('sniffer-job-repro', def);
    // 2nd engine: same id, same DB, its own process-level state (container).
    env.worker(engineA, def);

    const run = await engineA.start({});
    const result = await env.until(run._id, (r: WorkflowRun) =>
      ['done', 'failed', 'cancelled'].includes(r.status),
    );

    // The crux: B must not abort/cancel A's freshly-started run.
    expect(
      result.status,
      `run ended ${result.status} — steps: ${JSON.stringify(result.steps.map((s) => ({ id: s.stepId, status: s.status })))}`,
    ).toBe('done');
  });
});
