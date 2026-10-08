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
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('recoverStale clears startedAt on the reset step (Finding #4)', () => {
  it('the reset (running→pending) write leaves startedAt absent', async () => {
    // A workflow whose single step parks on a wait, so after recoverStale
    // re-drives it the step does NOT immediately re-complete — keeps the run
    // observable. (We assert on the RESET write, captured below, regardless.)
    const wf = env.workflow('recover-stale-startedat', {
      steps: {
        only: async (ctx) => ctx.waitFor('go'),
      },
    });

    // The post-crash shape: status:running, step:running with an OLD
    // startedAt and a STALE lastHeartbeat (so recoverStale's stale claim fires).
    const run = await env.runs.staleRunning(wf, { step: 'only' });
    expect(run.steps[0]?.startedAt).toBeInstanceOf(Date); // the field the reset must clear

    // Capture the persisted step state at the instant the reset write lands.
    const repo = wf.engine.container.repository;
    const origUpdateOne = repo.updateOne;
    let resetStartedAt: unknown = '__not-captured__';
    repo.updateOne = (async (...args: Parameters<typeof origUpdateOne>) => {
      const result = await origUpdateOne.apply(repo, args);
      const set = (args[1] as { $set?: Record<string, unknown> } | undefined)?.$set;
      // The reset write is the one flipping the step back to 'pending'.
      if (set && set['steps.0.status'] === 'pending') {
        const fresh = await env.runs.get(run._id);
        resetStartedAt = fresh?.steps?.[0]?.startedAt;
      }
      return result;
    }) as typeof origUpdateOne;

    try {
      // Drive recovery with a small stale threshold so the old heartbeat qualifies.
      await wf.engine.recoverStale(run._id, 60_000);
    } finally {
      repo.updateOne = origUpdateOne; // the env's repository outlives this test
    }

    // The reset write must have been observed AND it cleared startedAt.
    expect(resetStartedAt).not.toBe('__not-captured__');
    expect(resetStartedAt).toBeUndefined();
  });
});
