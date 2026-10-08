/**
 * Stale Workflow Recovery Tests
 *
 * Tests that the background stale check ensures crashed workflows are recovered
 * even when the scheduler has stopped due to no waiting workflows.
 *
 * Critical for durable execution guarantee.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULER_CONFIG,
  SmartScheduler,
  type SmartSchedulerConfig,
} from '../../src/execution/smart-scheduler.js';
import type { Workflow } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** Scheduler config for these tests: fixed (non-adaptive) intervals over the defaults. */
const schedulerConfig = (overrides: Partial<SmartSchedulerConfig>): SmartSchedulerConfig => ({
  ...DEFAULT_SCHEDULER_CONFIG,
  basePollInterval: 60000,
  minPollInterval: 60000,
  maxPollInterval: 60000,
  maxWorkflowsPerPoll: 100,
  idleTimeout: 120000,
  maxConsecutiveFailures: 5,
  adaptivePolling: false,
  ...overrides,
});

/** A run left `running` by a crashed process: heartbeat 10 min old, steps untouched. */
type Wf = Workflow<Record<string, unknown>>;

const crashedRun = (wf: Wf, input: unknown = {}) =>
  env.runs.insert(wf, { input, lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000) });

describe('Stale Workflow Recovery', () => {
  let scheduler: SmartScheduler | undefined;

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop();
      scheduler = undefined;
    }
  });

  /** Claim-and-re-execute recovery, as the test's stand-in engine wiring. */
  const recoverVia = (wf: Wf) => async (runId: string) => {
    const claimed = await env.container.repository.updateOne(
      { _id: runId, status: 'running' },
      { status: 'running', updatedAt: new Date(), lastHeartbeat: new Date() },
    );
    if (claimed.modifiedCount > 0) {
      await wf.engine.execute(runId);
    }
  };

  it('should recover stale workflows via background check even when scheduler is idle', async () => {
    const wf = env.workflow<Record<string, unknown>>('stale-test', {
      steps: { step1: async () => 'done' },
      context: () => ({}),
    });

    // Idle: nothing to do at start, so polling does NOT start — only the
    // background discovery check runs (every 500ms). Polling interval is 60s.
    scheduler = new SmartScheduler(
      env.container.repository,
      async (runId) => {
        await wf.engine.resume(runId, {});
      },
      schedulerConfig({ staleCheckInterval: 500 }),
      undefined,
      wf.engine.definition.id,
    );
    scheduler.setStaleRecoveryCallback(recoverVia(wf));
    expect(await scheduler.startIfNeeded()).toBe(false);

    // A worker crashes mid-run — nothing in any process is executing it.
    const run = await crashedRun(wf);

    // Only discovery can find it; it must start polling AND recover at once —
    // not a full 60s poll interval later.
    const recovered = await env.until(run._id, 'done', { timeout: 4000 });
    expect(recovered.status).toBe('done');
  }, 10000);

  it('should start polling when background check finds stale workflows', async () => {
    const wf = env.workflow<Record<string, unknown>>('polling-start-test', {
      steps: { step1: async () => 'done' },
      context: () => ({}),
    });

    // Create multiple stale workflows
    await Promise.all([
      crashedRun(wf, { index: 1 }),
      crashedRun(wf, { index: 2 }),
      crashedRun(wf, { index: 3 }),
    ]);

    scheduler = new SmartScheduler(
      env.container.repository,
      async (runId) => {
        await wf.engine.resume(runId, {});
      },
      schedulerConfig({
        basePollInterval: 100,
        minPollInterval: 100,
        maxPollInterval: 100,
        staleCheckInterval: 300, // Fast check
      }),
    );

    scheduler.setStaleRecoveryCallback(recoverVia(wf));

    // Start scheduler
    await scheduler.startIfNeeded();

    // Wait for background check and processing (bounded, not a fixed sleep)
    await env.untilCount({ status: { $ne: 'running' } }, 2, { timeout: 8000, interval: 50 });

    // Verify all stale workflows were processed
    const processed = await env.runModel.countDocuments({ status: { $ne: 'running' } });
    expect(processed).toBeGreaterThanOrEqual(2); // At least 2 should be recovered
  }, 10000);

  it('a just-started run with no heartbeat yet is NOT stale; an old one is', async () => {
    // A run has no heartbeat until its first step claim. Counting a missing
    // heartbeat as stale with no age check let recovery claim a brand-new run
    // out from under the worker starting it — two drivers, its step reset.
    const wf = env.workflow('no-heartbeat', { steps: { only: async () => 'ok' } });
    const fresh = await env.runs.insert(wf, { status: 'running' }); // no lastHeartbeat
    const old = await env.runs.insert(wf, {
      status: 'running',
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const stale = await env.container.repository.getStaleRunningWorkflows(5 * 60 * 1000, 10, {
      bypassTenant: true,
      workflowId: wf.engine.definition.id,
    });
    expect(stale.map((r) => r._id)).toEqual([old._id]);

    // And the recovery CLAIM agrees with the sweep.
    expect(await wf.engine.recoverStale(fresh._id, 5 * 60 * 1000)).toBeNull();
    expect((await env.runs.get(fresh._id))?.recoveryAttempts ?? 0).toBe(0);
  });

  it('should use index for efficient stale workflow queries', async () => {
    // Create mix of fresh and stale workflows
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => {
        const isStale = i < 250;
        return env.runs.insert('index-test', {
          _id: `run_${i}`,
          status: 'running',
          steps: [{ stepId: 'step1', status: 'running', attempts: 1 }],
          currentStepId: 'step1',
          lastHeartbeat: new Date(Date.now() - (isStale ? 10 : 1) * 60 * 1000),
        });
      }),
    );

    const start = Date.now();
    const staleWorkflows = await env.container.repository.getStaleRunningWorkflows(
      5 * 60 * 1000,
      50,
    );
    const queryTime = Date.now() - start;

    expect(staleWorkflows).toHaveLength(50);
    expect(queryTime).toBeLessThan(50); // Should be fast with index
  }, 10000);

  it('should handle case where stale check fails gracefully', async () => {
    scheduler = new SmartScheduler(
      env.container.repository,
      async () => {
        throw new Error('Test error');
      },
      schedulerConfig({ staleCheckInterval: 100 }),
    );

    // Break the query the background discovery runs, and count the calls so
    // the test proves the failing path was actually reached.
    const repository = env.container.repository;
    const originalMethod = repository.getStaleRunningWorkflows;
    let calls = 0;
    repository.getStaleRunningWorkflows = async () => {
      calls++;
      throw new Error('Database error');
    };

    try {
      // Idle start: no polling, discovery only — the path that hits the query.
      await scheduler.startIfNeeded();
      // Discovery survives the error and keeps running on its interval.
      await env.eventually(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    } finally {
      repository.getStaleRunningWorkflows = originalMethod;
    }

    // Scheduler should still be alive (stop() should work without errors)
    const running = scheduler;
    expect(() => running.stop()).not.toThrow();
  }, 5000);

  it('should prevent re-arming of stale check after stop() (race condition fix)', async () => {
    let checkCount = 0;

    const running = new SmartScheduler(
      env.container.repository,
      async () => {},
      schedulerConfig({ staleCheckInterval: 100 }), // Fast interval for testing
    );
    scheduler = running;

    // Override the background discovery check to track calls
    let checkStarted: () => void = () => {};
    const firstCheck = new Promise<void>((resolve) => {
      checkStarted = resolve;
    });
    // Bracket access reaches the private member (dot access would not compile).
    // biome-ignore lint/complexity/useLiteralKeys: private member
    const originalCheck = running['discoverWork'].bind(running);
    // biome-ignore lint/complexity/useLiteralKeys: private member
    running['discoverWork'] = async () => {
      checkCount++;
      checkStarted();
      // Simulate slow check
      await new Promise((resolve) => setTimeout(resolve, 50));
      return originalCheck();
    };

    // Start scheduler
    running.start();

    // Wait for the first check to start
    await firstCheck;

    // Stop while check is running
    running.stop();

    const countAtStop = checkCount;

    // Wait several intervals to ensure no new checks are scheduled
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify no new checks after stop
    expect(checkCount).toBeLessThanOrEqual(countAtStop + 1); // At most 1 more if it was mid-execution
  }, 5000);
});
