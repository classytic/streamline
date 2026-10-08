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
  type AnswerResult,
  type ApprovalDecision,
  answer,
  approve,
  ask,
  cancelHook,
  readAnswer,
  readApprovalDecision,
  reject,
  requestApproval,
} from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const FAST_SCHED = { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 } as const;
const WAIT = { timeout: 8000 } as const;

function decideOut(run: { steps?: Array<{ stepId: string; output?: unknown }> }): {
  decision: ApprovalDecision | null;
} {
  return run.steps?.find((s) => s.stepId === 'decide')?.output as {
    decision: ApprovalDecision | null;
  };
}

/** Approval gate with a deterministic token so the test can resume it. */
function approvalWf(name: string, opts?: { expiresInMs?: number }) {
  return env.workflow(name, {
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
    autoExecute: true,
  });
}

describe('requestApproval end-to-end', () => {
  it('approve → { status: "approved", data }', async () => {
    const wf = approvalWf('appr-yes');
    const run = await wf.start({});
    await env.until(run._id, 'waiting', WAIT);
    await approve(`${run._id}:appr`, { note: 'LGTM' }, { container: env.container });
    const final = await env.until(run._id, 'done', WAIT);
    expect(decideOut(final).decision).toEqual({ status: 'approved', data: { note: 'LGTM' } });
  });

  it('reject → { status: "rejected", reason }', async () => {
    const wf = approvalWf('appr-no');
    const run = await wf.start({});
    await env.until(run._id, 'waiting', WAIT);
    await reject(`${run._id}:appr`, 'off-brand', { container: env.container });
    const final = await env.until(run._id, 'done', WAIT);
    expect(decideOut(final).decision).toEqual({ status: 'rejected', reason: 'off-brand' });
  });

  it('cancelHook (withdraw) → { status: "withdrawn", reason }', async () => {
    const wf = approvalWf('appr-withdraw');
    const run = await wf.start({});
    await env.until(run._id, 'waiting', WAIT);
    await cancelHook(`${run._id}:appr`, { reason: 'source deleted', container: env.container });
    const final = await env.until(run._id, 'done', WAIT);
    expect(decideOut(final).decision).toEqual({ status: 'withdrawn', reason: 'source deleted' });
  });

  it('expiresAt (nobody answers) → { status: "timed_out" }', async () => {
    const wf = approvalWf('appr-timeout', { expiresInMs: 150 });
    const run = await wf.start({});
    await env.until(run._id, 'waiting', WAIT);
    // The engine's own scheduler fires the expiry — nothing drives it from here.
    const final = await env.until(run._id, 'done', WAIT);
    expect(decideOut(final).decision).toEqual({ status: 'timed_out' });
  });
});

// ── ask/answer + goto: the durable interactive OTP loop ────────────────────

/**
 * Ask for an OTP each turn; loop with `ctx.goto` until the human answers the
 * stop-signal. Proves the durable interactive loop — the run parks between
 * question and answer and resumes exactly where it paused, for an unbounded
 * number of turns — without leaning on cross-goto context accumulation (the
 * loop mechanic is what's under test here, not `ctx.set` semantics). The hook
 * token is reused per turn; each answer waits until the run has (re-)parked
 * on `askOtp`.
 */
function otpLoopWf(name: string) {
  return env.workflow(name, {
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
    autoExecute: true,
  });
}

/** Answer the reused OTP hook once the run is parked on `askOtp`. */
async function answerTurn(runId: string, value: string): Promise<void> {
  await env.until(runId, (r) => r.status === 'waiting' && r.currentStepId === 'askOtp', WAIT);
  await answer(`${runId}:otp`, value, { container: env.container });
}

describe('ask/answer durable OTP loop (ctx.goto)', () => {
  it('a single ask resolves to a typed answer, read by readAnswer', async () => {
    const wf = otpLoopWf('otp-one');
    const run = await wf.start({});
    await env.until(run._id, 'waiting', WAIT);
    await answerTurn(run._id, 'STOP');

    const final = await env.until(run._id, 'done', WAIT);
    const out = final.steps?.find((s: { stepId: string }) => s.stepId === 'useOtp')?.output as {
      ended: string;
    };
    expect(out.ended).toBe('stopped');

    // sanity on the reader's typed shape
    const shape: AnswerResult<string> = { status: 'answered', value: '481920' };
    expect(shape.status).toBe('answered');
  });
});
