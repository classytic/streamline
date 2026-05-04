/**
 * Contract scenarios — pin behaviors that have been misunderstood / abused.
 *
 * Style: openclaw-style replay per
 * [`testing-infrastructure.md` §6](../../testing-infrastructure.md). Each
 * test is **Setup → Script → Assert**, asserting on persisted state and
 * emitted events.
 *
 * What this file pins:
 *
 * 1. **Webhook token safety.** `resumeHook` fails closed when no
 *    `hookToken` was stored on `ctx.wait`. Pre-fix any token starting with
 *    a valid runId could resume the workflow.
 *
 * 2. **Timeout/abort honest contract.** The engine sends an AbortSignal
 *    when a step times out, but if the handler ignores `ctx.signal`, the
 *    handler's promise chain keeps running in the background. The engine
 *    releases the workflow; the user code is on its own. Documented and
 *    tested so this doesn't surprise anyone.
 *
 * 3. **Child workflow cross-container completion.** When parent and child
 *    run on different containers, the parent now subscribes to BOTH buses
 *    so the child's completion event resumes the parent. Pre-fix the
 *    parent listened only on its own bus and missed cross-container
 *    completions.
 *
 * 4. **Concurrency & throttle are best-effort, not strict.** Already
 *    documented in code + README; this file pins the contract with a
 *    burst-of-N test that demonstrates the documented edge.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  createContainer,
  createHook,
  createWorkflow,
  globalEventBus,
  resumeHook,
  WorkflowRunModel,
  type WorkflowRun,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

describe('Webhook token safety — fail-closed when no stored token', () => {
  useTestDb();

  it('rejects resume when ctx.wait was called WITHOUT { hookToken }', async () => {
    // Setup: workflow that creates a hook but forgets to pass `hookToken`
    // to ctx.wait — the canonical pre-fix misuse pattern straight from the
    // old README example.
    let capturedHookToken = '';
    const wf = createWorkflow<{ docId: string }, { docId: string }>('hook-no-store', {
      steps: {
        request: async (ctx) => {
          const hook = createHook(ctx, 'awaiting-approval');
          capturedHookToken = hook.token;
          // ⚠️ MISUSE: not passing { hookToken: hook.token }
          await ctx.wait('Awaiting approval');
        },
        process: async () => 'done',
      },
    });

    const run = await wf.start({ docId: 'doc-1' });
    await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 }).catch(() => undefined);

    // The workflow must be waiting (the test only makes sense in that state).
    const waiting = await wf.get(run._id);
    expect(waiting?.status).toBe('waiting');

    // Script (1): try to resume with the LEGITIMATE token. Pre-fix this
    // worked because the validator silently accepted any token whose
    // runId-prefix matched. Post-fix it MUST throw because no `hookToken`
    // was stored on the waiting step.
    await expect(resumeHook(capturedHookToken, { approved: true })).rejects.toThrow(
      /no stored hookToken/i,
    );

    // Script (2): try with an attacker-guessed token (`<runId>:anything`).
    // Pre-fix this also worked. Post-fix: same fail-closed rejection.
    const attackerToken = `${run._id}:guessed:${'x'.repeat(32)}`;
    await expect(resumeHook(attackerToken, { approved: true })).rejects.toThrow(
      /no stored hookToken/i,
    );

    // The workflow remains waiting — neither attempt resumed it.
    const after = await wf.get(run._id);
    expect(after?.status).toBe('waiting');
  });

  it('accepts resume when ctx.wait stored { hookToken } AND token matches', async () => {
    // The canonical correct pattern from the post-fix README.
    let capturedHookToken = '';
    const wf = createWorkflow<{ docId: string }, { docId: string }>('hook-with-store', {
      steps: {
        request: async (ctx) => {
          const hook = createHook(ctx, 'awaiting-approval');
          capturedHookToken = hook.token;
          // ✅ CORRECT: pass hookToken so resumeHook can validate it
          await ctx.wait('Awaiting approval', { hookToken: hook.token });
        },
        process: async (ctx) => {
          const payload = ctx.getOutput<{ approved: boolean }>('request');
          return { approved: payload?.approved ?? false };
        },
      },
    });

    const run = await wf.start({ docId: 'doc-1' });
    await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 }).catch(() => undefined);
    expect((await wf.get(run._id))?.status).toBe('waiting');

    // Script (1): resume with the legitimate token — succeeds.
    const result = await resumeHook(capturedHookToken, { approved: true });
    expect(result.run.status === 'done' || result.run.status === 'running').toBe(true);
  });

  it('rejects resume when token does not match the stored token (different secret)', async () => {
    let capturedHookToken = '';
    const wf = createWorkflow<{ docId: string }, { docId: string }>('hook-token-mismatch', {
      steps: {
        request: async (ctx) => {
          const hook = createHook(ctx, 'awaiting-approval');
          capturedHookToken = hook.token;
          await ctx.wait('Awaiting approval', { hookToken: hook.token });
        },
        process: async () => 'done',
      },
    });

    const run = await wf.start({ docId: 'doc-1' });
    await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 }).catch(() => undefined);

    // Attacker has the runId but not the secret suffix — guess wrong.
    const wrongToken = `${run._id}:request:${'y'.repeat(32)}`;
    expect(wrongToken).not.toBe(capturedHookToken);
    await expect(resumeHook(wrongToken, { approved: true })).rejects.toThrow(
      /Invalid hook token/i,
    );

    // Workflow stays waiting.
    expect((await wf.get(run._id))?.status).toBe('waiting');
  });
});

describe('Timeout / abort — honest contract: AbortSignal sent, handler must opt in', () => {
  useTestDb();

  it('engine releases the workflow on timeout AND delivers abort, but cannot stop the handler', async () => {
    // Streamline's contract has TWO halves:
    //
    //   1. The engine must mark the step failed within `timeout` so the
    //      workflow doesn't appear hung. (Engine's responsibility.)
    //   2. The engine must deliver `ctx.signal.aborted = true` so the
    //      handler CAN cooperate. (Engine's responsibility.)
    //
    // What the engine does NOT promise:
    //
    //   3. Forcibly stopping a handler that ignores ctx.signal. There's no
    //      JS primitive that kills a Promise. If your handler runs `await
    //      sleep(1000)` and ignores the signal, that 1000ms of work will
    //      complete after the workflow is already marked failed.
    //
    // This test asserts (1) + (2) and explicitly does NOT assert (3) — the
    // honest contract. Don't add an assertion that the handler stops; that's
    // testing JS runtime semantics, not streamline behaviour.
    let abortObservedByHandler = false;
    let postAbortIterations = 0;

    const wf = createWorkflow<{}, {}>('abort-honest', {
      steps: {
        slow: {
          handler: async (ctx) => {
            // 1 second of "work" — polls abort every 50 ms but ignores it
            // (emulating user code that doesn't honor the signal).
            for (let i = 0; i < 20; i++) {
              await delay(50);
              if (ctx.signal.aborted) {
                abortObservedByHandler = true;
                postAbortIterations++;
              }
            }
            return 'done';
          },
          timeout: 100, // way less than handler's 1000ms
          retries: 0,
        },
      },
    });

    const run = await wf.start({});
    await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 }).catch(() => undefined);

    // Assert (1): step marked failed within timeout — engine released the
    // workflow despite the handler still running.
    const persisted = await wf.get(run._id);
    expect(persisted?.status).toBe('failed');
    const slowStep = persisted?.steps.find((s) => s.stepId === 'slow');
    expect(slowStep?.status).toBe('failed');
    expect(JSON.stringify(slowStep?.error)).toMatch(/timeout/i);

    // Wait long enough for several handler iterations past the abort.
    await delay(400);

    // Assert (2): handler saw the abort signal — the engine DID deliver it.
    expect(abortObservedByHandler).toBe(true);

    // Assert (3 — the honest contract): the handler kept iterating AFTER
    // observing abort because it didn't act on it. We can't force a kill;
    // the handler's own break/return is the only thing that stops it.
    expect(postAbortIterations).toBeGreaterThan(0);
  });

  it('handler that respects ctx.signal stops promptly and reports cancelled work', async () => {
    // The cooperative pattern — when the handler honors ctx.signal,
    // background work stops at the next check.
    let workCompleted = 0;

    const wf = createWorkflow<{}, {}>('abort-cooperative', {
      steps: {
        coop: {
          handler: async (ctx) => {
            for (let i = 0; i < 50; i++) {
              if (ctx.signal.aborted) throw new Error('aborted');
              await delay(20);
              workCompleted = i + 1;
            }
            return 'finished';
          },
          timeout: 80,
          retries: 0,
        },
      },
    });

    const run = await wf.start({});
    await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 }).catch(() => undefined);

    const persisted = await wf.get(run._id);
    expect(persisted?.status).toBe('failed');
    // Handler stopped early — much less than 50 iterations.
    expect(workCompleted).toBeLessThan(20);
  });
});

describe('Child workflow completion across containers', () => {
  useTestDb();

  it('parent on container A resumes when child on container B completes', async () => {
    // Setup: parent and child on DIFFERENT containers — the cross-container
    // case the pre-fix code mishandled (parent listened only on its own
    // bus, missed the child's emit on the child's bus).
    const parentContainer = createContainer();
    const childContainer = createContainer();

    expect(parentContainer.eventBus).not.toBe(childContainer.eventBus);

    // Child workflow registered on its own container
    createWorkflow<{ value: number }, { value: number }>('cross-cont-child', {
      steps: {
        compute: async (ctx) => ({ doubled: ctx.input.value * 2 }),
      },
      container: childContainer,
    });

    // Parent uses a DIFFERENT container; calls startChildWorkflow which
    // looks up the child via workflowRegistry (global, by id).
    const parent = createWorkflow<
      { value: number },
      { value: number }
    >('cross-cont-parent', {
      steps: {
        invokeChild: async (ctx) => {
          // startChildWorkflow throws a WaitSignal; engine resolves the
          // child via workflowRegistry and listens for its completion.
          await ctx.startChildWorkflow('cross-cont-child', { value: ctx.input.value });
        },
        afterChild: async (ctx) => {
          const childOut = ctx.getOutput<{ doubled: number }>('invokeChild');
          return { received: childOut?.doubled ?? -1 };
        },
      },
      container: parentContainer,
    });

    // Script: start the parent, wait for completion. With the cross-bus
    // subscription fix, the parent must receive the child's completion
    // event and advance to `afterChild`.
    const run = await parent.start({ value: 21 });
    const final = (await parent.waitFor(run._id, {
      pollInterval: 50,
      timeout: 5_000,
    })) as WorkflowRun;

    // Assert: parent reached `done` AND afterChild ran with the child's
    // output.
    expect(final.status).toBe('done');
    const afterChildStep = final.steps.find((s) => s.stepId === 'afterChild');
    expect(afterChildStep?.status).toBe('done');
    expect((afterChildStep?.output as { received: number })?.received).toBe(42);
  });
});

describe('Concurrency / throttle — best-effort, NOT a strict distributed limiter', () => {
  useTestDb();

  it('parallel concurrent starts may briefly oversubscribe concurrency.limit', async () => {
    // The documented edge. We don't ship a "strict guarantee" so the test
    // doesn't assert one — it pins what the contract IS: the count-then-
    // create gate can let two parallel callers both observe activeCount=0
    // and both succeed past `limit=1`, briefly producing 2 active runs
    // for the same key.
    //
    // This is acceptable for "don't overload an embedding API." It is NOT
    // acceptable for "exactly one payment capture per order." For that,
    // wrap start() in a Redis token-bucket / atomic counter / partial
    // unique-index reservation.
    const wf = createWorkflow<{ userId: string }, { userId: string }>(
      'concurrency-strict-bound',
      {
        steps: {
          // Long enough that the first run is still "running" when the
          // second observes the count.
          slow: async () => {
            await delay(200);
            return 'ok';
          },
        },
        autoExecute: false,
        concurrency: { key: (input) => input.userId, limit: 1 },
      },
    );

    // Script: 5 parallel starts with the same key. Best-effort gate may
    // admit more than 1 immediately.
    const results = await Promise.all([
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
    ]);

    // Assert: ALL 5 runs were persisted (none were dropped).
    const total = await WorkflowRunModel.countDocuments({
      workflowId: 'concurrency-strict-bound',
      concurrencyKey: 'u-1',
    });
    expect(total).toBe(5);

    // Pin the contract: at least one run was admitted (running). Some may
    // have been queued (draft). Strict guarantee would cap admitted at
    // exactly `limit` — we don't make that promise.
    const admitted = results.filter((r) => r.status === 'running').length;
    expect(admitted).toBeGreaterThanOrEqual(1);
    // Document that the contract permits oversubscription. We don't
    // assert `admitted === 1` because that's not the contract.
  });

  it('parallel throttle starts may collide on the same future slot', async () => {
    // Same edge as above but for throttle: parallel callers compute against
    // the same tail and reserve the same `tail.executionTime + windowMs/limit`
    // slot. Sequential bursts smooth correctly (covered by the staggered-
    // burst scenario); parallel callers don't.
    const wf = createWorkflow<{ userId: string }, { userId: string }>(
      'throttle-parallel-honest',
      {
        steps: { run: async () => 'ok' },
        autoExecute: false,
        concurrency: {
          key: (input) => input.userId,
          throttle: { limit: 1, windowMs: 60_000 },
        },
      },
    );

    // Fire 4 starts in parallel. With limit=1, calls 2-4 should all queue
    // — but parallel evaluation may give some of them the SAME fireAt.
    const results = await Promise.all([
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
      wf.start({ userId: 'u-1' }),
    ]);

    // Assert: all 4 persisted (no dropped calls).
    expect(results).toHaveLength(4);

    // Some are gated as throttle, some may have been admitted past the
    // limit due to the parallel race. The contract permits this — what
    // we lock in is "no dropped calls, all queued runs have a fireAt."
    const queued = results.filter((r) => r.meta?.streamlineGate === 'throttle');
    for (const q of queued) {
      expect(q.scheduling?.executionTime).toBeInstanceOf(Date);
    }
  });
});

describe('Trigger event — tenant context propagation', () => {
  useTestDb();

  it('extracts tenantId from event payload via `trigger.tenantId(payload)` extractor', async () => {
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = createWorkflow<{ orgId: string }, { orgId: string }>('trigger-tenant-extract', {
      steps: { run: async () => 'ok' },
      autoExecute: false,
      container,
      trigger: {
        event: 'user.created',
        // Tenant lives at payload.data.orgId by convention.
        tenantId: (payload) => (payload as { data?: { orgId?: string } })?.data?.orgId,
      },
    });

    // Fire the trigger event with a payload containing the tenant.
    container.eventBus.emit('user.created', { data: { orgId: 'org-A' } });
    // Wait for the listener's setImmediate + start to land.
    await new Promise((r) => setTimeout(r, 100));

    const persisted = await WorkflowRunModel.findOne({
      workflowId: 'trigger-tenant-extract',
    }).lean();
    expect(persisted).toBeTruthy();
    // Tenant scope was injected onto the persisted run by the
    // tenant-filter plugin's `before:create` hook — proves the trigger
    // listener forwarded the extracted tenantId through start().
    expect((persisted?.context as { tenantId?: string })?.tenantId).toBe('org-A');

    wf.shutdown();
  });

  it('uses `trigger.staticTenantId` for single-tenant deployments', async () => {
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = createWorkflow<{}, {}>('trigger-tenant-static', {
      steps: { run: async () => 'ok' },
      autoExecute: false,
      container,
      trigger: {
        event: 'cron.daily',
        staticTenantId: 'org-default',
      },
    });

    container.eventBus.emit('cron.daily', {});
    await new Promise((r) => setTimeout(r, 100));

    const persisted = await WorkflowRunModel.findOne({
      workflowId: 'trigger-tenant-static',
    }).lean();
    expect((persisted?.context as { tenantId?: string })?.tenantId).toBe('org-default');

    wf.shutdown();
  });
});

describe('Smoke check — globalEventBus is reachable for cross-process patterns', () => {
  useTestDb();

  it('emit on globalEventBus is observable by parallel listeners (sanity)', async () => {
    // Sanity test for the cross-container event-bus story. If this breaks,
    // the cross-container child-workflow scenario above will silently fail
    // for a different reason than the bug we just fixed.
    const events: string[] = [];
    const handler = (payload: unknown) => events.push(JSON.stringify(payload));
    globalEventBus.on('test:smoke', handler);
    globalEventBus.emit('test:smoke', { runId: 'r-1' });
    expect(events).toContain(JSON.stringify({ runId: 'r-1' }));
    globalEventBus.off('test:smoke', handler);
  });
});
