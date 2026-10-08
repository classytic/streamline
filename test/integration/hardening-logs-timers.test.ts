/**
 * Integration regression for two v2.4.0 hardening fixes:
 *
 *  #6 — stepLogs ring-buffer cap. `flushLogs` writes
 *       `$push: { stepLogs: { $each, $slice: -maxStepLogs } }`. Without the
 *       slice the inline array grows unbounded toward Mongo's 16MB doc limit.
 *       Test: push > CAP entries → persisted `stepLogs` is capped at CAP,
 *       oldest evicted, newest retained.
 *
 *  #4 — opt-in DB-only polling. `SmartSchedulerConfig.inMemoryTimers: false`
 *       skips the per-wait `setTimeout` so a sleeping run is resumed purely by
 *       the MongoDB poll. Test: sleeping run with `inMemoryTimers: false` still
 *       completes (resumed by the poll, no in-memory timer).
 */

import { describe, expect, it, vi } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('stepLogs ring-buffer cap (hardening #6)', () => {
  it('caps persisted stepLogs at maxStepLogs — oldest evicted, newest retained', async () => {
    const CAP = 10;
    const TOTAL = 25; // > CAP, spread across two steps so multiple flushes occur

    const workflow = env.workflow('steplogs-cap', {
      maxStepLogs: CAP,
      steps: {
        first: async (ctx) => {
          for (let i = 0; i < 15; i++) ctx.log(`log-${i}`, { i });
          return 'ok';
        },
        second: async (ctx) => {
          for (let i = 15; i < TOTAL; i++) ctx.log(`log-${i}`, { i });
          return 'ok';
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');

    // flushLogs is fire-and-forget (un-awaited in the executor's finally), so
    // wait until the last step's logs have landed.
    const doc = await env.until(run._id, (d) =>
      (d.stepLogs ?? []).some((l) => l.message === `log-${TOTAL - 1}`),
    );
    const logs = doc.stepLogs ?? [];

    // Ring buffer keeps only the most recent CAP entries.
    expect(logs).toHaveLength(CAP);
    // Newest retained: the last logged message is present.
    expect(logs[logs.length - 1]?.message).toBe(`log-${TOTAL - 1}`);
    // Oldest evicted: log-0 is gone (only the tail window survives).
    expect(logs.some((l) => l.message === 'log-0')).toBe(false);
    // The retained window is exactly the last CAP messages.
    expect(logs.map((l) => l.message)).toEqual(
      Array.from({ length: CAP }, (_, k) => `log-${TOTAL - CAP + k}`),
    );
  });
});

describe('opt-in DB-only polling — inMemoryTimers:false (hardening #4)', () => {
  it('resumes a sleeping run via the poll with NO per-wait setTimeout, and still completes', async () => {
    // A sleep > SHORT_DELAY_THRESHOLD_MS (5s) is NOT handled inline — it goes
    // through scheduleResume, which normally arms a per-wait setTimeout. With
    // inMemoryTimers:false that setTimeout is skipped and the DB poll resumes
    // the run instead. Spy on setTimeout to prove no per-wait timer in the
    // sleep delay band is created (scheduler/stale intervals use other bands).
    const SLEEP_MS = 6_000;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      const workflow = env.workflow('db-only-sleep', {
        // Tight poll so the DB-driven resume happens fast in the test.
        scheduler: {
          inMemoryTimers: false,
          basePollInterval: 300,
          minPollInterval: 300,
          maxPollInterval: 300,
          adaptivePolling: false,
          idleTimeout: 60_000,
        },
        steps: {
          nap: async (ctx) => {
            await ctx.sleep(SLEEP_MS);
            return 'awake';
          },
          done: async () => 'finished',
        },
      });

      const run = await workflow.start({});
      await workflow.execute(run._id);

      const waiting = await workflow.get(run._id);
      expect(waiting?.status).toBe('waiting');

      // No per-wait resume timer in the sleep delay band (~6s) — scheduleResume
      // skipped it because inMemoryTimers:false.
      const sleepTimers = setTimeoutSpy.mock.calls.filter(
        ([, delay]) =>
          typeof delay === 'number' && delay >= SLEEP_MS - 500 && delay <= SLEEP_MS + 500,
      );
      expect(sleepTimers).toHaveLength(0);

      // The engine's own MongoDB poll loop (not env.tick) must still resume +
      // complete the run once the sleep is due — that loop is the subject.
      const final = await env.until(run._id, 'done', { timeout: 20_000, interval: 200 });
      expect(final.status).toBe('done');
      expect(final.output).toBe('finished');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
