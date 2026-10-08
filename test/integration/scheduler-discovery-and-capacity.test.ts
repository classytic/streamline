/**
 * Scheduler discovery and capacity (review 2026-09-30, findings 2 and 3).
 *
 *   2. An idle scheduler only looked for STALE running runs, so a scheduled
 *      draft that was not yet due when polling went idle was never discovered.
 *   3. `poll()` returned as soon as `countRunning()` hit
 *      `maxConcurrentExecutions` — BEFORE stale recovery — so stale runs could
 *      hold every slot and block their own recovery. And `maxWorkflowsPerPoll`
 *      was handed to each pickup category in full, so one poll dispatched a
 *      multiple of it.
 *
 * Tests the SmartScheduler itself (mocked callbacks), against the env's
 * repository and run fixtures.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCHEDULER_CONFIG,
  SmartScheduler,
  type SmartSchedulerConfig,
} from '../../src/execution/smart-scheduler.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

function scheduler(workflowId: string, config: Partial<SmartSchedulerConfig>) {
  const resume = vi.fn(async (_runId: string) => {});
  const s = new SmartScheduler(
    env.container.repository,
    resume,
    { ...DEFAULT_SCHEDULER_CONFIG, ...config },
    undefined,
    workflowId,
  );
  const retry = vi.fn(async (_runId: string) => {});
  const recover = vi.fn(async (_runId: string, _staleThresholdMs: number) => {});
  s.setRetryCallback(retry);
  s.setStaleRecoveryCallback(recover);
  return { s, resume, retry, recover };
}

describe('scheduler — discovery and capacity', () => {
  const started: SmartScheduler[] = [];
  afterEach(() => {
    for (const s of started.splice(0)) s.stop();
  });

  it('an idle scheduler starts a scheduled draft when it becomes due (no stale runs needed)', async () => {
    const wf = 'disc';
    const due = new Date(Date.now() + 300);
    const draft = await env.runs.insert(wf, {
      status: 'draft',
      scheduling: {
        executionTime: due,
        scheduledFor: due.toISOString(),
        localTimeDisplay: due.toISOString(),
        timezone: 'UTC',
        isDSTTransition: false,
      },
    });
    const { s, retry } = scheduler(wf, { basePollInterval: 50, minPollInterval: 50 });
    started.push(s);

    // Nothing is due yet: not polling — but the next deadline is armed.
    expect(await s.startIfNeeded()).toBe(false);
    await env.eventually(() => expect(retry).toHaveBeenCalledWith(draft._id), { timeout: 3_000 });
  });

  it('stale recovery runs even when stale runs fill every execution slot', async () => {
    const wf = 'cap';
    const stale = await env.runs.staleRunning(wf);
    const { s, recover } = scheduler(wf, { maxConcurrentExecutions: 1, staleThreshold: 60_000 });

    await s.pollOnce();
    expect(recover).toHaveBeenCalledWith(stale._id, 60_000);
  });

  it('maxWorkflowsPerPoll is ONE budget shared across categories', async () => {
    const wf = 'budget';
    await env.runs.timerDue(wf);
    await env.runs.retryDue(wf);
    const { s, resume, retry } = scheduler(wf, { maxWorkflowsPerPoll: 1 });

    await s.pollOnce();
    expect(resume.mock.calls.length + retry.mock.calls.length).toBe(1);
  });
});

describe('scheduler — fair admission', () => {
  /** Seeds due timers, due retries and due scheduled drafts; returns the drafts' ids. */
  async function seed(
    wf: string,
    timers: number,
    retries: number,
    scheduledDrafts: number,
  ): Promise<Set<string>> {
    for (let i = 0; i < timers; i++) await env.runs.timerDue(wf);
    for (let i = 0; i < retries; i++) await env.runs.retryDue(wf);
    const scheduled = new Set<string>();
    for (let i = 0; i < scheduledDrafts; i++) scheduled.add((await env.runs.scheduledDue(wf))._id);
    return scheduled;
  }

  it('a timer backlog cannot take the whole budget — retries and scheduled starts get a share', async () => {
    const wf = 'fair';
    const scheduledIds = await seed(wf, 20, 3, 3);
    const { s, resume, retry } = scheduler(wf, { maxWorkflowsPerPoll: 6 });

    await s.pollOnce();
    await s.drain();

    const retried = retry.mock.calls.map(([id]) => id);
    expect(resume.mock.calls.length).toBeGreaterThan(0); // timers still served
    expect(retried.filter((id) => !scheduledIds.has(id)).length).toBeGreaterThan(0); // retries
    expect(retried.filter((id) => scheduledIds.has(id)).length).toBeGreaterThan(0); // scheduled
    expect(resume.mock.calls.length + retry.mock.calls.length).toBe(6); // one shared budget
  });

  it('with a budget of 1, rotation reaches every category in turn', async () => {
    const wf = 'fair-rotate';
    const scheduledIds = await seed(wf, 20, 3, 3);
    const { s, resume, retry } = scheduler(wf, { maxWorkflowsPerPoll: 1 });

    for (let i = 0; i < 6; i++) {
      await s.pollOnce();
      await s.drain();
    }

    const retried = retry.mock.calls.map(([id]) => id);
    expect(resume.mock.calls.length).toBeGreaterThan(0);
    expect(retried.some((id) => !scheduledIds.has(id))).toBe(true);
    expect(retried.some((id) => scheduledIds.has(id))).toBe(true);
  });
});

describe('scheduler — dispatch pool', () => {
  /** `n` runs ready for retry. */
  async function retryReady(wf: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await env.runs.retryDue(wf))._id);
    return ids;
  }

  function gatedScheduler(wf: string, config: Partial<SmartSchedulerConfig>) {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const started: string[] = [];
    const s = new SmartScheduler(
      env.container.repository,
      async () => {},
      { ...DEFAULT_SCHEDULER_CONFIG, ...config },
      undefined,
      wf,
    );
    s.setRetryCallback(async (runId) => {
      started.push(runId);
      await gate; // a long-running workflow
    });
    return { s, started, poll: () => s.pollOnce(), open: () => open() };
  }

  it('a poll does not wait for the workflows it dispatches', async () => {
    const wf = 'pool-nonblocking';
    await retryReady(wf, 2);
    const { s, started, poll, open } = gatedScheduler(wf, { dispatchConcurrency: 5 });

    // Before the pool, poll() awaited each workflow in turn: the first gated
    // run would hang it and the second would never start.
    await poll();
    expect(started).toHaveLength(2);
    expect(s.inFlightCount).toBe(2);

    open();
    await s.drain();
    expect(s.inFlightCount).toBe(0);
  });

  it('caps in-flight work at dispatchConcurrency, across polls', async () => {
    const wf = 'pool-cap';
    await retryReady(wf, 5);
    const { s, started, poll, open } = gatedScheduler(wf, { dispatchConcurrency: 2 });

    await poll();
    await poll(); // the pool is full — intake budget is 0
    expect(started).toHaveLength(2);
    expect(s.inFlightCount).toBe(2);

    open();
    await s.drain();
  });

  it('never dispatches a run that is already in flight', async () => {
    const wf = 'pool-dedupe';
    const [id] = await retryReady(wf, 1);
    const { s, started, poll, open } = gatedScheduler(wf, { dispatchConcurrency: 5 });

    await poll();
    await poll(); // the run is still `waiting` in the DB — but in flight here
    expect(started).toEqual([id]);

    open();
    await s.drain();
  });
});
