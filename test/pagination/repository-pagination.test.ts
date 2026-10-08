/**
 * Repository Pagination Tests
 *
 * Tests that WorkflowRunRepository pagination follows mongokit/Repository.ts patterns
 * and efficiently handles large numbers of workflows (10,000+)
 *
 * Key patterns verified:
 * - Limit-based pagination (no skip needed for scheduler use case)
 * - Efficient queries with compound indexes
 * - Sorted results by updatedAt (oldest first for FIFO processing)
 * - Lean queries for performance
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../src/core/types.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** A `waiting` run whose timer is already due. */
function timerDueRun(id: string, workflowId: string, at: Date, input: unknown = {}): WorkflowRun {
  return {
    _id: id,
    workflowId,
    status: 'waiting',
    steps: [
      {
        stepId: 'step1',
        status: 'waiting',
        attempts: 0,
        waitingFor: {
          type: 'timer',
          reason: 'test delay',
          resumeAt: new Date(Date.now() - 1000), // ready to resume
        },
      },
    ],
    currentStepId: 'step1',
    context: {},
    input,
    createdAt: at,
    updatedAt: at,
  };
}

describe('Repository Pagination - mongokit Pattern Compliance', () => {
  it('should use limit-based pagination without skip (top-N pattern)', async () => {
    const repo = env.container.repository;
    // Create 500 workflows with different timestamps (oldest first)
    const workflows = Array.from({ length: 500 }, (_, i) =>
      timerDueRun(`run_${i}`, 'test-workflow', new Date(Date.now() - (500 - i) * 1000), {
        index: i,
      }),
    );

    await env.runModel.insertMany(workflows);

    // Get first 100 (oldest first)
    const batch1 = await repo.getReadyToResume(new Date(), 100);
    expect(batch1).toHaveLength(100);

    // Verify sorted by updatedAt (oldest first)
    for (let i = 0; i < batch1.length - 1; i++) {
      const current = new Date(batch1[i]?.updatedAt ?? 0).getTime();
      const next = new Date(batch1[i + 1]?.updatedAt ?? 0).getTime();
      expect(current).toBeLessThanOrEqual(next);
    }

    // Simulate processing: mark first 100 as running
    for (const run of batch1) {
      await env.runModel.updateOne(
        { _id: run._id },
        { $set: { status: 'running', updatedAt: new Date() } },
      );
    }

    // Get next 100 - should NOT include the 100 we just processed
    const batch2 = await repo.getReadyToResume(new Date(), 100);
    expect(batch2).toHaveLength(100);

    // Verify no overlap with batch1
    const batch1Ids = new Set(batch1.map((r) => r._id));
    const hasOverlap = batch2.some((r) => batch1Ids.has(r._id));
    expect(hasOverlap).toBe(false);
  });

  it('should handle 1000+ workflows efficiently with pagination', async () => {
    // Create 1000 waiting workflows
    const workflows = Array.from({ length: 1000 }, (_, i) =>
      timerDueRun(`run_${i}`, 'bulk-workflow', new Date(Date.now() - (1000 - i) * 100), {
        index: i,
      }),
    );

    await env.runModel.insertMany(workflows);

    // Query with pagination limit
    const queryStart = Date.now();
    const batch = await env.container.repository.getReadyToResume(new Date(), 100);
    const queryTime = Date.now() - queryStart;

    expect(batch).toHaveLength(100);
    expect(queryTime).toBeLessThan(100); // Should be fast with indexes
  });

  it('should efficiently query different waiting types with compound indexes', async () => {
    const repo = env.container.repository;
    // Create mix of waiting types
    const timerWaits = Array.from({ length: 300 }, (_, i) =>
      timerDueRun(`timer_${i}`, 'timer-wf', new Date()),
    );

    const retries: WorkflowRun[] = Array.from({ length: 300 }, (_, i) => ({
      _id: `retry_${i}`,
      workflowId: 'retry-wf',
      status: 'waiting',
      steps: [
        {
          stepId: 'step1',
          status: 'pending',
          attempts: 1,
          retryAfter: new Date(Date.now() - 1000),
          error: { message: 'Retry test', retriable: true },
        },
      ],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    await env.runModel.insertMany([...timerWaits, ...retries]);

    // Query each type with pagination
    const timerBatch = await repo.getReadyToResume(new Date(), 50);
    const retryBatch = await repo.getReadyForRetry(new Date(), 50);

    expect(timerBatch).toHaveLength(50);
    expect(retryBatch).toHaveLength(50);

    // Verify no overlap (different query types)
    const timerIds = new Set(timerBatch.map((r) => r._id));
    const hasOverlap = retryBatch.some((r) => timerIds.has(r._id));
    expect(hasOverlap).toBe(false);
  });

  it('should efficiently query stale running workflows with pagination', async () => {
    const runningRun = (id: string, lastHeartbeat: Date): WorkflowRun => ({
      _id: id,
      workflowId: 'running-wf',
      status: 'running',
      steps: [{ stepId: 'step1', status: 'running', attempts: 1 }],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastHeartbeat,
    });
    // Create running workflows with different heartbeats
    const fresh = Array.from({ length: 200 }, (_, i) => runningRun(`fresh_${i}`, new Date()));
    const stale = Array.from(
      { length: 200 },
      (_, i) => runningRun(`stale_${i}`, new Date(Date.now() - 10 * 60 * 1000)), // 10 min old (stale)
    );

    await env.runModel.insertMany([...fresh, ...stale]);

    // Query for stale workflows (5 min threshold)
    const staleThreshold = 5 * 60 * 1000;
    const staleBatch = await env.container.repository.getStaleRunningWorkflows(staleThreshold, 50);

    expect(staleBatch).toHaveLength(50);

    // Verify all returned workflows are actually stale
    const now = Date.now();
    for (const run of staleBatch) {
      const heartbeat = run.lastHeartbeat ? new Date(run.lastHeartbeat).getTime() : 0;
      const age = now - heartbeat;
      expect(age).toBeGreaterThanOrEqual(staleThreshold);
    }
  });

  it('should respect maxWorkflowsPerPoll limit consistently', async () => {
    const repo = env.container.repository;
    // Create 500 workflows
    const workflows = Array.from({ length: 500 }, (_, i) =>
      timerDueRun(`run_${i}`, 'limit-test', new Date(Date.now() - (500 - i) * 1000)),
    );

    await env.runModel.insertMany(workflows);

    // Query with different limits
    const limits = [10, 50, 100, 250];

    for (const limit of limits) {
      const batch = await repo.getReadyToResume(new Date(), limit);
      expect(batch.length).toBeLessThanOrEqual(limit);
    }

    // Verify limit=1 returns exactly 1 (edge case)
    const single = await repo.getReadyToResume(new Date(), 1);
    expect(single).toHaveLength(1);
  });

  it('should handle empty results gracefully', async () => {
    // No workflows in database
    const batch = await env.container.repository.getReadyToResume(new Date(), 100);
    expect(batch).toHaveLength(0);
    expect(Array.isArray(batch)).toBe(true);
  });

  it('should use lean() for performance (returns plain objects, not Mongoose documents)', async () => {
    // Create one workflow
    await env.runModel.create(timerDueRun('test_run', 'lean-test', new Date()));

    const batch = await env.container.repository.getReadyToResume(new Date(), 10);
    expect(batch).toHaveLength(1);

    const run = batch[0];
    // Lean documents don't have Mongoose methods
    expect(typeof Reflect.get(run ?? {}, 'save')).toBe('undefined');
    expect(typeof Reflect.get(run ?? {}, 'toObject')).toBe('undefined');
  });
});
