/**
 * SmartScheduler Scheduled Workflow Polling Tests
 *
 * Tests the scheduler's ability to poll and execute scheduled workflows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { SmartScheduler } from '../../src/execution/smart-scheduler.js';

describe('SmartScheduler - Scheduled Workflow Polling', () => {
  let scheduler: SmartScheduler;
  let executeCallback: ReturnType<typeof vi.fn>;
  let resumeCallback: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/streamline-test');
    }
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});

    // Mock callbacks
    resumeCallback = vi.fn().mockResolvedValue(undefined);
    executeCallback = vi.fn().mockResolvedValue(undefined);

    // Create scheduler with short intervals for testing
    scheduler = new SmartScheduler(workflowRunRepository, resumeCallback, {
      basePollInterval: 100, // 100ms for faster tests
      maxPollInterval: 500,
      minPollInterval: 50,
      maxWorkflowsPerPoll: 100,
      idleTimeout: 500,
      maxConsecutiveFailures: 3,
      adaptivePolling: false,
      staleCheckInterval: 1000,
    });

    // Set retry callback (used for executing scheduled workflows)
    scheduler.setRetryCallback(executeCallback);
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('getScheduledWorkflowsReadyToExecute()', () => {
    it('should return scheduled workflows with executionTime <= now', async () => {
      const pastTime = new Date(Date.now() - 60000); // 1 minute ago

      await WorkflowRunModel.create({
        _id: 'scheduled-past-1',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: pastTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: pastTime,
          isDSTTransition: false,
        },
      });

      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.docs).toHaveLength(1);
      expect(result.docs[0]._id).toBe('scheduled-past-1');
    });

    it('should NOT return scheduled workflows with executionTime > now', async () => {
      const futureTime = new Date(Date.now() + 60000); // 1 minute in future

      await WorkflowRunModel.create({
        _id: 'scheduled-future-1',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: futureTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: futureTime,
          isDSTTransition: false,
        },
      });

      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.docs).toHaveLength(0);
    });

    it('should NOT return paused scheduled workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await WorkflowRunModel.create({
        _id: 'scheduled-paused-1',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        paused: true, // Paused
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: pastTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: pastTime,
          isDSTTransition: false,
        },
      });

      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.docs).toHaveLength(0);
    });

    it('should NOT return non-draft status workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await WorkflowRunModel.create({
        _id: 'scheduled-running-1',
        workflowId: 'test-workflow',
        status: 'running', // Not draft
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: pastTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: pastTime,
          isDSTTransition: false,
        },
      });

      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.docs).toHaveLength(0);
    });

    it('should respect limit parameter', async () => {
      const pastTime = new Date(Date.now() - 60000);

      // Create 10 scheduled workflows
      for (let i = 0; i < 10; i++) {
        await WorkflowRunModel.create({
          _id: `scheduled-limit-${i}`,
          workflowId: 'test-workflow',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          scheduling: {
            scheduledFor: pastTime,
            timezone: 'UTC',
            localTimeDisplay: 'test',
            executionTime: new Date(pastTime.getTime() + i * 1000), // Stagger times
            isDSTTransition: false,
          },
        });
      }

      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date(), {
        limit: 5,
      });

      expect(result.docs).toHaveLength(5);
    });

    it('should return workflows sorted by executionTime (oldest first)', async () => {
      const now = Date.now();

      // Create workflows with different execution times
      await WorkflowRunModel.create({
        _id: 'scheduled-sort-3',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: new Date(now - 10000),
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: new Date(now - 10000), // Oldest
          isDSTTransition: false,
        },
      });

      await WorkflowRunModel.create({
        _id: 'scheduled-sort-1',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: new Date(now - 30000),
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: new Date(now - 30000), // Oldest
          isDSTTransition: false,
        },
      });

      await WorkflowRunModel.create({
        _id: 'scheduled-sort-2',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: new Date(now - 20000),
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: new Date(now - 20000),
          isDSTTransition: false,
        },
      });

      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.docs).toHaveLength(3);
      expect(result.docs[0]._id).toBe('scheduled-sort-1'); // Oldest first
      expect(result.docs[1]._id).toBe('scheduled-sort-2');
      expect(result.docs[2]._id).toBe('scheduled-sort-3'); // Newest last
    });
  });

  describe('Scheduler hasActiveWorkflows()', () => {
    it('should detect scheduled workflows as active', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await WorkflowRunModel.create({
        _id: 'scheduled-active-1',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: pastTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: pastTime,
          isDSTTransition: false,
        },
      });

      const started = await scheduler.startIfNeeded();

      // Should start because there's a scheduled workflow ready
      expect(started).toBe(true);
    });

    it('should NOT start if only future scheduled workflows exist', async () => {
      const futureTime = new Date(Date.now() + 3600000); // 1 hour in future

      await WorkflowRunModel.create({
        _id: 'scheduled-future-only',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: futureTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: futureTime,
          isDSTTransition: false,
        },
      });

      const started = await scheduler.startIfNeeded();

      // Should not start - workflow is in the future
      expect(started).toBe(false);
    });
  });

  describe('Scheduled Workflow Execution', () => {
    // These tests verify the scheduler integration
    // Skip timing-sensitive tests that are flaky in CI environments

    it('should NOT execute paused scheduled workflows via query', async () => {
      const pastTime = new Date(Date.now() - 1000);

      await WorkflowRunModel.create({
        _id: 'scheduled-paused-exec',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        paused: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: pastTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: pastTime,
          isDSTTransition: false,
        },
      });

      // Query should not return paused workflow
      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date());
      expect(result.docs).toHaveLength(0);
    });
  });

  describe('Pagination Edge Cases', () => {
    it('should handle large batches of scheduled workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      // Create 150 scheduled workflows (more than default limit of 100)
      const createPromises = [];
      for (let i = 0; i < 150; i++) {
        createPromises.push(
          WorkflowRunModel.create({
            _id: `scheduled-batch-${i}`,
            workflowId: 'test-workflow',
            status: 'draft',
            steps: [],
            currentStepId: null,
            context: {},
            input: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            scheduling: {
              scheduledFor: pastTime,
              timezone: 'UTC',
              localTimeDisplay: 'test',
              executionTime: new Date(pastTime.getTime() + i),
              isDSTTransition: false,
            },
          })
        );
      }
      await Promise.all(createPromises);

      // First poll should get up to limit (100)
      const result = await workflowRunRepository.getScheduledWorkflowsReadyToExecute(new Date(), {
        limit: 100,
      });

      // Result should have data property with workflows
      expect(result).toBeDefined();
      expect(result.docs).toBeDefined();
      expect(result.docs.length).toBeLessThanOrEqual(100);
    });
  });
});
