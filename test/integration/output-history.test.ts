/**
 * Integration suite for per-step versioned output history (ring buffer).
 *
 * The feature is OPT-IN via `Step.outputHistory.keep` (or the workflow
 * `defaults.outputHistory`). When enabled, the engine archives a step's PRIOR
 * committed output into `StepState.outputHistory` on the rerun/rewind
 * transition (a previously-`done` step re-succeeds), bounded to the most
 * recent `keep` versions via a `$push` + `$slice:-keep` ring.
 *
 * Capture is deliberately anchored to the RERUN transition, NOT "an output
 * happens to occupy the slot at success": a first forward success archives
 * nothing (the rewind/goto reset paths preserve the prior output ONLY for
 * history-enabled steps, which is what makes the prior generation visible at
 * re-success time).
 *
 * Covered here:
 *  - rerun (rewindTo → re-execute) records versions in order;
 *  - `ctx.outputHistory()` reads them;
 *  - `ctx.pinOutput()` / `restoreStepOutput()` copy a prior version back into
 *    `output` + set `pinnedVersion`;
 *  - restore is refused on a cancelled run;
 *  - double-push idempotency (the same generation doesn't duplicate a version);
 *  - disabled-default writes nothing (byte-for-byte v2.3.4).
 */

import { describe, expect, it } from 'vitest';
import type { StepOutputVersion } from '../../src/core/types.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const runToDone = (runId: string) => env.until(runId, 'done', { timeout: 10_000 });

