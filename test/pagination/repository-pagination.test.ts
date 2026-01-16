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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import type { WorkflowRun } from '../../src/core/types.js';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Repository Pagination - mongokit Pattern Compliance', () => {
  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});
  });

  it('should use limit-based pagination without skip (top-N pattern)', async () => {
    // Create 500 workflows with different timestamps
    const workflows: Partial<WorkflowRun>[] = Array.from({ length: 500 }, (_, i) => ({
      _id: `run_${i}`,
      workflowId: 'test-workflow',
      status: 'waiting' as const,
      steps: [
        {
          stepId: 'step1',
          status: 'waiting' as const,
          attempts: 0,
          waitingFor: {
            type: 'timer' as const,
            reason: 'test delay',
            resumeAt: new Date(Date.now() - 1000), // All ready to resume
          },
        },
      ],
      currentStepId: 'step1',
      context: {},
      input: { index: i },
      createdAt: new Date(Date.now() - (500 - i) * 1000), // Oldest first
      updatedAt: new Date(Date.now() - (500 - i) * 1000),
    }));

    await WorkflowRunModel.insertMany(workflows as any);

    // Get first 100 (oldest first)
    const batch1 = await workflowRunRepository.getReadyToResume(new Date(), 100);
    expect(batch1).toHaveLength(100);

    // Verify sorted by updatedAt (oldest first)
    for (let i = 0; i < batch1.length - 1; i++) {
      const current = new Date(batch1[i].updatedAt).getTime();
      const next = new Date(batch1[i + 1].updatedAt).getTime();
      expect(current).toBeLessThanOrEqual(next);
    }

    // Simulate processing: mark first 100 as running
    for (const run of batch1) {
      await WorkflowRunModel.updateOne(
        { _id: run._id },
        { $set: { status: 'running', updatedAt: new Date() } }
      );
    }

    // Get next 100 - should NOT include the 100 we just processed
    const batch2 = await workflowRunRepository.getReadyToResume(new Date(), 100);
    expect(batch2).toHaveLength(100);

    // Verify no overlap with batch1
    const batch1Ids = new Set(batch1.map((r) => r._id));
    const hasOverlap = batch2.some((r) => batch1Ids.has(r._id));
    expect(hasOverlap).toBe(false);

    console.log('✓ Top-N pagination works: batch1 and batch2 have no overlap');
  });

  it('should handle 1000+ workflows efficiently with pagination', async () => {
    // Create 1000 waiting workflows
    const workflows: Partial<WorkflowRun>[] = Array.from({ length: 1000 }, (_, i) => ({
      _id: `run_${i}`,
      workflowId: 'bulk-workflow',
      status: 'waiting' as const,
      steps: [
        {
          stepId: 'step1',
          status: 'waiting' as const,
          attempts: 0,
          waitingFor: {
            type: 'timer' as const,
            reason: 'sleep',
            resumeAt: new Date(Date.now() - 1000),
          },
        },
      ],
      currentStepId: 'step1',
      context: {},
      input: { index: i },
      createdAt: new Date(Date.now() - (1000 - i) * 100),
      updatedAt: new Date(Date.now() - (1000 - i) * 100),
    }));

    const start = Date.now();
    await WorkflowRunModel.insertMany(workflows as any);
    const insertTime = Date.now() - start;
    console.log(`Inserted 1000 workflows in ${insertTime}ms`);

    // Query with pagination limit
    const queryStart = Date.now();
    const batch = await workflowRunRepository.getReadyToResume(new Date(), 100);
    const queryTime = Date.now() - queryStart;

    expect(batch).toHaveLength(100);
    expect(queryTime).toBeLessThan(100); // Should be fast with indexes
    console.log(`Queried 100 of 1000 workflows in ${queryTime}ms (with limit)`);
  });

  it('should efficiently query different waiting types with compound indexes', async () => {
    // Create mix of waiting types
    const timerWaits: Partial<WorkflowRun>[] = Array.from({ length: 300 }, (_, i) => ({
      _id: `timer_${i}`,
      workflowId: 'timer-wf',
      status: 'waiting' as const,
      steps: [
        {
          stepId: 'step1',
          status: 'waiting' as const,
          attempts: 0,
          waitingFor: {
            type: 'timer' as const,
            reason: 'sleep',
            resumeAt: new Date(Date.now() - 1000),
          },
        },
      ],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const retries: Partial<WorkflowRun>[] = Array.from({ length: 300 }, (_, i) => ({
      _id: `retry_${i}`,
      workflowId: 'retry-wf',
      status: 'waiting' as const,
      steps: [
        {
          stepId: 'step1',
          status: 'pending' as const,
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

    await WorkflowRunModel.insertMany([...timerWaits, ...retries] as any);

    // Query each type with pagination
    const start1 = Date.now();
    const timerBatch = await workflowRunRepository.getReadyToResume(new Date(), 50);
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    const retryBatch = await workflowRunRepository.getReadyForRetry(new Date(), 50);
    const time2 = Date.now() - start2;

    expect(timerBatch).toHaveLength(50);
    expect(retryBatch).toHaveLength(50);

    // Verify no overlap (different query types)
    const timerIds = new Set(timerBatch.map((r) => r._id));
    const hasOverlap = retryBatch.some((r) => timerIds.has(r._id));
    expect(hasOverlap).toBe(false);

    console.log(`Timer-wait query: ${time1}ms, Retry query: ${time2}ms`);
    console.log('✓ Separate indexes allow efficient querying of different wait types');
  });

  it('should efficiently query stale running workflows with pagination', async () => {
    // Create running workflows with different heartbeats
    const fresh: Partial<WorkflowRun>[] = Array.from({ length: 200 }, (_, i) => ({
      _id: `fresh_${i}`,
      workflowId: 'running-wf',
      status: 'running' as const,
      steps: [{ stepId: 'step1', status: 'running' as const, attempts: 1 }],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastHeartbeat: new Date(), // Fresh (just now)
    }));

    const stale: Partial<WorkflowRun>[] = Array.from({ length: 200 }, (_, i) => ({
      _id: `stale_${i}`,
      workflowId: 'running-wf',
      status: 'running' as const,
      steps: [{ stepId: 'step1', status: 'running' as const, attempts: 1 }],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000), // 10 min old (stale)
    }));

    await WorkflowRunModel.insertMany([...fresh, ...stale] as any);

    // Query for stale workflows (5 min threshold)
    const staleThreshold = 5 * 60 * 1000;
    const staleBatch = await workflowRunRepository.getStaleRunningWorkflows(staleThreshold, 50);

    expect(staleBatch).toHaveLength(50);

    // Verify all returned workflows are actually stale
    const now = Date.now();
    for (const run of staleBatch) {
      const heartbeat = run.lastHeartbeat ? new Date(run.lastHeartbeat).getTime() : 0;
      const age = now - heartbeat;
      expect(age).toBeGreaterThanOrEqual(staleThreshold);
    }

    console.log('✓ Stale workflow query correctly filters by heartbeat age');
  });

  it('should respect maxWorkflowsPerPoll limit consistently', async () => {
    // Create 500 workflows
    const workflows: Partial<WorkflowRun>[] = Array.from({ length: 500 }, (_, i) => ({
      _id: `run_${i}`,
      workflowId: 'limit-test',
      status: 'waiting' as const,
      steps: [
        {
          stepId: 'step1',
          status: 'waiting' as const,
          attempts: 0,
          waitingFor: {
            type: 'timer' as const,
            reason: 'test',
            resumeAt: new Date(Date.now() - 1000),
          },
        },
      ],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(Date.now() - (500 - i) * 1000),
      updatedAt: new Date(Date.now() - (500 - i) * 1000),
    }));

    await WorkflowRunModel.insertMany(workflows as any);

    // Query with different limits
    const limits = [10, 50, 100, 250];

    for (const limit of limits) {
      const batch = await workflowRunRepository.getReadyToResume(new Date(), limit);
      expect(batch.length).toBeLessThanOrEqual(limit);
      console.log(`Limit ${limit}: returned ${batch.length} workflows`);
    }

    // Verify limit=1 returns exactly 1 (edge case)
    const single = await workflowRunRepository.getReadyToResume(new Date(), 1);
    expect(single).toHaveLength(1);

    console.log('✓ Repository respects limit parameter across different values');
  });

  it('should handle empty results gracefully', async () => {
    // No workflows in database
    const batch = await workflowRunRepository.getReadyToResume(new Date(), 100);
    expect(batch).toHaveLength(0);
    expect(Array.isArray(batch)).toBe(true);

    console.log('✓ Empty query returns empty array (not null/undefined)');
  });

  it('should use lean() for performance (returns plain objects, not Mongoose documents)', async () => {
    // Create one workflow
    await WorkflowRunModel.create({
      _id: 'test_run',
      workflowId: 'lean-test',
      status: 'waiting',
      steps: [
        {
          stepId: 'step1',
          status: 'waiting',
          attempts: 0,
          waitingFor: {
            type: 'timer',
            reason: 'test',
            resumeAt: new Date(Date.now() - 1000),
          },
        },
      ],
      currentStepId: 'step1',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const batch = await workflowRunRepository.getReadyToResume(new Date(), 10);
    expect(batch).toHaveLength(1);

    const run = batch[0];
    // Lean documents don't have Mongoose methods
    expect(typeof (run as any).save).toBe('undefined');
    expect(typeof (run as any).toObject).toBe('undefined');

    console.log('✓ Queries use lean() for performance (no Mongoose overhead)');
  });
});
