/**
 * Conformance-style invariants for wait resolution (timeout / cancel / resume).
 *
 * The hands-off feature touches the durable resume path + the scheduler, so the
 * properties that matter are concurrency + at-most-once, NOT happy-path output
 * (that's covered in hooks-wait-resolution.test.ts). These tests assert the
 * invariants DETERMINISTICALLY — they drive `engine.resume(...)` directly
 * (the exact operation the scheduler's expiry sweep performs) rather than
 * waiting on the wall-clock poll loop, so there's no timing flakiness.
 *
 * Invariants:
 *   INV-1  A resolved wait advances the workflow EXACTLY ONCE, even when an
 *          external resume and the expiry resume race (the `waiting → running`
 *          CAS is the single winner).
 *   INV-2  External resume wins → a later expiry resume is a rejected no-op
 *          (at-most-once; the real payload is preserved, not overwritten).
 *   INV-3  Expiry wins → a later external `resumeHook` is rejected (the wait is
 *          already resolved; the timeout sentinel is preserved).
 *   INV-4  `cancelHook` withdraws the WAIT, not the run (it proceeds to `done`,
 *          not `cancelled`); a second cancel is rejected.
 */

import { describe, expect, it } from 'vitest';
import { makeWaitTimeout } from '../../src/features/wait-resolution.js';
import {
  cancelHook,
  createHook,
  getWaitResolution,
  InvalidStateError,
  resumeHook,
} from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** Observable: how many times each run's post-wait `decide` step executed. */
const decideRuns = new Map<string, number>();

type DecideOut = { kind: string; reason?: string | null };
const decideOutput = (run: { steps?: Array<{ stepId: string; output?: unknown }> } | null) =>
  run?.steps?.find((s) => s.stepId === 'decide')?.output as DecideOut;

/**
 * Flow with a deterministic token and a high poll interval — these tests drive
 * resume manually, so the scheduler must NOT also fire and create a 3-way race.
 * No `expiresAt` is set on the wait, so the scheduler's expiry sweep matches
 * nothing; we simulate expiry by calling `engine.resume(runId, makeWaitTimeout())`.
 */
function flow() {
  return env.workflow('inv', {
    steps: {
      request: async (ctx) => {
        const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:approve` });
        return ctx.wait(hook.reason, { hookToken: hook.token });
      },
      decide: async (ctx) => {
        decideRuns.set(ctx.runId, (decideRuns.get(ctx.runId) ?? 0) + 1);
        const resolution = getWaitResolution(ctx.getOutput('request'));
        return {
          kind: resolution?.__waitResolved ?? 'answered',
          reason: resolution?.reason ?? null,
        };
      },
    },
    autoExecute: true,
    // Far higher than any test runtime — the manual resume drives completion,
    // not the poll loop, so nothing here races our explicit calls.
    scheduler: { basePollInterval: 60_000, minPollInterval: 60_000, maxPollInterval: 60_000 },
  });
}

describe('wait-resolution invariants (race-safety / at-most-once)', () => {
  it('INV-1: external resume racing the expiry resume advances exactly once, no corruption', async () => {
    const wf = flow();
    const run = await wf.start({});
    await env.until(run._id, 'waiting');
    const token = `${run._id}:approve`;

    // True race: external answer vs the scheduler's expiry operation.
    const results = await Promise.allSettled([
      resumeHook(token, { approved: true }, { container: env.container }),
      wf.engine.resume(run._id, makeWaitTimeout()),
    ]);

    const final = await env.until(run._id, 'done');

    // The CAS picks one winner — `decide` runs exactly once (no double-execute).
    expect(decideRuns.get(run._id)).toBe(1);
    // Output is one coherent resolution, never a corrupted mix.
    expect(['answered', 'timeout']).toContain(decideOutput(final).kind);
    // At least one operation observably succeeded.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('INV-2: external resume wins → a later expiry resume is a rejected no-op (payload preserved)', async () => {
    const wf = flow();
    const run = await wf.start({});
    await env.until(run._id, 'waiting');
    const token = `${run._id}:approve`;

    await resumeHook(token, { approved: true }, { container: env.container });
    const afterResume = await env.until(run._id, 'done');
    expect(decideOutput(afterResume).kind).toBe('answered');

    // The expiry resume the scheduler would attempt is rejected on a settled run.
    await expect(wf.engine.resume(run._id, makeWaitTimeout())).rejects.toBeInstanceOf(
      InvalidStateError,
    );

    // No double-execute, payload not overwritten by the late timeout.
    expect(decideRuns.get(run._id)).toBe(1);
    const stable = await wf.get(run._id);
    expect(decideOutput(stable).kind).toBe('answered');
  });

  it('INV-3: expiry wins → a later external resumeHook is rejected (timeout preserved)', async () => {
    const wf = flow();
    const run = await wf.start({});
    await env.until(run._id, 'waiting');
    const token = `${run._id}:approve`;

    await wf.engine.resume(run._id, makeWaitTimeout());
    const afterExpiry = await env.until(run._id, 'done');
    expect(decideOutput(afterExpiry).kind).toBe('timeout');

    // The wait is already resolved — an external answer is rejected.
    await expect(
      resumeHook(token, { approved: true }, { container: env.container }),
    ).rejects.toBeTruthy();

    expect(decideRuns.get(run._id)).toBe(1);
    const stable = await wf.get(run._id);
    expect(decideOutput(stable).kind).toBe('timeout');
  });

  it('INV-4: cancelHook withdraws the wait (run → done, not cancelled); double cancel rejected', async () => {
    const wf = flow();
    const run = await wf.start({});
    await env.until(run._id, 'waiting');
    const token = `${run._id}:approve`;

    await cancelHook(token, { reason: 'withdrawn', container: env.container });
    const final = await env.until(run._id, 'done');

    // The RUN proceeds to completion — cancel withdraws the wait, not the run.
    expect(final.status).toBe('done');
    expect(decideOutput(final)).toMatchObject({ kind: 'cancelled', reason: 'withdrawn' });
    expect(decideRuns.get(run._id)).toBe(1);

    // A second cancel finds nothing to withdraw.
    await expect(
      cancelHook(token, { reason: 'again', container: env.container }),
    ).rejects.toBeTruthy();
    expect(decideRuns.get(run._id)).toBe(1);
  });
});
