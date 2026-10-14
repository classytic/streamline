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
  getWaitResolution,
  resumeHook,
  type WorkflowConfig,
} from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST_SCHED = { basePollInterval: 100, minPollInterval: 50, maxPollInterval: 500 } as const;
const WAIT = { timeout: 8000 } as const;

type StepsShape = Array<{ stepId: string; output?: unknown }>;
const stepOutput = (run: { steps?: unknown }, stepId: string): unknown =>
  (run.steps as StepsShape | undefined)?.find((s) => s.stepId === stepId)?.output;

describe('generalized APIs (2.7.0)', () => {
  // ==========================================================================
  // 1. wf.cancel(runId)
  // ==========================================================================

  describe('wf.cancel', () => {
    it('cancels mid-step: aborts the in-flight handler and marks the run cancelled', async () => {
      let sawAbort = false;
      let markInFlight: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => {
        markInFlight = resolve;
      });

      const wf = env.workflow('cancel-midstep', {
        steps: {
          slow: async (ctx) => {
            markInFlight();
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
      });

      const cancelledEvents: string[] = [];
      wf.engine.container.eventBus.on('workflow:cancelled', (p) => {
        cancelledEvents.push((p as { runId: string }).runId);
      });

      const run = await wf.start({});
      const exec = wf.execute(run._id).catch(() => undefined); // settles after abort
      await inFlight; // the step is in-flight

      const cancelled = await wf.cancel(run._id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelledEvents).toContain(run._id);

      await exec;
      // execute() returns as soon as the attempt aborts — it no longer waits
      // for the handler; the handler still SEES the abort on its next check.
      await env.eventually(() => expect(sawAbort).toBe(true), { timeout: 1_000 });

      const persisted = await wf.get(run._id);
      expect(persisted?.status).toBe('cancelled');
    });

    it('cancels during a wait: the parked run is cancelled and a late resumeHook fails', async () => {
      const wf = env.workflow('cancel-waiting', {
        steps: {
          request: async (ctx) => {
            const hook = createHook(ctx, 'approval', { token: `${ctx.runId}:approve` });
            return ctx.wait(hook.reason, { hookToken: hook.token });
          },
          decide: async () => 'unreached',
        },
        scheduler: FAST_SCHED,
        autoExecute: true,
      });

      const run = await wf.start({});
      await env.until(run._id, 'waiting', WAIT);

      const cancelled = await wf.cancel(run._id);
      expect(cancelled.status).toBe('cancelled');

      // The withdrawn run can never be resumed by its token afterwards.
      await expect(
        resumeHook(`${run._id}:approve`, { approved: true }, { container: env.container }),
      ).rejects.toThrow(/not waiting/);

      const persisted = await wf.get(run._id);
      expect(persisted?.status).toBe('cancelled');
    });

    it('is an idempotent no-op on already-terminal runs (done stays done, no event)', async () => {
      const wf = env.workflow('cancel-terminal', {
        steps: { quick: async () => 'ok' },
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
    });
  });

  // ==========================================================================
  // 2. cancelHook(token, { reason })
  // ==========================================================================

  describe('cancelHook reason flow', () => {
    it('persists the reason on the run record and surfaces it in the workflow:resumed payload', async () => {
      const wf = env.workflow('chook-reason', {
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
        scheduler: FAST_SCHED,
        autoExecute: true,
      });

      const resumedPayloads: Array<{ runId?: string; data?: unknown }> = [];
      wf.engine.container.eventBus.on('workflow:resumed', (p) => {
        resumedPayloads.push(p as { runId?: string; data?: unknown });
      });

      const run = await wf.start({});
      await env.until(run._id, 'waiting', WAIT);

      await cancelHook(`${run._id}:approve`, {
        reason: 'superseded by v2 request',
        container: env.container,
      });

      const final = await env.until(run._id, 'done', WAIT);

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
    });

    it('a cancelled hook wait cannot be resumed by a late resume with the old token', async () => {
      const wf = env.workflow('chook-late', {
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
        scheduler: FAST_SCHED,
        autoExecute: true,
      });

      const run = await wf.start({});
      await env.until(run._id, 'waiting', WAIT);

      // Withdraw the FIRST wait — the run advances and parks on the second.
      await cancelHook(`${run._id}:first`, { reason: 'withdrawn', container: env.container });
      await env.until(run._id, (r) => r.status === 'waiting' && r.currentStepId === 'second', WAIT);

      // A late resume with the OLD (cancelled) token is rejected fail-closed —
      // it cannot resume the cancelled wait NOR the currently-waiting step.
      await expect(
        resumeHook(`${run._id}:first`, { approved: true }, { container: env.container }),
      ).rejects.toThrow(/Invalid hook token/);

      // The current wait still resumes normally with ITS token.
      await resumeHook(`${run._id}:second`, { ok: true }, { container: env.container });
      const final = await env.until(run._id, 'done', WAIT);
      expect(stepOutput(final, 'first')).toMatchObject({ __waitResolved: 'cancelled' });
      expect(stepOutput(final, 'second')).toEqual({ ok: true });
    });

    it('composes with saga compensation: compensable steps roll back after a cancelled wait', async () => {
      const compensated: string[] = [];

      const wf = env.workflow('chook-saga', {
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
        scheduler: FAST_SCHED,
        autoExecute: true,
      });

      const run = await wf.start({});
      await env.until(run._id, 'waiting', WAIT);

      // Withdraw the gate; the run proceeds, `charge` fails, saga rolls back.
      await cancelHook(`${run._id}:gate`, {
        reason: 'operator withdrew',
        container: env.container,
      });

      const final = await env.until(run._id, 'compensated', { timeout: 12_000 });
      expect(final.status).toBe('compensated');
      // Reverse-order rollback INCLUDING the cancelled-wait step (it is
      // `done` with the sentinel output, so it participates like any step).
      expect(compensated).toEqual(['gate', 'reserve']);
      // The sentinel (with reason) is still the durable step output.
      expect(stepOutput(final, 'gate')).toMatchObject({
        __waitResolved: 'cancelled',
        reason: 'operator withdrew',
      });
    });
  });

  // ==========================================================================
  // 3. Typed step outputs — persist + rehydrate across an engine restart
  // ==========================================================================

  describe('step outputs across engine restart', () => {
    it('outputs persist and a FRESH engine rehydrates them for later steps', async () => {
      const config: WorkflowConfig<Record<string, unknown>> = {
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
        scheduler: FAST_SCHED,
        autoExecute: true,
      };

      const wf1 = env.workflow('outputs-restart', config);
      const run = await wf1.start({});
      await env.until(run._id, 'waiting', WAIT);

      // Simulate worker restart: tear the first engine down entirely.
      wf1.shutdown();
      hookRegistry.unregister(run._id);

      // Same workflow id, fresh engine.
      env.redefine(wf1, config);
      await resumeHook(`${run._id}:go`, { approved: true }, { container: env.container });

      const final = await env.until(run._id, 'done', WAIT);
      expect(stepOutput(final, 'use')).toEqual({ len: '<p>hi</p>'.length });
    });
  });

  // ==========================================================================
  // 4. Durable ctx.loop — state survives a worker crash + NEW-engine restart
  // ==========================================================================

  describe('ctx.loop across worker restart', () => {
    it('resumes at the committed iteration (with accumulator state) on a NEW engine, not iteration 0', async () => {
      const executedBy: Array<[string, number]> = [];

      // `crashAt` is a PERMANENT per-worker crash point (no shared latch): the
      // worker built with crashAt=2 throws at iteration >= 2 on EVERY attempt,
      // so it can never run past iteration 1 — even if an inline retry were to
      // re-enter its execute(). Worker 2 is built with crashAt=null and never
      // crashes. Separate latches mean worker 2's build can't be polluted by
      // worker 1's state, and worker 1's crash is deterministic.
      const config = (
        label: string,
        crashAt: number | null,
      ): WorkflowConfig<Record<string, unknown>> => ({
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
      const wf1 = env.workflow('loop-restart', config('w1', 2));
      const run = await wf1.start({});
      const r1 = await wf1.execute(run._id);
      // The failed attempt is scheduled for a durable retry, NOT completed.
      expect(r1.status).not.toBe('done');

      // Stronger, timing-independent proof that worker 1 ran ONLY iterations
      // 0,1 and durably committed them: the loop's persisted checkpoint sits
      // at iteration 2 with the accumulator [0,1] — this is exactly what a
      // fresh worker must resume from. Asserting the persisted checkpoint (not
      // just run.status) removes any dependence on inline-vs-durable timing.
      const afterCrash = await env.runs.get(run._id);
      expect(afterCrash).not.toBeNull();
      expect(stepOutput(afterCrash ?? {}, 'work')).toEqual({
        __checkpoint: { __loopIteration: 2, state: { log: [0, 1] } },
      });
      expect(executedBy).toEqual([
        ['w1', 0],
        ['w1', 1],
      ]);
      // The durable retry is scheduled in the future (the ~10s backoff).
      const retryAfter = afterCrash?.steps[0]?.retryAfter;
      expect(retryAfter).toBeInstanceOf(Date);
      expect((retryAfter as Date).getTime()).toBeGreaterThan(Date.now());

      wf1.shutdown();

      // Advance the clock past the backoff instead of sleeping through it:
      // the retry is now due, exactly as a worker's scheduler would find it.
      await env.runs.makeDue(run._id);

      // Worker 2 (fresh engine, fresh process semantics — same workflow id)
      // drives the retry the way a real worker's scheduler does.
      const wf2 = env.redefine(wf1, config('w2', null));
      const claimed = await wf2.engine.executeRetry(run._id);
      expect(claimed).toBeTruthy();
      const final = await env.until(run._id, 'done', WAIT);

      // Iterations 0,1 ran ONLY on worker 1; worker 2 resumed AT iteration 2
      // — not from 0 — with the committed accumulator intact.
      expect(executedBy).toEqual([
        ['w1', 0],
        ['w1', 1],
        ['w2', 2],
        ['w2', 3],
      ]);
      expect(stepOutput(final, 'work')).toEqual({ log: [0, 1, 2, 3] });
    });
  });
});
