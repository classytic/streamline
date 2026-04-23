/**
 * Integration test for v2.2 heartbeat backpressure.
 *
 * Problem the feature solves: if the heartbeat write keeps failing while a
 * step handler is running, the stale-detector will eventually flip the run
 * from `running` → re-claimable by another worker, producing a double
 * execution. Previously the executor emitted warnings but let the step run
 * indefinitely. Now, after `HEARTBEAT_FAILURE_ABORT_THRESHOLD` consecutive
 * failures, the executor aborts the step's `AbortController` so the handler
 * exits before the stale-detector window closes.
 *
 * This suite verifies:
 *   1. A handler that observes `ctx.signal.aborted` sees it flip to `true`
 *      once the heartbeat update starts failing.
 *   2. The emitted `engine:error` events escalate through
 *      `heartbeat-warning` → `heartbeat-critical` → `heartbeat-abort`.
 *   3. Short-lived failures (under threshold) do NOT abort the step.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { TIMING } from '../../src/config/constants.js';
import { cleanupTestDB, setupTestDB, teardownTestDB } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

// We're manipulating the executor's heartbeat interval and the repository's
// `updateOne` method to simulate failures quickly. Keep these helpers small
// and close to the test so the wiring stays obvious.
function speedUpHeartbeat(ms = 20): () => void {
  const original = TIMING.HEARTBEAT_INTERVAL_MS;
  (TIMING as unknown as { HEARTBEAT_INTERVAL_MS: number }).HEARTBEAT_INTERVAL_MS = ms;
  return () => {
    (TIMING as unknown as { HEARTBEAT_INTERVAL_MS: number }).HEARTBEAT_INTERVAL_MS = original;
  };
}

describe('heartbeat backpressure', () => {
  it('aborts the step after HEARTBEAT_FAILURE_ABORT_THRESHOLD consecutive failures', async () => {
    const restoreInterval = speedUpHeartbeat(20);

    const wf = createWorkflow('heartbeat-abort', {
      steps: {
        slow: async (ctx) => {
          // Block long enough for the heartbeat loop to tick past the
          // abort threshold. Exit early if the signal aborts.
          return await new Promise<string>((resolve) => {
            const deadline = Date.now() + 2000;
            const tick = () => {
              if (ctx.signal.aborted) return resolve('aborted');
              if (Date.now() >= deadline) return resolve('timeout');
              setTimeout(tick, 10);
            };
            tick();
          });
        },
      },
      autoExecute: false,
    });

    // Break heartbeat writes — every call to updateOne with only a
    // `lastHeartbeat` field throws. Leave other updates alone so setup +
    // completion writes still work.
    const repo = wf.container.repository;
    const originalUpdateOne = repo.updateOne.bind(repo);
    const spy = vi
      .spyOn(repo, 'updateOne')
      .mockImplementation(
        async (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          options?: Parameters<typeof originalUpdateOne>[2],
        ) => {
          const update$set = (update as { $set?: Record<string, unknown> }).$set;
          const isHeartbeatOnly =
            (update.lastHeartbeat !== undefined && Object.keys(update).length === 1) ||
            (update$set?.lastHeartbeat !== undefined && Object.keys(update$set).length === 1);
          if (isHeartbeatOnly) throw new Error('simulated heartbeat outage');
          return originalUpdateOne(filter, update, options);
        },
      );

    const errorEvents: string[] = [];
    wf.container.eventBus.on('engine:error', (payload) => {
      errorEvents.push(payload.context);
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    spy.mockRestore();
    restoreInterval();
    wf.shutdown();

    // Either the step handler saw the signal flip and resolved 'aborted',
    // or the step's own failure path ran due to the abort error bubbling.
    const stepOutput = result.steps[0].output;
    const stepStatus = result.steps[0].status;
    const observedAbort = stepOutput === 'aborted' || stepStatus === 'failed';
    expect(observedAbort).toBe(true);

    // Escalation: at least one heartbeat-abort event must have fired.
    expect(errorEvents).toContain('heartbeat-abort');

    // Warnings must precede the abort — the threshold is > 1.
    const abortIndex = errorEvents.indexOf('heartbeat-abort');
    const warningsBeforeAbort = errorEvents
      .slice(0, abortIndex)
      .filter((c) => c === 'heartbeat-warning' || c === 'heartbeat-critical').length;
    expect(warningsBeforeAbort).toBeGreaterThanOrEqual(1);
  });

  it('a few transient heartbeat failures (below threshold) do NOT abort the step', async () => {
    const restoreInterval = speedUpHeartbeat(20);

    const wf = createWorkflow('heartbeat-transient', {
      steps: {
        quick: async () => 'ok',
      },
      autoExecute: false,
    });

    const repo = wf.container.repository;
    const originalUpdateOne = repo.updateOne.bind(repo);

    // Fail the first two heartbeat writes, then heal. Threshold is 5, so
    // the step should still complete successfully.
    let hbCalls = 0;
    vi.spyOn(repo, 'updateOne').mockImplementation(
      async (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Parameters<typeof originalUpdateOne>[2],
      ) => {
        const update$set = (update as { $set?: Record<string, unknown> }).$set;
        const isHeartbeatOnly =
          (update.lastHeartbeat !== undefined && Object.keys(update).length === 1) ||
          (update$set?.lastHeartbeat !== undefined && Object.keys(update$set).length === 1);
        if (isHeartbeatOnly) {
          hbCalls += 1;
          if (hbCalls <= 2) throw new Error('transient');
        }
        return originalUpdateOne(filter, update, options);
      },
    );

    const errorEvents: string[] = [];
    wf.container.eventBus.on('engine:error', (p) => errorEvents.push(p.context));

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    vi.restoreAllMocks();
    restoreInterval();
    wf.shutdown();

    expect(result.status).toBe('done');
    expect(errorEvents).not.toContain('heartbeat-abort');
  });
});
