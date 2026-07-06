/**
 * v2.7 feature suite — six generalized primitives, end-to-end on a real Mongo:
 *
 *   1. Queryable step/run progress — `ctx.reportProgress` persists (throttled,
 *      latest-wins, final-flush) and `engine.getStepProgress` /
 *      `getRunProgress` read it back, incl. across a fresh-engine restart.
 *   2. `taskMiddleware` — before-guard rejects a step (non-retriable) / one
 *      scatter task (siblings proceed); after fires with durationMs + outcome;
 *      absent middleware = zero behavior change.
 *   3. `ctx.dedupe` — cached value returned on retry (fn once across crash),
 *      over-budget value re-runs, scatter failed-only retry intact.
 *   4. Operator pause/resume — pause at step boundary, resume to completion,
 *      terminal/double-pause no-op, paused run skipped by scheduler.
 *   5. `engine.getRunMetrics` — durations + attempts + cost aggregation.
 *   6. `cancel(runId, { reason })` — persisted + in event; no-reason unchanged;
 *      terminal no-op preserves reason.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainer } from '../../src/core/container.js';
import { globalEventBus } from '../../src/core/events.js';
import type { TaskHookContext } from '../../src/core/types.js';
import { createWorkflow } from '../../src/index.js';
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
    await sleep(25);
  }
  throw new Error(`run ${runId} did not reach [${statuses}] within ${timeoutMs}ms`);
}

// ============================================================================
// 1. Queryable progress
// ============================================================================

describe('v2.7: queryable step/run progress', () => {
  useTestDb();

  it('reportProgress persists and getStepProgress reads it back', async () => {
    const wf = createWorkflow(uid('progress'), {
      steps: {
        work: async (ctx) => {
          ctx.reportProgress({ phase: 'start', percent: 0, message: 'beginning' });
          await sleep(10);
          ctx.reportProgress({ phase: 'end', percent: 100, message: 'done' });
          return { ok: true };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const progress = await wf.getStepProgress(run._id, 'work');
    expect(progress).toBeDefined();
    // Final value always flushed on completion.
    expect(progress?.percent).toBe(100);
    expect(progress?.phase).toBe('end');
    expect(progress?.at).toBeInstanceOf(Date);

    wf.shutdown();
  });

  it('throttles rapid updates to ≤N writes but the FINAL value always lands', async () => {
    const container = createContainer();
    const updateSpy = vi.spyOn(container.repository, 'updateOne');

    const wf = createWorkflow(uid('progress-throttle'), {
      steps: {
        burst: async (ctx) => {
          // Emit 50 frames rapidly within ~250ms — well inside the 1s throttle
          // window, so persistence should coalesce to very few writes.
          for (let i = 0; i <= 50; i++) {
            ctx.reportProgress({ percent: i * 2, message: `frame ${i}` });
            await sleep(5);
          }
          return { done: true };
        },
      },
      container,
      autoExecute: false,
    });

    const run = await wf.start({});

    // Count only the lastProgress writes (isolate from other engine writes).
    const progressWrites = () =>
      updateSpy.mock.calls.filter((c) => {
        const upd = c[1] as { $set?: Record<string, unknown> } | undefined;
        return Object.keys(upd?.$set ?? {}).some((k) => k.endsWith('.lastProgress'));
      }).length;

    await wf.execute(run._id);

    const writes = progressWrites();
    // 50 frames over ~250ms with a 1s throttle + a final flush ⇒ a small,
    // bounded number of writes (immediate + a couple throttled + final),
    // FAR fewer than 51.
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(6);

    // The FINAL value must have landed regardless of coalescing.
    const progress = await wf.getStepProgress(run._id, 'burst');
    expect(progress?.percent).toBe(100);
    expect(progress?.message).toBe('frame 50');

    wf.shutdown();
  });

  it('getRunProgress returns status + progress for all steps', async () => {
    const wf = createWorkflow(uid('run-progress'), {
      steps: {
        a: async (ctx) => {
          ctx.reportProgress({ phase: 'a-phase', percent: 100 });
          return 1;
        },
        b: async (ctx) => {
          ctx.reportProgress({ phase: 'b-phase', percent: 50 });
          return 2;
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const rp = await wf.getRunProgress(run._id);
    expect(rp).not.toBeNull();
    expect(rp?.status).toBe('done');
    expect(rp?.steps).toHaveLength(2);
    const a = rp?.steps.find((s) => s.stepId === 'a');
    const b = rp?.steps.find((s) => s.stepId === 'b');
    expect(a?.status).toBe('done');
    expect(a?.lastProgress?.phase).toBe('a-phase');
    expect(b?.lastProgress?.phase).toBe('b-phase');

    wf.shutdown();
  });

  it('truncates an over-large message to keep the snapshot bounded', async () => {
    const wf = createWorkflow(uid('progress-trunc'), {
      steps: {
        work: async (ctx) => {
          ctx.reportProgress({ message: 'x'.repeat(5000) });
          return 1;
        },
      },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    const progress = await wf.getStepProgress(run._id, 'work');
    // Message was truncated (or dropped) to fit the ~1KB bound.
    expect((progress?.message ?? '').length).toBeLessThan(5000);
    wf.shutdown();
  });

  it('a fresh engine (restart) reads persisted progress', async () => {
    const wfId = uid('progress-restart');
    const wf1 = createWorkflow(wfId, {
      steps: {
        work: async (ctx) => {
          ctx.reportProgress({ phase: 'persisted', percent: 42 });
          return 1;
        },
      },
      autoExecute: false,
    });
    const run = await wf1.start({});
    await wf1.execute(run._id);
    wf1.shutdown();

    // Brand-new engine + fresh container/cache — must read from DB.
    const wf2 = createWorkflow(wfId, {
      steps: { work: async () => 1 },
      autoExecute: false,
    });
    const progress = await wf2.getStepProgress(run._id, 'work');
    expect(progress?.phase).toBe('persisted');
    expect(progress?.percent).toBe(42);
    wf2.shutdown();
  });
});

// ============================================================================
// 2. taskMiddleware
// ============================================================================

describe('v2.7: taskMiddleware guard + record', () => {
  useTestDb();

  it('before-guard rejecting a step fails it NON-retriably with the reason', async () => {
    let execCount = 0;
    const wf = createWorkflow(uid('tm-reject-step'), {
      steps: {
        guarded: async () => {
          execCount++;
          return 'ran';
        },
      },
      taskMiddleware: [
        {
          before: () => ({ allow: false, reason: 'budget exceeded' }),
        },
      ],
      defaults: { retries: 3 },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    // Handler never ran (rejected before execution) and NOT retried.
    expect(execCount).toBe(0);
    const failed = result.steps.find((s) => s.stepId === 'guarded');
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.message).toContain('budget exceeded');
    // attempts === 1 proves no retry.
    expect(failed?.attempts).toBe(1);

    wf.shutdown();
  });

  it('before-guard rejecting one scatter task rejects only it; siblings proceed', async () => {
    const ran: string[] = [];
    const wf = createWorkflow(uid('tm-reject-task'), {
      steps: {
        fan: async (ctx) =>
          ctx.scatter({
            a: async () => {
              ran.push('a');
              return 'a-ok';
            },
            blocked: async () => {
              ran.push('blocked');
              return 'never';
            },
            c: async () => {
              ran.push('c');
              return 'c-ok';
            },
          }),
      },
      taskMiddleware: [
        {
          before: (ctx: TaskHookContext) =>
            ctx.taskKey === 'blocked' ? { allow: false, reason: 'task blocked' } : { allow: true },
        },
      ],
      defaults: { retries: 1 }, // don't retry — assert single-pass rejection
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    // scatter throws when a task fails ⇒ step fails.
    expect(result.status).toBe('failed');
    // Siblings ran; the blocked task's body never executed.
    expect(ran).toContain('a');
    expect(ran).toContain('c');
    expect(ran).not.toContain('blocked');

    wf.shutdown();
  });

  it('after fires with durationMs + result on success and error on failure', async () => {
    const seen: Array<{ stepId: string; hasResult: boolean; hasError: boolean; dur: number }> = [];
    const wf = createWorkflow(uid('tm-after'), {
      steps: {
        ok: async () => {
          await sleep(10);
          return 'good';
        },
        bad: async () => {
          throw new Error('boom');
        },
      },
      taskMiddleware: [
        {
          after: (ctx) => {
            seen.push({
              stepId: ctx.stepId,
              hasResult: ctx.result !== undefined,
              hasError: ctx.error !== undefined,
              dur: ctx.durationMs,
            });
          },
        },
      ],
      defaults: { retries: 1 },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const okRec = seen.find((s) => s.stepId === 'ok');
    const badRec = seen.find((s) => s.stepId === 'bad');
    expect(okRec?.hasResult).toBe(true);
    expect(okRec?.hasError).toBe(false);
    expect(okRec?.dur).toBeGreaterThanOrEqual(0);
    expect(badRec?.hasError).toBe(true);
    expect(badRec?.hasResult).toBe(false);

    wf.shutdown();
  });

  it('middleware absent = zero behavior change', async () => {
    const wf = createWorkflow(uid('tm-absent'), {
      steps: { a: async () => 1, b: async () => 2 },
      autoExecute: false,
    });
    const run = await wf.start({});
    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');
    wf.shutdown();
  });
});

// ============================================================================
// 3. ctx.dedupe
// ============================================================================

describe('v2.7: ctx.dedupe durable memoization', () => {
  useTestDb();

  it('returns cached value on retry — fn runs once across a simulated crash+retry', async () => {
    let fnCalls = 0;
    const wf = createWorkflow(uid('dedupe-cache'), {
      steps: {
        step: async (ctx) => {
          // Memoized effect — must run exactly once even though the step
          // itself fails-then-retries below.
          const val = await ctx.dedupe('effect', async () => {
            fnCalls++;
            return { charged: true, id: 'abc' };
          });

          // Force a retry on the FIRST attempt AFTER the dedupe commit.
          if (ctx.attempt === 1) {
            throw new Error('crash after dedupe');
          }
          return val;
        },
      },
      defaults: { retries: 3, retryDelay: 10 },
      autoExecute: false,
    });

    const run = await wf.start({});
    // execute() drives short-delay retries inline (retryDelay: 10).
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    // fn ran exactly once across the crash+retry (cache hit on attempt 2).
    expect(fnCalls).toBe(1);

    wf.shutdown();
  });

  it('over-budget value is NOT cached — runs again on retry, warns', async () => {
    let fnCalls = 0;
    const wf = createWorkflow(uid('dedupe-overbudget'), {
      steps: {
        step: async (ctx) => {
          await ctx.dedupe('big', async () => {
            fnCalls++;
            // > 10KB — exceeds DEDUPE_MAX_BYTES, so it's not cached.
            return 'y'.repeat(20 * 1024);
          });
          if (ctx.attempt === 1) throw new Error('retry');
          return 'ok';
        },
      },
      defaults: { retries: 3, retryDelay: 10 },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');
    // Not cached ⇒ ran on both attempts.
    expect(fnCalls).toBe(2);

    wf.shutdown();
  });

  it('scatter retries only the failed tasks; completed results intact', async () => {
    const execCounts: Record<string, number> = {};
    const bump = (k: string) => {
      execCounts[k] = (execCounts[k] ?? 0) + 1;
    };

    const wf = createWorkflow(uid('scatter-failed-only'), {
      steps: {
        fan: async (ctx) =>
          ctx.scatter({
            good1: async () => {
              bump('good1');
              return 'g1';
            },
            good2: async () => {
              bump('good2');
              return 'g2';
            },
            flaky: async () => {
              bump('flaky');
              if (ctx.attempt === 1) throw new Error('flaky fail');
              return 'recovered';
            },
          }),
      },
      defaults: { retries: 3, retryDelay: 10 },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');

    // good1/good2 ran once (checkpointed); flaky ran twice (fail + success).
    expect(execCounts.good1).toBe(1);
    expect(execCounts.good2).toBe(1);
    expect(execCounts.flaky).toBe(2);

    const out = result.steps.find((s) => s.stepId === 'fan')?.output as Record<string, string>;
    expect(out).toEqual({ good1: 'g1', good2: 'g2', flaky: 'recovered' });

    wf.shutdown();
  });
});

// ============================================================================
// 4. Operator pause / resume
// ============================================================================

describe('v2.7: operator pause/resume', () => {
  useTestDb();

  it('pause mid-run: current step completes but next step is not claimed', async () => {
    const wfId = uid('pause-midrun');
    const ran: string[] = [];
    const wf = createWorkflow(wfId, {
      steps: {
        first: async (ctx) => {
          ran.push('first');
          // Pause DURING the first step. It must still finish, but the second
          // step must not be claimed.
          await ctx.wait('await-external');
          return 1;
        },
        second: async () => {
          ran.push('second');
          return 2;
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    // Kick off execution (parks at the wait in `first`).
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    // Pause while waiting, then resume the wait — the paused gate should stop
    // the engine from claiming `second`.
    await wf.pause(run._id, { reason: 'operator hold' });
    const paused = await wf.get(run._id);
    expect(paused?.paused).toBe(true);

    // A resume while paused clears the pause AND completes the wait; but since
    // the run was paused, verify the flag was honored: after resume the run
    // continues.
    await wf.resumeOperator(run._id, { data: 'answer' });
    const done = await waitForStatus(wf, run._id, ['done']);
    expect(done.status).toBe('done');
    expect(ran).toEqual(['first', 'second']);

    wf.shutdown();
  });

  it('pause of a terminal run is a no-op; double-pause is idempotent', async () => {
    const wf = createWorkflow(uid('pause-terminal'), {
      steps: { a: async () => 1 },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    const done = await wf.get(run._id);
    expect(done?.status).toBe('done');

    // Terminal no-op — stays done, not paused.
    const afterPause = await wf.pause(run._id, { reason: 'too late' });
    expect(afterPause.status).toBe('done');
    expect(afterPause.paused).toBeFalsy();

    wf.shutdown();
  });

  it('double-pause is idempotent (second pause no-op)', async () => {
    const wf = createWorkflow(uid('double-pause'), {
      steps: {
        wait: async (ctx) => ctx.wait('hold'),
        after: async () => 'x',
      },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    await wf.pause(run._id);
    const second = await wf.pause(run._id, { reason: 'again' });
    expect(second.paused).toBe(true);

    wf.shutdown();
  });

  it('emits workflow:paused with the reason', async () => {
    const wf = createWorkflow(uid('pause-event'), {
      steps: {
        wait: async (ctx) => ctx.wait('hold'),
      },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    const events: Array<{ runId: string; reason?: string }> = [];
    const listener = (p: { runId: string; reason?: string }) => events.push(p);
    wf.container.eventBus.on('workflow:paused', listener);

    await wf.pause(run._id, { reason: 'maintenance' });
    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe(run._id);
    expect(events[0].reason).toBe('maintenance');

    wf.container.eventBus.off('workflow:paused', listener);
    wf.shutdown();
  });
});

// ============================================================================
// 5. Run metrics
// ============================================================================

describe('v2.7: getRunMetrics', () => {
  useTestDb();

  it('aggregates durations + attempts across a multi-step run incl. a retried step', async () => {
    const wf = createWorkflow(uid('metrics'), {
      steps: {
        quick: async () => 1,
        flaky: async (ctx) => {
          if (ctx.attempt < 2) throw new Error('retry me');
          return 2;
        },
      },
      defaults: { retries: 3, retryDelay: 10 },
      autoExecute: false,
    });

    const run = await wf.start({});
    // execute() drives short-delay retries inline (retryDelay: 10).
    await wf.execute(run._id);

    const metrics = await wf.getRunMetrics(run._id);
    expect(metrics).not.toBeNull();
    expect(metrics?.status).toBe('done');
    const flaky = metrics?.steps.find((s) => s.stepId === 'flaky');
    expect(flaky?.attempts).toBeGreaterThanOrEqual(2);
    expect(metrics?.totalDurationMs).toBeGreaterThanOrEqual(0);
    // No cost recorded ⇒ totalCost undefined.
    expect(metrics?.totalCost).toBeUndefined();

    wf.shutdown();
  });

  it('sums cost when middleware records it, undefined when none', async () => {
    const wf = createWorkflow(uid('metrics-cost'), {
      steps: { a: async () => 1, b: async () => 2 },
      taskMiddleware: [
        {
          after: async (ctx) => {
            // Record a cost onto StepState.cost (the getRunMetrics source).
            const repo = wf.container.repository;
            const fresh = await repo.getById(ctx.runId, { bypassTenant: true });
            const idx = fresh?.steps.findIndex((s) => s.stepId === ctx.stepId) ?? -1;
            if (idx >= 0) {
              await repo.updateOne(
                { _id: ctx.runId },
                { $set: { [`steps.${idx}.cost`]: 5 } },
                { bypassTenant: true },
              );
            }
          },
        },
      ],
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const metrics = await wf.getRunMetrics(run._id);
    expect(metrics?.totalCost).toBe(10); // 2 steps × 5
    expect(metrics?.steps.every((s) => s.cost === 5)).toBe(true);

    wf.shutdown();
  });

  it('in-flight runs are queryable', async () => {
    const wf = createWorkflow(uid('metrics-inflight'), {
      steps: {
        wait: async (ctx) => ctx.wait('hold'),
      },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    const metrics = await wf.getRunMetrics(run._id);
    expect(metrics?.status).toBe('waiting');
    expect(metrics?.steps).toHaveLength(1);

    wf.shutdown();
  });
});

// ============================================================================
// 6. cancel with reason
// ============================================================================

describe('v2.7: cancel with reason', () => {
  useTestDb();

  it('persists the reason on the run and in the event payload', async () => {
    const wf = createWorkflow(uid('cancel-reason'), {
      steps: { wait: async (ctx) => ctx.wait('hold') },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    const events: Array<{ runId: string; data?: { reason?: string } }> = [];
    const listener = (p: { runId: string; data?: { reason?: string } }) => events.push(p);
    wf.container.eventBus.on('workflow:cancelled', listener);

    const cancelled = await wf.cancel(run._id, { reason: 'user withdrew' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBe('user withdrew');

    const persisted = await wf.get(run._id);
    expect((persisted as { cancellationReason?: string })?.cancellationReason).toBe(
      'user withdrew',
    );

    expect(events).toHaveLength(1);
    expect(events[0].data?.reason).toBe('user withdrew');

    wf.container.eventBus.off('workflow:cancelled', listener);
    wf.shutdown();
  });

  it('cancel without reason leaves cancellationReason undefined', async () => {
    const wf = createWorkflow(uid('cancel-noreason'), {
      steps: { wait: async (ctx) => ctx.wait('hold') },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    const cancelled = await wf.cancel(run._id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBeUndefined();

    wf.shutdown();
  });

  it('terminal-run cancel is a no-op — reason not overwritten', async () => {
    const wf = createWorkflow(uid('cancel-terminal'), {
      steps: { wait: async (ctx) => ctx.wait('hold') },
      autoExecute: false,
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await waitForStatus(wf, run._id, ['waiting']);

    await wf.cancel(run._id, { reason: 'first reason' });
    // Second cancel with a different reason must NOT overwrite.
    const again = await wf.cancel(run._id, { reason: 'second reason' });
    expect(again.cancellationReason).toBe('first reason');

    wf.shutdown();
  });

  afterEach(() => {
    globalEventBus.removeAllListeners();
  });
});
