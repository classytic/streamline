/**
 * Hands-off / human-in-the-loop: read-only inspection of pending hooks.
 *
 * Covers `getHookByToken` (inspect one parked approval before resuming — for
 * authz / rendering a card) and `listPendingHooks` (the operator "pending
 * approvals" queue), plus the `reason` / `metadata` authoring surface on
 * `createHook`. These are read-only: they never mutate a run (resuming is
 * `resumeHook`), and they are fail-closed on the token (parity with
 * `validateHookToken`).
 */

import { describe, expect, it } from 'vitest';
import {
  createHook,
  createWorkflow,
  getHookByToken,
  listPendingHooks,
  resumeHook,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++n}`;

/**
 * `start()` resolves while execution is still async — the run is `running`
 * and parks to `waiting` a tick later when the step throws its WaitSignal.
 * Poll until it's parked (or time out) before inspecting the hook.
 */
async function waitUntilParked(
  wf: { get: (id: string) => Promise<{ status: string } | null> },
  runId: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await wf.get(runId);
    if (r?.status === 'waiting') return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not reach 'waiting' within ${timeoutMs}ms`);
}

/**
 * A workflow that parks on a human approval. Uses a DETERMINISTIC token
 * (`${runId}:approve`) so the test can resume/inspect it without scraping the
 * random suffix — real callers emit the random-suffixed token to their UI.
 * The token still starts with `${runId}:` so `getHookByToken`/`resumeHook`
 * can parse the run id.
 */
function approvalWorkflow(wfId: string, metadata?: unknown) {
  return createWorkflow(wfId, {
    steps: {
      request: async (ctx) => {
        const hook = createHook(ctx, 'manager approval', {
          token: `${ctx.runId}:approve`,
          metadata,
        });
        return ctx.wait(hook.reason, { hookToken: hook.token, metadata: hook.metadata });
      },
      finalize: async (ctx) => {
        const decision = ctx.getOutput<{ approved: boolean }>('request');
        return { done: true, approved: decision?.approved ?? false };
      },
    },
  });
}

describe('hands-off: pending-hook inspection', () => {
  useTestDb();

  it('surfaces a parked wait by token and in the pending list, then clears on resume', async () => {
    const wfId = uid('approval');
    const wf = approvalWorkflow(wfId, { allowedReviewers: ['u_42'] });

    const run = await wf.start({ docId: 'd1' });
    await waitUntilParked(wf, run._id);

    const token = `${run._id}:approve`;

    const hook = await getHookByToken(token);
    expect(hook).not.toBeNull();
    expect(hook).toMatchObject({
      token,
      runId: run._id,
      workflowId: wfId,
      stepId: 'request',
      reason: 'manager approval',
      metadata: { allowedReviewers: ['u_42'] },
    });
    expect(hook?.waitingSince).toBeInstanceOf(Date);

    const pending = await listPendingHooks({ workflowId: wfId });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.token).toBe(token);
    expect(pending[0]?.metadata).toEqual({ allowedReviewers: ['u_42'] });

    // Resume → the waiting step completes and the run advances.
    await resumeHook(token, { approved: true });

    // After resume the hook is gone from BOTH surfaces (run no longer waiting).
    expect(await getHookByToken(token)).toBeNull();
    expect(await listPendingHooks({ workflowId: wfId })).toHaveLength(0);

    wf.shutdown();
  });

  it('fail-closed: a wrong/guessed/malformed token returns null', async () => {
    const wfId = uid('approval-guess');
    const wf = approvalWorkflow(wfId);

    const run = await wf.start({});
    await waitUntilParked(wf, run._id);

    // Right run prefix, wrong suffix — must NOT match (mirrors resume validation).
    expect(await getHookByToken(`${run._id}:WRONG`)).toBeNull();
    // Unknown run id.
    expect(await getHookByToken('nonexistent:approve')).toBeNull();
    // Malformed / empty.
    expect(await getHookByToken('')).toBeNull();

    wf.shutdown();
  });

  it('listPendingHooks scopes by workflowId; unscoped sees all waiting workflows', async () => {
    const wfIdA = uid('appr-A');
    const wfIdB = uid('appr-B');
    const wfA = approvalWorkflow(wfIdA);
    const wfB = approvalWorkflow(wfIdB);

    const runA = await wfA.start({});
    const runB = await wfB.start({});
    await waitUntilParked(wfA, runA._id);
    await waitUntilParked(wfB, runB._id);

    const onlyA = await listPendingHooks({ workflowId: wfIdA });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.workflowId).toBe(wfIdA);

    const all = await listPendingHooks({});
    const ids = all.map((h) => h.workflowId);
    expect(ids).toContain(wfIdA);
    expect(ids).toContain(wfIdB);

    wfA.shutdown();
    wfB.shutdown();
  });

  it('createHook echoes reason + metadata for one-place forwarding to ctx.wait', () => {
    // Pure authoring-surface check — no DB. createHook only reads runId/stepId.
    const fakeCtx = { runId: 'r1', stepId: 's1' } as unknown as Parameters<typeof createHook>[0];

    const hook = createHook(fakeCtx, 'review', { metadata: { title: 'Q2 report' } });

    expect(hook.reason).toBe('review');
    expect(hook.metadata).toEqual({ title: 'Q2 report' });
    expect(hook.token.startsWith('r1:s1:')).toBe(true);
    expect(hook.path).toBe(`/hooks/${hook.token}`);
  });
});
