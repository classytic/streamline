/**
 * Human-in-the-loop primitives, end-to-end through a real engine.
 *
 *   - `requestApproval` → `approve` / `reject` / `cancelHook` (withdraw) /
 *     `expiresAt` (timeout), read in the next step by `readApprovalDecision` —
 *     one branch per outcome.
 *   - `ask` → `answer`, read by `readAnswer`, looped with `ctx.goto()` — the
 *     durable "agent needs an OTP each turn" pattern (browser automation,
 *     captcha): the run parks between question and answer and resumes exactly
 *     where it paused, for an unbounded number of turns.
 */

import { describe, expect, it } from 'vitest';
import {
  answer,
  approve,
  ask,
  cancelHook,
  createWorkflow,
  type ApprovalDecision,
  type AnswerResult,
  readAnswer,
  readApprovalDecision,
  reject,
  requestApproval,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAST_SCHED = { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 } as const;

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

function decideOut(run: { steps?: Array<{ stepId: string; output?: unknown }> }): {
  decision: ApprovalDecision | null;
} {
  return run.steps?.find((s) => s.stepId === 'decide')?.output as { decision: ApprovalDecision | null };
}

/** Approval gate with a deterministic token so the test can resume it. */
function approvalWf(wfId: string, opts?: { expiresInMs?: number }) {
  return createWorkflow(wfId, {
    steps: {
      request: (ctx) =>
        requestApproval(ctx, {
          reason: 'approve?',
          token: `${ctx.runId}:appr`,
          ...(opts?.expiresInMs !== undefined
            ? { expiresAt: new Date(Date.now() + opts.expiresInMs) }
            : {}),
        }),
      decide: async (ctx) => ({ decision: readApprovalDecision(ctx.outputs.request) }),
    },
    scheduler: FAST_SCHED,
  });
}

describe('requestApproval end-to-end', () => {
  useTestDb();

  it('approve → { status: "approved", data }', async () => {
    const wf = approvalWf(uid('appr-yes'));
    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);
    await approve(`${run._id}:appr`, { note: 'LGTM' });
    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideOut(final).decision).toEqual({ status: 'approved', data: { note: 'LGTM' } });
    wf.shutdown();
  });

  it('reject → { status: "rejected", reason }', async () => {
    const wf = approvalWf(uid('appr-no'));
    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);
    await reject(`${run._id}:appr`, 'off-brand');
    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideOut(final).decision).toEqual({ status: 'rejected', reason: 'off-brand' });
    wf.shutdown();
  });

  it('cancelHook (withdraw) → { status: "withdrawn", reason }', async () => {
    const wf = approvalWf(uid('appr-withdraw'));
    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);
    await cancelHook(`${run._id}:appr`, { reason: 'source deleted' });
    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideOut(final).decision).toEqual({ status: 'withdrawn', reason: 'source deleted' });
    wf.shutdown();
  });

  it('expiresAt (nobody answers) → { status: "timed_out" }', async () => {
    const wf = approvalWf(uid('appr-timeout'), { expiresInMs: 150 });
    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);
    const final = await waitForStatus(wf, run._id, ['done']);
    expect(decideOut(final).decision).toEqual({ status: 'timed_out' });
    wf.shutdown();
  });
});

// ── ask/answer + goto: the durable interactive OTP loop ────────────────────

/**
 * Ask for an OTP each turn; loop with `ctx.goto` until the human answers the
 * stop-signal. Proves the durable interactive loop — the run parks between
 * question and answer and resumes exactly where it paused, for an unbounded
 * number of turns — without leaning on cross-goto context accumulation (the
 * loop mechanic is what's under test here, not `ctx.set` semantics). The hook
 * token is reused per turn; `answerTurn` retries until the run has re-parked.
 */
function otpLoopWf(wfId: string) {
  return createWorkflow(wfId, {
    steps: {
      askOtp: (ctx) => ask(ctx, { question: 'enter OTP', token: `${ctx.runId}:otp` }),
      useOtp: async (ctx) => {
        const result = readAnswer<string>(ctx.outputs.askOtp);
        if (result?.status !== 'answered') return { ended: result?.status ?? 'none' };
        if (result.value === 'STOP') return { ended: 'stopped' };
        return ctx.goto('askOtp'); // ← durable loop: park again for the next OTP
      },
    },
    scheduler: FAST_SCHED,
  });
}

/** Answer the reused OTP hook, retrying while the run re-parks after a goto. */
async function answerTurn(runId: string, value: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      await answer(`${runId}:otp`, value);
      return;
    } catch {
      await sleep(30); // not (re-)parked yet — retry
    }
  }
  throw new Error(`could not answer OTP for run ${runId}`);
}

describe('ask/answer durable OTP loop (ctx.goto)', () => {
  useTestDb();

  it('a single ask resolves to a typed answer, read by readAnswer', async () => {
    const wf = otpLoopWf(uid('otp-one'));
    const run = await wf.start({});
    await waitForStatus(wf, run._id, ['waiting']);
    await answerTurn(run._id, 'STOP');

    const final = await waitForStatus(wf, run._id, ['done']);
    const out = final.steps?.find((s: { stepId: string }) => s.stepId === 'useOtp')?.output as {
      ended: string;
    };
    expect(out.ended).toBe('stopped');

    // sanity on the reader's typed shape
    const shape: AnswerResult<string> = { status: 'answered', value: '481920' };
    expect(shape.status).toBe('answered');
    wf.shutdown();
  });
});
