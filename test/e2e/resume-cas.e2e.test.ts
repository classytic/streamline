/**
 * E2E regression for the resumeStep waiting-step CAS (v2.4.0 hardening #2).
 *
 * THE BUG: `resumeStep` checked the LOCALLY-loaded step was `waiting`, but the
 * durable update guarded only `{ _id, status: { $ne: 'cancelled' } }`. Two
 * concurrent `engine.resume(runId, A)` / `(runId, B)` could BOTH pass the local
 * check (each loaded the run while still waiting) and BOTH write the step
 * `done` (last-write-wins) — double-emitting `workflow:resumed` and
 * double-advancing the run (next step runs twice).
 *
 * THE FIX: the durable resume write is a numeric-index CAS guarded on the step
 * STILL being `waiting` (`'steps.<i>.status': 'waiting'`). modifiedCount===0 ⇒
 * a concurrent writer already resumed → no-op (no re-advance, no re-emit).
 *
 * PRE-FIX: against the old guard, both resumes write `done`, the `count` step
 * runs twice (resumeCount===2) and two `workflow:resumed` events fire — the
 * assertions below (exactly one) fail. With the fix they pass.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('resumeStep waiting-step CAS', () => {
  it('two concurrent resumes with different payloads → exactly one wins, advances once', async () => {
    let countRuns = 0;
    let resumedEvents = 0;
    const seenPayloads: unknown[] = [];

    const workflow = env.workflow<{ approval?: unknown }>('resume-cas', {
      steps: {
        gate: async (ctx) => {
          await ctx.wait('awaiting approval', {});
        },
        count: async (ctx) => {
          // The next step after the resumed wait — must execute exactly once.
          countRuns++;
          await ctx.set('approval', ctx.getOutput('gate'));
          return { counted: true };
        },
      },
      context: () => ({}),
    });

    const onResumed = (payload: { data?: unknown }) => {
      resumedEvents++;
      seenPayloads.push(payload.data);
    };
    env.container.eventBus.on('workflow:resumed', onResumed);

    try {
      const run = await workflow.start({});
      await workflow.execute(run._id);

      const waiting = await workflow.get(run._id);
      expect(waiting?.status).toBe('waiting');
      expect(waiting?.currentStepId).toBe('gate');

      // Fire two concurrent resumes with DIFFERENT payloads.
      await Promise.allSettled([
        workflow.resume(run._id, { approver: 'A' }),
        workflow.resume(run._id, { approver: 'B' }),
      ]);

      await env.until(run._id, 'done');
      // Window for a (buggy) second advance / second resumed event to land.
      await new Promise((r) => setTimeout(r, 150));
      const final = await workflow.get(run._id);
      expect(final?.status).toBe('done');
      if (!final) throw new Error('run vanished');

      // EXACTLY ONE winner: the next step ran once, one resume event fired.
      expect(countRuns).toBe(1);
      expect(resumedEvents).toBe(1);

      // The persisted gate output and the count step's recorded approval agree
      // (no torn last-write-wins between the two payloads).
      const gateStep = final.steps.find((s) => s.stepId === 'gate');
      expect(gateStep?.status).toBe('done');
      expect(final.context.approval).toEqual(gateStep?.output);
      expect(seenPayloads).toHaveLength(1);
      expect(gateStep?.output).toEqual(seenPayloads[0]);
    } finally {
      env.container.eventBus.off('workflow:resumed', onResumed);
    }
  });
});
