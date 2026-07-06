/**
 * Generalized host-facing API contracts (2.7.0) — the four primitives hosts
 * compose approval/rejection flows from, tested as GENERAL APIs (no
 * use-case-specific shapes):
 *
 *   1. `wf.cancel(runId)` — whole-run abort: mid-step, during a wait, and
 *      idempotent no-op on already-terminal runs.
 *   2. `cancelHook(token, { reason })` — wait withdrawal: the free-form
 *      `reason` persists on the run record (the waiting step's output
 *      sentinel) AND surfaces in the `workflow:resumed` event payload; a
 *      cancelled wait can never be resumed by a late `resumeHook(token)`;
 *      composes with saga compensation.
 *   3. Typed step outputs — outputs persist and rehydrate across an engine
 *      restart (type-level flow is pinned in test/type-inference.test-d.ts).
 *   4. Durable `ctx.loop` — iteration counter AND accumulator state survive
 *      a worker crash + NEW-engine restart, resuming at the committed
 *      iteration, not iteration 0.
 */

import { describe, expect, it } from 'vitest';
import { hookRegistry } from '../../src/execution/engine.js';
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

type StepsShape = Array<{ stepId: string; output?: unknown }>;
const stepOutput = (run: Record<string, unknown>, stepId: string): unknown =>
  (run.steps as StepsShape | undefined)?.find((s) => s.stepId === stepId)?.output;

