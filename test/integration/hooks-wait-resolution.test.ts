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
import {
  cancelHook,
  createHook,
  createWorkflow,
  getWaitResolution,
  resumeHook,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(
  wf: { get: (id: string) => Promise<{ status: string } | null> },
  runId: string,
  statuses: string[],
  timeoutMs = 8000,
): Promise<{ status: string } & Record<string, unknown>> {
  const want = new Set(statuses);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = (await wf.get(runId)) as ({ status: string } & Record<string, unknown>) | null;
    if (r && want.has(r.status)) return r;
    await sleep(30);
  }
  throw new Error(`run ${runId} did not reach [${statuses}] within ${timeoutMs}ms`);
}

/** Shared step that records how the `request` wait resolved. */
type DecideOut = { kind: string; reason?: string | null; approved?: boolean };
function decideStepOutput(run: { steps?: Array<{ stepId: string; output?: unknown }> }): DecideOut {
  return run.steps?.find((s) => s.stepId === 'decide')?.output as DecideOut;
}

/**
 * Approval flow with a fast scheduler (so the expiry sweep fires in-test
 * rather than on the 60s production cadence) and a deterministic token.
 */
function approvalFlow(wfId: string, opts?: { expiresInMs?: number }) {
  return createWorkflow(wfId, {
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
    scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
  });
}

describe('hands-off: wait resolution (timeout / cancel / normal)', () => {
  useTestDb();

  it('expiresAt: the scheduler auto-resumes a timed-out wait with a timeout sentinel', async () => {
    const wfId = uid('appr-timeout');
    const wf = approvalFlow(wfId, { expiresInMs: 150 });

    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);

    // No one resumes — the expiry sweep should drive it to completion.
    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideStepOutput(final)).toMatchObject({ kind: 'timeout' });

    wf.shutdown();
  });

  it('cancelHook: withdraws a pending wait with a cancelled sentinel + reason', async () => {
    const wfId = uid('appr-cancel');
    const wf = approvalFlow(wfId);

    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);

    await cancelHook(`${run._id}:approve`, { reason: 'request was deleted' });

    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideStepOutput(final)).toMatchObject({
      kind: 'cancelled',
      reason: 'request was deleted',
    });

    wf.shutdown();
  });

  it('normal resumeHook still delivers the real payload (no sentinel leakage)', async () => {
    const wfId = uid('appr-normal');
    const wf = approvalFlow(wfId);

    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);

    await resumeHook(`${run._id}:approve`, { approved: true });

    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideStepOutput(final)).toMatchObject({ kind: 'answered', approved: true });

    wf.shutdown();
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
