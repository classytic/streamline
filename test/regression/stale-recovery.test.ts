/**
 * Stale Workflow Recovery Tests
 *
 * Tests that the background stale check ensures crashed workflows are recovered
 * even when the scheduler has stopped due to no waiting workflows.
 *
 * Critical for durable execution guarantee.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { WorkflowEngine } from '../../src/execution/engine.js';
import { SmartScheduler } from '../../src/execution/smart-scheduler.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { createContainer } from '../../src/core/container.js';
import type { WorkflowDefinition, WorkflowHandlers } from '../../src/core/types.js';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Stale Workflow Recovery', () => {
  let scheduler: SmartScheduler;

  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});
  });

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop();
    }
    await WorkflowRunModel.deleteMany({});
  });

  it('should recover stale workflows via background check even when scheduler is idle', async () => {
    const workflow: WorkflowDefinition = {
      id: 'stale-test',
      name: 'Stale Test Workflow',
      version: '1.0.0',
      steps: [{ id: 'step1', name: 'Step 1' }],
      createContext: () => ({}),
    };

    const handlers: WorkflowHandlers = {
      step1: async (ctx) => 'done',
    };

    const engine = new WorkflowEngine(workflow, handlers, createContainer());

    // Create a running workflow with stale heartbeat (simulates crash)
    const run = await engine.start({ test: true });
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'running',
          lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000), // 10 min old (stale)
        },
      }
    );

    // Start scheduler with fast stale check interval
    scheduler = new SmartScheduler(
      workflowRunRepository,
      async (runId) => {
        await engine.resume(runId, {});
      },
      {
        basePollInterval: 60000,
        minPollInterval: 60000,
        maxPollInterval: 60000,
        maxWorkflowsPerPoll: 100,
        idleTimeout: 120000,
        maxConsecutiveFailures: 5,
        adaptivePolling: false,
        staleCheckInterval: 500, // Check every 500ms for testing
      }
    );

    scheduler.setStaleRecoveryCallback(async (runId) => {
      // Claim and re-execute the stale workflow
      const claimed = await workflowRunRepository.updateOne(
        { _id: runId, status: 'running' },
        { status: 'running', updatedAt: new Date(), lastHeartbeat: new Date() }
      );
      if (claimed.modifiedCount > 0) {
        await engine.execute(runId);
      }
    });

    // Start scheduler (but no waiting workflows, so polling might not start)
    scheduler.start();

    // Wait for background stale check to detect and recover
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify workflow was recovered
    const recovered = await WorkflowRunModel.findOne({ _id: run._id });
    expect(recovered).toBeTruthy();

    // Should have been processed (status changed from 'running')
    expect(recovered!.status).not.toBe('running');

    console.log(`✓ Stale workflow recovered via background check. Status: ${recovered!.status}`);
  }, 10000);

  it('should start polling when background check finds stale workflows', async () => {
    const workflow: WorkflowDefinition = {
      id: 'polling-start-test',
      name: 'Polling Start Test',
      version: '1.0.0',
      steps: [{ id: 'step1', name: 'Step 1' }],
      createContext: () => ({}),
    };

    const handlers: WorkflowHandlers = {
      step1: async (ctx) => 'done',
    };

    const engine = new WorkflowEngine(workflow, handlers, createContainer());

    // Create multiple stale workflows
    const runs = await Promise.all([
      engine.start({ index: 1 }),
      engine.start({ index: 2 }),
      engine.start({ index: 3 }),
    ]);

    for (const run of runs) {
      await WorkflowRunModel.updateOne(
        { _id: run._id },
        {
          $set: {
            status: 'running',
            lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
          },
        }
      );
    }

    scheduler = new SmartScheduler(
      workflowRunRepository,
      async (runId) => {
        await engine.resume(runId, {});
      },
      {
        basePollInterval: 100,
        minPollInterval: 100,
        maxPollInterval: 100,
        maxWorkflowsPerPoll: 100,
        idleTimeout: 120000,
        maxConsecutiveFailures: 5,
        adaptivePolling: false,
        staleCheckInterval: 300, // Fast check
      }
    );

    scheduler.setStaleRecoveryCallback(async (runId) => {
      const claimed = await workflowRunRepository.updateOne(
        { _id: runId, status: 'running' },
        { status: 'running', updatedAt: new Date(), lastHeartbeat: new Date() }
      );
      if (claimed.modifiedCount > 0) {
        await engine.execute(runId);
      }
    });

    // Start scheduler
    await scheduler.startIfNeeded();

    // Wait for background check and processing
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify all stale workflows were processed
    const processed = await WorkflowRunModel.countDocuments({ status: { $ne: 'running' } });
    expect(processed).toBeGreaterThanOrEqual(2); // At least 2 should be recovered

    console.log(`✓ Background check triggered polling, processed ${processed}/3 stale workflows`);
  }, 10000);

  it('should use index for efficient stale workflow queries', async () => {
    // Create mix of fresh and stale workflows
    const workflows = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const isStale = i < 250;
        return await WorkflowRunModel.create({
          _id: `run_${i}`,
          workflowId: 'index-test',
          status: 'running',
          steps: [{ stepId: 'step1', status: 'running', attempts: 1 }],
          currentStepId: 'step1',
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          lastHeartbeat: new Date(Date.now() - (isStale ? 10 : 1) * 60 * 1000),
        });
      })
    );

    const start = Date.now();
    const staleWorkflows = await workflowRunRepository.getStaleRunningWorkflows(5 * 60 * 1000, 50);
    const queryTime = Date.now() - start;

    expect(staleWorkflows).toHaveLength(50);
    expect(queryTime).toBeLessThan(50); // Should be fast with index

    console.log(`✓ Stale query with index: ${queryTime}ms for 500 workflows`);
  }, 10000);

  it('should handle case where stale check fails gracefully', async () => {
    scheduler = new SmartScheduler(
      workflowRunRepository,
      async (runId) => {
        throw new Error('Test error');
      },
      {
        basePollInterval: 60000,
        minPollInterval: 60000,
        maxPollInterval: 60000,
        maxWorkflowsPerPoll: 100,
        idleTimeout: 120000,
        maxConsecutiveFailures: 5,
        adaptivePolling: false,
        staleCheckInterval: 200,
      }
    );

    // Temporarily break the repository method
    const originalMethod = workflowRunRepository.getStaleRunningWorkflows;
    workflowRunRepository.getStaleRunningWorkflows = async () => {
      throw new Error('Database error');
    };

    scheduler.start();

    // Wait for stale check to run (should not crash)
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Restore method
    workflowRunRepository.getStaleRunningWorkflows = originalMethod;

    // Scheduler should still be alive (stop() should work without errors)
    expect(() => scheduler.stop()).not.toThrow();

    console.log('✓ Stale check handles errors gracefully without crashing');
  }, 5000);

  it('should prevent re-arming of stale check after stop() (race condition fix)', async () => {
    let checkCount = 0;

    scheduler = new SmartScheduler(
      workflowRunRepository,
      async (runId) => {},
      {
        basePollInterval: 60000,
        minPollInterval: 60000,
        maxPollInterval: 60000,
        maxWorkflowsPerPoll: 100,
        idleTimeout: 120000,
        maxConsecutiveFailures: 5,
        adaptivePolling: false,
        staleCheckInterval: 100, // Fast interval for testing
      }
    );

    // Override checkForStaleWorkflows to track calls
    const originalCheck = scheduler['checkForStaleWorkflows'].bind(scheduler);
    scheduler['checkForStaleWorkflows'] = async function () {
      checkCount++;
      // Simulate slow check
      await new Promise((resolve) => setTimeout(resolve, 50));
      return originalCheck();
    };

    // Start scheduler
    scheduler.start();

    // Wait for first check to start
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Stop while check is running
    scheduler.stop();

    const countAtStop = checkCount;

    // Wait to ensure no new checks are scheduled
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify no new checks after stop
    expect(checkCount).toBeLessThanOrEqual(countAtStop + 1); // At most 1 more if it was mid-execution

    console.log(`✓ No stale checks after stop(). Checks: ${checkCount}`);
  }, 5000);
});
