import { describe, expect, it } from 'vitest';
import type { WorkflowEventBus } from '../../src/core/events.js';
import type { WorkflowRun } from '../../src/core/types.js';
import { StepContextImpl, WaitSignal } from '../../src/execution/context.js';
import {
  type ApprovalDecision,
  type AnswerResult,
  ask,
  readAnswer,
  readApprovalDecision,
  requestApproval,
} from '../../src/features/approval.js';
import { makeWaitCancelled, makeWaitTimeout } from '../../src/features/wait-resolution.js';
import type { WorkflowRunRepository } from '../../src/storage/run.repository.js';

// The primitives are pure composition over hooks + wait-resolution: the
// decision READERS are total functions over a step's output, and the gate
// helpers only mint a hook + park the run (a WaitSignal). Neither touches the
// DB, so minimal stubs suffice.
function makeCtx(runId = 'run-1', stepId = 'gate'): StepContextImpl {
  const run = { _id: runId, steps: [{ stepId, status: 'running' }] } as unknown as WorkflowRun;
  return new StepContextImpl(
    runId,
    stepId,
    {},
    undefined,
    0,
    run,
    {} as unknown as WorkflowRunRepository,
    {} as unknown as WorkflowEventBus,
  );
}

// What `approve` / `reject` / `answer` put on the wire (their resume payload),
// reconstructed here so the readers are tested against the exact marker shape
// the resume side produces — a round-trip contract without a live engine.
const approvedPayload = (data?: unknown) => ({ __approvalDecision: 'approved', ...(data !== undefined ? { data } : {}) });
const rejectedPayload = (reason?: string) => ({ __approvalDecision: 'rejected', ...(reason !== undefined ? { reason } : {}) });
const answeredPayload = (value: unknown) => ({ __askAnswer: value });

describe('readApprovalDecision', () => {
  it('maps an approve payload → approved (with data)', () => {
    expect(readApprovalDecision(approvedPayload({ note: 'LGTM' }))).toEqual<ApprovalDecision>({
      status: 'approved',
      data: { note: 'LGTM' },
    });
    expect(readApprovalDecision(approvedPayload())).toEqual<ApprovalDecision>({ status: 'approved' });
  });

  it('maps a reject payload → rejected (with reason)', () => {
    expect(readApprovalDecision(rejectedPayload('off-brand'))).toEqual<ApprovalDecision>({
      status: 'rejected',
      reason: 'off-brand',
    });
  });

  it('maps the cancelled sentinel → withdrawn (carrying the reason)', () => {
    expect(readApprovalDecision(makeWaitCancelled('source deleted'))).toEqual<ApprovalDecision>({
      status: 'withdrawn',
      reason: 'source deleted',
    });
  });

  it('maps the timeout sentinel → timed_out', () => {
    expect(readApprovalDecision(makeWaitTimeout())).toEqual<ApprovalDecision>({ status: 'timed_out' });
  });

  it('returns null for a non-approval output (unrelated step / still waiting)', () => {
    expect(readApprovalDecision(undefined)).toBeNull();
    expect(readApprovalDecision({ some: 'other output' })).toBeNull();
    expect(readApprovalDecision('a string')).toBeNull();
  });
});

describe('readAnswer', () => {
  it('maps an answer payload → answered with the typed value', () => {
    expect(readAnswer<string>(answeredPayload('481920'))).toEqual<AnswerResult<string>>({
      status: 'answered',
      value: '481920',
    });
  });

  it('preserves falsy / structured answer values', () => {
    expect(readAnswer<number>(answeredPayload(0))).toEqual({ status: 'answered', value: 0 });
    expect(readAnswer<{ x: number }>(answeredPayload({ x: 1 }))).toEqual({
      status: 'answered',
      value: { x: 1 },
    });
  });

  it('maps withdrawal + timeout the same way as approvals', () => {
    expect(readAnswer(makeWaitCancelled('abandoned'))).toEqual({
      status: 'withdrawn',
      reason: 'abandoned',
    });
    expect(readAnswer(makeWaitTimeout())).toEqual({ status: 'timed_out' });
  });

  it('returns null for a non-answer output', () => {
    expect(readAnswer(undefined)).toBeNull();
    expect(readAnswer(approvedPayload())).toBeNull(); // an approval is not an answer
  });
});

describe('requestApproval / ask — gate parking', () => {
  async function park(fn: () => Promise<never>): Promise<WaitSignal> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof WaitSignal) return e;
      throw e;
    }
    throw new Error('expected the gate to park with a WaitSignal');
  }

  it('requestApproval hands the token to onToken BEFORE parking, then waits carrying token + deadline', async () => {
    const ctx = makeCtx('run-7', 'review');
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    let handed: string | undefined;

    const signal = await park(() =>
      requestApproval(ctx, {
        reason: 'Publish?',
        expiresAt,
        onToken: (t) => {
          handed = t;
        },
      }),
    );

    expect(handed).toMatch(/^run-7:review:/); // token = runId:stepId:random
    expect(signal.type).toBe('human');
    const data = signal.data as { hookToken: string; expiresAt: Date };
    expect(data.hookToken).toBe(handed); // the SAME token the approver will use
    expect(data.expiresAt).toBe(expiresAt); // deadline forwarded so the sweep can expire it
  });

  it('ask parks the same way and threads a reused idempotent token', async () => {
    const ctx = makeCtx('run-8', 'askOtp');
    const signal = await park(() => ask(ctx, { question: 'OTP?', token: 'fixed-token' }));
    expect((signal.data as { hookToken: string }).hookToken).toBe('fixed-token');
  });
});
