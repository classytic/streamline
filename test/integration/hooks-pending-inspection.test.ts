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
import { createHook, getHookByToken, listPendingHooks, resumeHook } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/**
 * A workflow that parks on a human approval. Uses a DETERMINISTIC token
 * (`${runId}:approve`) so the test can resume/inspect it without scraping the
 * random suffix — real callers emit the random-suffixed token to their UI.
 * The token still starts with `${runId}:` so `getHookByToken`/`resumeHook`
 * can parse the run id.
 *
 * `start()` resolves while execution is still async — the run is `running`
 * and parks to `waiting` a tick later when the step throws its WaitSignal, so
 * every test waits for `waiting` before inspecting the hook.
 */
function approvalWorkflow(name: string, metadata?: unknown) {
  return env.workflow(name, {
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
    autoExecute: true,
  });
}

describe('hands-off: pending-hook inspection', () => {
  it('surfaces a parked wait by token and in the pending list, then clears on resume', async () => {
    const wf = approvalWorkflow('approval', { allowedReviewers: ['u_42'] });
    const wfId = wf.engine.definition.id;
    const { container } = env;

    const run = await wf.start({ docId: 'd1' });
    await env.until(run._id, 'waiting');

    const token = `${run._id}:approve`;

    const hook = await getHookByToken(token, { container });
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

    const pending = await listPendingHooks({ workflowId: wfId, container });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.token).toBe(token);
    expect(pending[0]?.metadata).toEqual({ allowedReviewers: ['u_42'] });

    // Resume → the waiting step completes and the run advances.
    await resumeHook(token, { approved: true }, { container });

    // After resume the hook is gone from BOTH surfaces (run no longer waiting).
    expect(await getHookByToken(token, { container })).toBeNull();
    expect(await listPendingHooks({ workflowId: wfId, container })).toHaveLength(0);
  });

  it('fail-closed: a wrong/guessed/malformed token returns null', async () => {
    const wf = approvalWorkflow('approval-guess');
    const { container } = env;

    const run = await wf.start({});
    await env.until(run._id, 'waiting');

    // Right run prefix, wrong suffix — must NOT match (mirrors resume validation).
    expect(await getHookByToken(`${run._id}:WRONG`, { container })).toBeNull();
    // Unknown run id.
    expect(await getHookByToken('nonexistent:approve', { container })).toBeNull();
    // Malformed / empty.
    expect(await getHookByToken('', { container })).toBeNull();
  });

  it('listPendingHooks scopes by workflowId; unscoped sees all waiting workflows', async () => {
    const wfA = approvalWorkflow('appr-A');
    const wfB = approvalWorkflow('appr-B');
    const wfIdA = wfA.engine.definition.id;
    const wfIdB = wfB.engine.definition.id;
    const { container } = env;

    const runA = await wfA.start({});
    const runB = await wfB.start({});
    await env.until(runA._id, 'waiting');
    await env.until(runB._id, 'waiting');

    const onlyA = await listPendingHooks({ workflowId: wfIdA, container });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.workflowId).toBe(wfIdA);

    const all = await listPendingHooks({ container });
    const ids = all.map((h) => h.workflowId);
    expect(ids).toContain(wfIdA);
    expect(ids).toContain(wfIdB);
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
