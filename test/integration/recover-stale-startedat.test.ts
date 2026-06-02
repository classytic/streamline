/**
 * Regression for Finding #4 — recoverStale's step reset dropped `startedAt`.
 *
 * THE BUG: `engine.recoverStale` reset a crashed running step with
 * `$set: { 'steps.i.startedAt': undefined }`. The Mongo driver STRIPS undefined
 * values from update docs, so the operator was a no-op and `startedAt` survived
 * — leaving a wrong `durationMs` baseline for the re-run.
 *
 * THE FIX: use `$unset: { 'steps.i.startedAt': '' }` (matches the sibling reset
 * in `executor.claimStepExecution`), which actually clears the field.
 *
 * THE TEST: persist a stale `running` run whose running step carries an old
 * `startedAt`. Instrument the repository to capture the persisted step state at
 * the moment of the reset write (status→pending). Pre-fix the captured state
 * still has `startedAt`; post-fix it is gone.
 */

import { describe, expect, it } from 'vitest';
import { createWorkflow, WorkflowRunModel } from '../../src/index.js';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import { useTestDb } from '../helpers/lifecycle.js';

describe('recoverStale clears startedAt on the reset step (Finding #4)', () => {
  useTestDb();

  it('the reset (running→pending) write leaves startedAt absent', async () => {
    const wfId = 'recover-stale-startedat';
    const runId = 'stale-run-1';

    // A workflow whose single step parks on a wait, so after recoverStale
    // re-drives it the step does NOT immediately re-complete — keeps the run
    // observable. (We assert on the RESET write, captured below, regardless.)
    const wf = createWorkflow(wfId, {
      steps: {
        only: async (ctx) => ctx.waitFor('go'),
      },
      autoExecute: false,
    });

    // Persist the post-crash shape: status:running, step:running with an OLD
    // startedAt and a STALE lastHeartbeat (so recoverStale's stale claim fires).
    const oldStarted = new Date(Date.now() - 10 * 60_000);
    await WorkflowRunModel.create({
      _id: runId,
      workflowId: wfId,
      status: 'running',
      steps: [
        {
          stepId: 'only',
          status: 'running',
          attempts: 1,
          startedAt: oldStarted,
        } as StepState,
      ],
      currentStepId: 'only',
      context: {},
      input: {},
      createdAt: oldStarted,
      updatedAt: oldStarted,
      startedAt: oldStarted,
      lastHeartbeat: oldStarted, // stale
    } as unknown as WorkflowRun);

    // Capture the persisted step state at the instant the reset write lands.
    const repo = wf.engine.container.repository;
    const origUpdateOne = repo.updateOne.bind(repo);
    let resetStartedAt: unknown = '__not-captured__';
    (repo as unknown as { updateOne: typeof origUpdateOne }).updateOne = (async (
      filter: unknown,
      update: unknown,
      options?: unknown,
    ) => {
      const result = await origUpdateOne(filter as never, update as never, options as never);
      const set = (update as { $set?: Record<string, unknown> } | undefined)?.$set;
      // The reset write is the one flipping the step back to 'pending'.
      if (set && set['steps.0.status'] === 'pending') {
        const fresh = await WorkflowRunModel.findById(runId).lean();
        resetStartedAt = fresh?.steps?.[0]?.startedAt;
      }
      return result;
    }) as typeof origUpdateOne;

    // Drive recovery with a small stale threshold so the old heartbeat qualifies.
    await wf.engine.recoverStale(runId, 60_000);

    // The reset write must have been observed AND it cleared startedAt.
    expect(resetStartedAt).not.toBe('__not-captured__');
    expect(resetStartedAt).toBeUndefined();

    wf.shutdown();
  });
});
