/**
 * Hands-off / human-in-the-loop: wait resolution beyond a normal answer.
 *
 *   - `expiresAt` — the scheduler's expiry sweep auto-resumes a parked human
 *     wait with a `{ __waitResolved: 'timeout' }` sentinel once the deadline
 *     passes, so an unanswered approval can't wedge a long-running workflow.
 *   - `cancelHook(token)` — a host withdraws a pending wait; the step resumes
 *     with `{ __waitResolved: 'cancelled', reason }`.
 *   - normal `resumeHook` — still delivers the real payload (`getWaitResolution`
 *     returns `null`), proving the sentinels don't leak into the happy path.
 *
 * `getWaitResolution` is how the NEXT step discriminates the three.
 */

import { describe, expect, it } from 'vitest';
import { makeWaitCancelled, makeWaitTimeout } from '../../src/features/wait-resolution.js';
import { cancelHook, createHook, getWaitResolution, resumeHook } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** Shared step that records how the `request` wait resolved. */
type DecideOut = { kind: string; reason?: string | null; approved?: boolean };
function decideStepOutput(run: { steps?: Array<{ stepId: string; output?: unknown }> }): DecideOut {
  return run.steps?.find((s) => s.stepId === 'decide')?.output as DecideOut;
}

/**
 * Approval flow with a fast scheduler (so the expiry sweep fires in-test
 * rather than on the 60s production cadence) and a deterministic token.
 */
function approvalFlow(opts?: { expiresInMs?: number }) {
  return env.workflow('appr', {
    steps: {
      request: async (ctx) => {
        const hook = createHook(ctx, 'manager approval', {
          token: `${ctx.runId}:approve`,
          ...(opts?.expiresInMs !== undefined
            ? { expiresAt: new Date(Date.now() + opts.expiresInMs) }
            : {}),
        });
        return ctx.wait(hook.reason, {
          hookToken: hook.token,
          ...(hook.expiresAt ? { expiresAt: hook.expiresAt } : {}),
        });
      },
      decide: async (ctx) => {
        const out = ctx.getOutput('request');
        const resolution = getWaitResolution(out);
        if (resolution)
          return { kind: resolution.__waitResolved, reason: resolution.reason ?? null };
        return { kind: 'answered', approved: (out as { approved?: boolean })?.approved ?? false };
      },
    },
    autoExecute: true,
    scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
  });
}

describe('hands-off: wait resolution (timeout / cancel / normal)', () => {
  it('expiresAt: the scheduler auto-resumes a timed-out wait with a timeout sentinel', async () => {
    const wf = approvalFlow({ expiresInMs: 150 });

    const run = await wf.start({});
    await env.until(run._id, 'waiting');

    // No one resumes — the background scheduler's expiry sweep (the subject
    // here) must drive it to completion once the deadline passes.
    const final = await env.until(run._id, 'done', { timeout: 8000 });
    expect(decideStepOutput(final)).toMatchObject({ kind: 'timeout' });
  });

  it('cancelHook: withdraws a pending wait with a cancelled sentinel + reason', async () => {
    const wf = approvalFlow();

    const run = await wf.start({});
    await env.until(run._id, 'waiting');

    await cancelHook(`${run._id}:approve`, {
      reason: 'request was deleted',
      container: env.container,
    });

    const final = await env.until(run._id, 'done');
    expect(decideStepOutput(final)).toMatchObject({
      kind: 'cancelled',
      reason: 'request was deleted',
    });
  });

  it('normal resumeHook still delivers the real payload (no sentinel leakage)', async () => {
    const wf = approvalFlow();

    const run = await wf.start({});
    await env.until(run._id, 'waiting');

    await resumeHook(`${run._id}:approve`, { approved: true }, { container: env.container });

    const final = await env.until(run._id, 'done');
    expect(decideStepOutput(final)).toMatchObject({ kind: 'answered', approved: true });
  });

  it('getWaitResolution discriminates the sentinels (unit)', () => {
    const timeout = makeWaitTimeout();
    const cancelled = makeWaitCancelled('withdrawn');

    expect(getWaitResolution(timeout)).toMatchObject({ __waitResolved: 'timeout' });
    expect(getWaitResolution(cancelled)).toMatchObject({
      __waitResolved: 'cancelled',
      reason: 'withdrawn',
    });

    // Real payloads / junk resolve to null (happy path is untouched).
    expect(getWaitResolution({ approved: true })).toBeNull();
    expect(getWaitResolution(null)).toBeNull();
    expect(getWaitResolution('done')).toBeNull();
    expect(getWaitResolution({ __waitResolved: 'bogus' })).toBeNull();

    // makeWaitCancelled omits `reason` when not given.
    expect(makeWaitCancelled()).not.toHaveProperty('reason');
  });
});