describe('generalized APIs (2.7.0)', () => {
  useTestDb();

  // ==========================================================================
  // 1. wf.cancel(runId)
  // ==========================================================================

  describe('wf.cancel', () => {
    it('cancels mid-step: aborts the in-flight handler and marks the run cancelled', async () => {
      const wfId = uid('cancel-midstep');
      let sawAbort = false;

      const wf = createWorkflow(wfId, {
        steps: {
          slow: async (ctx) => {
            // Long handler that observes the abort signal (ctx.signal contract).
            for (let i = 0; i < 100; i++) {
              if (ctx.signal.aborted) {
                sawAbort = true;
                throw new Error('aborted');
              }
              await sleep(50);
            }
            return 'never';
          },
        },
        autoExecute: false,
      });

      const cancelledEvents: string[] = [];
      wf.engine.container.eventBus.on('workflow:cancelled', (p) => {
        cancelledEvents.push((p as { runId: string }).runId);
      });

      const run = await wf.start({});
      const exec = wf.execute(run._id).catch(() => undefined); // settles after abort
      await sleep(120); // let the step get in-flight

      const cancelled = await wf.cancel(run._id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelledEvents).toContain(run._id);

      await exec;
      expect(sawAbort).toBe(true);

      const persisted = await wf.get(run._id);
      expect(persisted?.status).toBe('cancelled');

      wf.shutdown();
    });

    it('cancels during a wait: the parked run is cancelled and a late resumeHook fails', async () => {
      const wfId = uid('cancel-waiting');
      const wf = createWorkflow(wfId, {
        steps: {
          request: async (ctx) => {
            const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:approve` });
            return ctx.wait(hook.reason, { hookToken: hook.token });
          },
          decide: async () => 'unreached',
        },
        scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
      });

      const run = await wf.start({});
      await waitForStatus(wf, run._id, ['waiting']);

      const cancelled = await wf.cancel(run._id);
      expect(cancelled.status).toBe('cancelled');

      // The withdrawn run can never be resumed by its token afterwards.
      await expect(resumeHook(`${run._id}:approve`, { approved: true })).rejects.toThrow(
        /not waiting/,
      );

      const persisted = await wf.get(run._id);
      expect(persisted?.status).toBe('cancelled');

      wf.shutdown();
    });

    it('is an idempotent no-op on already-terminal runs (done stays done, no event)', async () => {
      const wfId = uid('cancel-terminal');
      const wf = createWorkflow(wfId, {
        steps: { quick: async () => 'ok' },
        autoExecute: false,
      });

      const cancelledEvents: string[] = [];
      wf.engine.container.eventBus.on('workflow:cancelled', (p) => {
        cancelledEvents.push((p as { runId: string }).runId);
      });

      const run = await wf.start({});
      await wf.execute(run._id);

      // Cancel a done run — returned unchanged, nothing written, no event.
      const result = await wf.cancel(run._id);
      expect(result.status).toBe('done');
      expect(cancelledEvents).toEqual([]);
      expect((await wf.get(run._id))?.status).toBe('done');

      // Cancel a cancelled run — idempotent (single event from the real cancel).
      const run2 = await wf.start({});
      await wf.cancel(run2._id);
      const again = await wf.cancel(run2._id);
      expect(again.status).toBe('cancelled');
      expect(cancelledEvents).toEqual([run2._id]);

      wf.shutdown();
    });
  });

  // ==========================================================================
  // 2. cancelHook(token, { reason })
  // ==========================================================================

  describe('cancelHook reason flow', () => {
    it('persists the reason on the run record and surfaces it in the workflow:resumed payload', async () => {
      const wfId = uid('chook-reason');
      const wf = createWorkflow(wfId, {
        steps: {
          request: async (ctx) => {
            const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:approve` });
            return ctx.wait(hook.reason, { hookToken: hook.token });
          },
          decide: async (ctx) => {
            const resolution = getWaitResolution(ctx.getOutput('request'));
            return { kind: resolution?.__waitResolved ?? 'answered', reason: resolution?.reason };
          },
        },
        scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
      });

      const resumedPayloads: Array<{ runId?: string; data?: unknown }> = [];
      wf.engine.container.eventBus.on('workflow:resumed', (p) => {
        resumedPayloads.push(p as { runId?: string; data?: unknown });
      });

      const run = await wf.start({});
      await waitForStatus(wf, run._id, ['waiting']);

      await cancelHook(`${run._id}:approve`, { reason: 'superseded by v2 request' });

      const final = await waitForStatus(wf, run._id, ['done']);

      // Reason persisted on the run record: the waiting step's output IS the
      // cancellation sentinel carrying the free-form reason.
      expect(stepOutput(final, 'request')).toMatchObject({
        __waitResolved: 'cancelled',
        reason: 'superseded by v2 request',
      });
      // ...and flowed into the next step (host-visible discrimination).
      expect(stepOutput(final, 'decide')).toMatchObject({
        kind: 'cancelled',
        reason: 'superseded by v2 request',
      });

      // Reason present in the resume event payload for this run.
      const evt = resumedPayloads.find((p) => p.runId === run._id);
      expect(evt).toBeDefined();
      expect(getWaitResolution(evt?.data)).toMatchObject({
        __waitResolved: 'cancelled',
        reason: 'superseded by v2 request',
      });

      wf.shutdown();
    });

    it('a cancelled hook wait cannot be resumed by a late resume with the old token', async () => {
      const wfId = uid('chook-late');
      const wf = createWorkflow(wfId, {
        steps: {
          first: async (ctx) => {
            const hook = createHook(ctx, 'first gate', { token: `${ctx.runId}:first` });
            return ctx.wait(hook.reason, { hookToken: hook.token });
          },
          second: async (ctx) => {
            const hook = createHook(ctx, 'second gate', { token: `${ctx.runId}:second` });
            return ctx.wait(hook.reason, { hookToken: hook.token });
          },
          finish: async () => 'done',
        },
        scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
      });

      const run = await wf.start({});
      await waitForStatus(wf, run._id, ['waiting']);

      // Withdraw the FIRST wait — the run advances and parks on the second.
      await cancelHook(`${run._id}:first`, { reason: 'withdrawn' });
      await sleep(200);
      await waitForStatus(wf, run._id, ['waiting']);

      // A late resume with the OLD (cancelled) token is rejected fail-closed —
      // it cannot resume the cancelled wait NOR the currently-waiting step.
      await expect(resumeHook(`${run._id}:first`, { approved: true })).rejects.toThrow(
        /Invalid hook token/,
      );

      // The current wait still resumes normally with ITS token.
      await resumeHook(`${run._id}:second`, { ok: true });
      const final = await waitForStatus(wf, run._id, ['done']);
      expect(stepOutput(final, 'first')).toMatchObject({ __waitResolved: 'cancelled' });
      expect(stepOutput(final, 'second')).toEqual({ ok: true });

      wf.shutdown();
    });

    it('composes with saga compensation: compensable steps roll back after a cancelled wait', async () => {
      const wfId = uid('chook-saga');
      const compensated: string[] = [];

      const wf = createWorkflow(wfId, {
        steps: {
          reserve: {
            handler: async () => 'reserved',
            onCompensate: async () => {
              compensated.push('reserve');
            },
          },
          gate: {
            handler: async (ctx) => {
              const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:gate` });
              return ctx.wait(hook.reason, { hookToken: hook.token });
            },
            onCompensate: async () => {
              compensated.push('gate');
            },
          },
          charge: {
            handler: async () => {
              throw new Error('charge boom');
            },
            retries: 0,
          },
        },
        scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
      });

      const run = await wf.start({});
      await waitForStatus(wf, run._id, ['waiting']);

      // Withdraw the gate; the run proceeds, `charge` fails, saga rolls back.
      await cancelHook(`${run._id}:gate`, { reason: 'operator withdrew' });

      const final = await waitForStatus(wf, run._id, ['compensated'], 12_000);
      expect(final.status).toBe('compensated');
      // Reverse-order rollback INCLUDING the cancelled-wait step (it is
      // `done` with the sentinel output, so it participates like any step).
      expect(compensated).toEqual(['gate', 'reserve']);
      // The sentinel (with reason) is still the durable step output.
      expect(stepOutput(final, 'gate')).toMatchObject({
        __waitResolved: 'cancelled',
        reason: 'operator withdrew',
      });

      wf.shutdown();
    });
  });

  // ==========================================================================
  // 3. Typed step outputs — persist + rehydrate across an engine restart
  // ==========================================================================

  describe('step outputs across engine restart', () => {
    it('outputs persist and a FRESH engine rehydrates them for later steps', async () => {
      const wfId = uid('outputs-restart');

      const build = () =>
        createWorkflow(wfId, {
          steps: {
            fetch: async () => ({ html: '<p>hi</p>' }),
            gate: async (ctx) => {
              const hook = createHook(ctx, 'gate', { token: `${ctx.runId}:go` });
              return ctx.wait(hook.reason, { hookToken: hook.token });
            },
            use: async (ctx) => {
              // Rehydrated from the DB by the NEW engine — the original
              // engine (and its cache) is gone.
              const fetched = ctx.outputs.fetch as { html: string } | undefined;
              return { len: fetched?.html.length ?? -1 };
            },
          },
          scheduler: { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 },
        });

      const wf1 = build();
      const run = await wf1.start({});
      await waitForStatus(wf1, run._id, ['waiting']);

      // Simulate worker restart: tear the first engine down entirely.
      wf1.shutdown();
      hookRegistry.unregister(run._id);

      const wf2 = build();
      await resumeHook(`${run._id}:go`, { approved: true });

      const final = await waitForStatus(wf2, run._id, ['done']);
      expect(stepOutput(final, 'use')).toEqual({ len: '<p>hi</p>'.length });

      wf2.shutdown();
    });
  });

  // ==========================================================================
  // 4. Durable ctx.loop — state survives a worker crash + NEW-engine restart
  // ==========================================================================

  describe('ctx.loop across worker restart', () => {
    it('resumes at the committed iteration (with accumulator state) on a NEW engine, not iteration 0', async () => {
      const wfId = uid('loop-restart');
      const executedBy: Array<[string, number]> = [];

      // `crashAt` is a PERMANENT per-worker crash point (no shared latch): the
      // worker built with crashAt=2 throws at iteration >= 2 on EVERY attempt,
      // so it can never run past iteration 1 — even if an inline retry were to
      // re-enter its execute(). Worker 2 is built with crashAt=null and never
      // crashes. Separate latches mean worker 2's build can't be polluted by
      // worker 1's state, and worker 1's crash is deterministic.
      const build = (label: string, crashAt: number | null) =>
        createWorkflow(wfId, {
          steps: {
            work: {
              handler: async (ctx) => {
                const final = await ctx.loop(
                  { log: [] as number[] },
                  async (state, i) => {
                    if (crashAt !== null && i >= crashAt) {
                      throw new Error('worker crash');
                    }
                    executedBy.push([label, i]);
                    return { state: { log: [...state.log, i] }, done: i >= 3 };
                  },
                  { maxIterations: 10 },
                );
                return { log: final.log };
              },
              retries: 2,
              // 10s is well above TIMING.SHORT_DELAY_THRESHOLD_MS (5s): even at
              // the maximum negative backoff jitter (−30% ⇒ 7s), the effective
              // retry delay stays above the inline-retry threshold, so worker
              // 1's failed attempt is ALWAYS scheduled as a DURABLE retry and
              // never slept-and-retried inside its own execute(). This is what
              // makes the restart simulation deterministic — the previous 5500
              // could dip below 5s under jitter (−30% ⇒ 3850ms) and trigger an
              // inline retry, defeating the crash-and-hand-off.
              retryDelay: 10_000,
            },
          },
          autoExecute: false,
        });

      // Worker 1 executes iterations 0,1 then "crashes" (permanently) at
      // iteration 2, scheduling a durable retry.
      const wf1 = build('w1', 2);
      const run = await wf1.start({});
      const r1 = await wf1.execute(run._id);
      // The failed attempt is scheduled for a durable retry, NOT completed.
      expect(r1.status).not.toBe('done');

      // Stronger, timing-independent proof that worker 1 ran ONLY iterations
      // 0,1 and durably committed them: the loop's persisted checkpoint sits
      // at iteration 2 with the accumulator [0,1] — this is exactly what a
      // fresh worker must resume from. Asserting the persisted checkpoint (not
      // just run.status) removes any dependence on inline-vs-durable timing.
      const afterCrash = (await wf1.get(run._id)) as Record<string, unknown> | null;
      expect(afterCrash).not.toBeNull();
      expect(stepOutput(afterCrash as Record<string, unknown>, 'work')).toEqual({
        __checkpoint: { __loopIteration: 2, state: { log: [0, 1] } },
      });
      expect(executedBy).toEqual([
        ['w1', 0],
        ['w1', 1],
      ]);

      wf1.shutdown();

      // Worker 2 (fresh engine, fresh process semantics) drives the retry —
      // polling executeRetry the way a real worker's scheduler does (the
      // exact retryAfter carries backoff jitter, so a single timed shot
      // would race the clock).
      const wf2 = build('w2', null);
      const deadline = Date.now() + 15_000;
      let claimed: unknown = null;
      while (!claimed && Date.now() < deadline) {
        claimed = await wf2.engine.executeRetry(run._id);
        if (!claimed) await sleep(250);
      }
      const final = await waitForStatus(wf2, run._id, ['done']);

      // Iterations 0,1 ran ONLY on worker 1; worker 2 resumed AT iteration 2
      // — not from 0 — with the committed accumulator intact.
      expect(executedBy).toEqual([
        ['w1', 0],
        ['w1', 1],
        ['w2', 2],
        ['w2', 3],
      ]);
      expect(stepOutput(final, 'work')).toEqual({ log: [0, 1, 2, 3] });

      wf2.shutdown();
    });
  });
});