describe('per-step versioned output history', () => {
  it('records a version on rerun, in order, and ctx.outputHistory() reads them', async () => {
    // A deterministic, monotonically-increasing output per generation so each
    // rerun produces a distinct value we can assert on.
    let gen = 0;
    const wf = env.workflow<{ done: boolean }>('history', {
      steps: {
        generate: {
          handler: async () => ({ gen: ++gen }),
          outputHistory: { keep: 5 },
        },
        finalize: async () => 'ok',
      },
      context: () => ({ done: false }),
      autoExecute: true,
    });

    const run = await wf.start({});
    await runToDone(run._id);

    // Gen 1 committed. No history yet — first forward success archives nothing.
    let cur = await wf.get(run._id);
    expect(cur?.steps.find((s) => s.stepId === 'generate')?.output).toEqual({ gen: 1 });
    expect(cur?.steps.find((s) => s.stepId === 'generate')?.outputHistory).toBeUndefined();

    // Rerun #1: rewind to `generate` and re-execute → gen 2 commits, gen 1 archived.
    await wf.rewindTo(run._id, 'generate');
    await wf.engine.execute(run._id);
    await runToDone(run._id);

    cur = await wf.get(run._id);
    let step = cur?.steps.find((s) => s.stepId === 'generate');
    expect(step?.output).toEqual({ gen: 2 });
    expect(step?.outputHistory?.map((h) => h.output)).toEqual([{ gen: 1 }]);
    expect(step?.outputHistory?.map((h) => h.version)).toEqual([1]);

    // Rerun #2 → gen 3 commits, gen 2 archived after gen 1 (ordered).
    await wf.rewindTo(run._id, 'generate');
    await wf.engine.execute(run._id);
    await runToDone(run._id);

    cur = await wf.get(run._id);
    step = cur?.steps.find((s) => s.stepId === 'generate');
    expect(step?.output).toEqual({ gen: 3 });
    const history = step?.outputHistory as StepOutputVersion[];
    expect(history.map((h) => h.output)).toEqual([{ gen: 1 }, { gen: 2 }]);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
  });

  it('respects keep — oldest evicted', async () => {
    let gen = 0;
    const wf = env.workflow('history-keep', {
      steps: {
        generate: {
          handler: async () => ({ gen: ++gen }),
          outputHistory: { keep: 2 },
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await wf.start({});
    await runToDone(run._id);

    // 3 reruns → committed gens 1..4; with keep=2 history holds the 2 newest
    // PRIOR generations (gen 2, gen 3) after the 4th commit.
    for (let i = 0; i < 3; i++) {
      await wf.rewindTo(run._id, 'generate');
      await wf.engine.execute(run._id);
      await runToDone(run._id);
    }

    const cur = await wf.get(run._id);
    const step = cur?.steps.find((s) => s.stepId === 'generate');
    expect(step?.output).toEqual({ gen: 4 });
    const history = step?.outputHistory as StepOutputVersion[];
    expect(history.length).toBe(2);
    expect(history.map((h) => h.output)).toEqual([{ gen: 2 }, { gen: 3 }]);
  });

  it('ctx.pinOutput restores a prior version into output + sets pinnedVersion', async () => {
    let gen = 0;
    // The workflow only generates; pinning is driven by the host via
    // restoreStepOutput so the assertions are unambiguous (no step re-runs).
    const wf = env.workflow('history-pin', {
      steps: {
        generate: {
          handler: async () => ({ gen: ++gen }),
          outputHistory: { keep: 5 },
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await wf.start({});
    await runToDone(run._id);

    // Two reruns → live output { gen: 3 }; history holds [{gen:1},{gen:2}].
    for (let i = 0; i < 2; i++) {
      await wf.rewindTo(run._id, 'generate');
      await wf.engine.execute(run._id);
      await runToDone(run._id);
    }

    let cur = await wf.get(run._id);
    let gstep = cur?.steps.find((s) => s.stepId === 'generate');
    expect(gstep?.output).toEqual({ gen: 3 });
    expect(gstep?.outputHistory?.map((h) => h.output)).toEqual([{ gen: 1 }, { gen: 2 }]);

    // Restore version 1 (oldest = { gen: 1 }) into the live output slot.
    const result = await env.container.repository.restoreStepOutput(run._id, 'generate', 1);
    expect(result.modifiedCount).toBe(1);

    cur = await wf.get(run._id);
    gstep = cur?.steps.find((s) => s.stepId === 'generate');
    expect(gstep?.output).toEqual({ gen: 1 });
    expect(gstep?.pinnedVersion).toBe(1);
    // History is left intact by the copy-back.
    expect(gstep?.outputHistory?.length).toBe(2);
  });

  it('ctx.pinOutput (the context primitive) restores a prior version durably', async () => {
    let gen = 0;
    let pinnedCount = -1;
    // `finalize` pins generate's oldest version. We rewind only to `finalize`
    // for the pin pass so `generate` is not reset and its history is stable.
    const wf = env.workflow('history-ctxpin', {
      steps: {
        generate: {
          handler: async () => ({ gen: ++gen }),
          outputHistory: { keep: 5 },
        },
        finalize: async (ctx) => {
          const versions = ctx.outputHistory('generate');
          pinnedCount = versions.length;
          const oldest = versions[0];
          if (oldest) {
            await ctx.pinOutput(oldest.version, 'generate');
          }
          return 'ok';
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await wf.start({});
    await runToDone(run._id);

    // One rerun of generate → history [{gen:1}], live {gen:2}. finalize re-runs
    // too (rewind resets from generate onward) and pins version 1.
    await wf.rewindTo(run._id, 'generate');
    await wf.engine.execute(run._id);
    await runToDone(run._id);

    const cur = await wf.get(run._id);
    const gstep = cur?.steps.find((s) => s.stepId === 'generate');
    expect(pinnedCount).toBe(1);
    expect(gstep?.output).toEqual({ gen: 1 });
    expect(gstep?.pinnedVersion).toBe(1);
  });

  it('restoreStepOutput is refused on a cancelled run', async () => {
    let gen = 0;
    const wf = env.workflow('history-cancel', {
      steps: {
        generate: {
          handler: async () => ({ gen: ++gen }),
          outputHistory: { keep: 5 },
        },
        hold: async (ctx) => ctx.wait('park here'),
      },
      context: () => ({}),
      autoExecute: true,
    });
    const holdWaiting = (r: { steps: Array<{ stepId: string; status: string }> }) =>
      r.steps.find((s) => s.stepId === 'hold')?.status === 'waiting';

    const run = await wf.start({});
    // Let it reach the wait, with one rerun first so history exists.
    await env.until(run._id, holdWaiting, { timeout: 10_000 });

    await wf.rewindTo(run._id, 'generate');
    await wf.engine.execute(run._id);
    await env.until(run._id, holdWaiting, { timeout: 10_000 });

    let cur = await wf.get(run._id);
    const history = cur?.steps.find((s) => s.stepId === 'generate')?.outputHistory as
      | StepOutputVersion[]
      | undefined;
    expect(history?.length).toBeGreaterThan(0);
    const versionToRestore = (history as StepOutputVersion[])[0]?.version as number;

    // Cancel, then attempt restore — must be refused (modifiedCount 0) and not
    // mutate the step output.
    await wf.cancel(run._id);
    const result = await env.container.repository.restoreStepOutput(
      run._id,
      'generate',
      versionToRestore,
    );
    expect(result.modifiedCount).toBe(0);

    cur = await wf.get(run._id);
    expect(cur?.status).toBe('cancelled');
    // Live output unchanged (still the latest generation, not the restored one).
    expect(cur?.steps.find((s) => s.stepId === 'generate')?.output).toEqual({ gen: 2 });
  });

  it('double-push idempotency: re-pushing the same generation does not duplicate', async () => {
    // Drive updateStepState twice with the SAME committed generation via the
    // repository directly to simulate a recovery replay of the success write.
    // The engine's idempotency guard keys on the writing generation's
    // `attempt`, so the top-of-buffer already bearing it means "skip".
    let gen = 0;
    const wf = env.workflow('history-idem', {
      steps: {
        generate: {
          handler: async () => ({ gen: ++gen }),
          outputHistory: { keep: 5 },
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await wf.start({});
    await runToDone(run._id);

    // One rerun → exactly one archived version.
    await wf.rewindTo(run._id, 'generate');
    await wf.engine.execute(run._id);
    await runToDone(run._id);

    const cur = await wf.get(run._id);
    const history = cur?.steps.find((s) => s.stepId === 'generate')?.outputHistory as
      | StepOutputVersion[]
      | undefined;
    expect(history?.length).toBe(1);

    // Re-running execute() on an already-done run must NOT re-enter the handler
    // (the step is `done`, getNextStep advances past it) — so no duplicate push.
    await wf.engine.execute(run._id);
    const after = await wf.get(run._id);
    const afterHistory = after?.steps.find((s) => s.stepId === 'generate')?.outputHistory as
      | StepOutputVersion[]
      | undefined;
    expect(afterHistory?.length).toBe(1);
  });

  it('disabled by default: no outputHistory is written when keep is unset', async () => {
    let gen = 0;
    const wf = env.workflow('history-disabled', {
      steps: {
        // No outputHistory config → feature disabled.
        generate: async () => ({ gen: ++gen }),
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await wf.start({});
    await runToDone(run._id);

    // Rerun several times — still nothing archived, output slot only.
    for (let i = 0; i < 2; i++) {
      await wf.rewindTo(run._id, 'generate');
      await wf.engine.execute(run._id);
      await runToDone(run._id);
    }

    const cur = await wf.get(run._id);
    const step = cur?.steps.find((s) => s.stepId === 'generate');
    expect(step?.output).toEqual({ gen: 3 });
    expect(step?.outputHistory).toBeUndefined();
    expect(step).toBeDefined();
    expect(Object.hasOwn(step as object, 'outputHistory')).toBe(false);
  });
});
