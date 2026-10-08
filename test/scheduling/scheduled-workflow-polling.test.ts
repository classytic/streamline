/**
 * SmartScheduler Scheduled Workflow Polling Tests
 *
 * Tests the scheduler's ability to poll and execute scheduled workflows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCHEDULER_CONFIG, SmartScheduler } from '../../src/execution/smart-scheduler.js';
import type { RunFields } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** A scheduled `draft` run whose execution time is `executionTime`. */
function scheduledDraft(id: string, executionTime: Date, fields: RunFields = {}) {
  return env.runs.insert('test-workflow', {
    _id: id,
    status: 'draft',
    steps: [],
    currentStepId: null,
    scheduling: {
      scheduledFor: executionTime.toISOString(),
      timezone: 'UTC',
      localTimeDisplay: 'test',
      executionTime,
      isDSTTransition: false,
    },
    ...fields,
  });
}

describe('SmartScheduler - Scheduled Workflow Polling', () => {
  let scheduler: SmartScheduler;

  beforeEach(() => {
    // Mock callbacks
    const resumeCallback = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);
    const executeCallback = vi
      .fn<(runId: string) => Promise<unknown>>()
      .mockResolvedValue(undefined);

    // Create scheduler with short intervals for testing
    scheduler = new SmartScheduler(env.container.repository, resumeCallback, {
      ...DEFAULT_SCHEDULER_CONFIG,
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

      await scheduledDraft('scheduled-past-1', pastTime);

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?._id).toBe('scheduled-past-1');
    });

    it('should NOT return scheduled workflows with executionTime > now', async () => {
      const futureTime = new Date(Date.now() + 60000); // 1 minute in future

      await scheduledDraft('scheduled-future-1', futureTime);

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.data).toHaveLength(0);
    });

    it('should NOT return paused scheduled workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await scheduledDraft('scheduled-paused-1', pastTime, { paused: true });

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.data).toHaveLength(0);
    });

    it('should NOT return non-draft status workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await scheduledDraft('scheduled-running-1', pastTime, { status: 'running' }); // Not draft

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.data).toHaveLength(0);
    });

    it('should respect limit parameter', async () => {
      const pastTime = new Date(Date.now() - 60000);

      // Create 10 scheduled workflows (staggered times)
      for (let i = 0; i < 10; i++) {
        await scheduledDraft(`scheduled-limit-${i}`, new Date(pastTime.getTime() + i * 1000));
      }

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(
        new Date(),
        { limit: 5 },
      );

      expect(result.data).toHaveLength(5);
    });

    it('should return workflows sorted by executionTime (oldest first)', async () => {
      const now = Date.now();

      // Create workflows with different execution times
      await scheduledDraft('scheduled-sort-3', new Date(now - 10000)); // Newest
      await scheduledDraft('scheduled-sort-1', new Date(now - 30000)); // Oldest
      await scheduledDraft('scheduled-sort-2', new Date(now - 20000));

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());

      expect(result.data).toHaveLength(3);
      expect(result.data[0]?._id).toBe('scheduled-sort-1'); // Oldest first
      expect(result.data[1]?._id).toBe('scheduled-sort-2');
      expect(result.data[2]?._id).toBe('scheduled-sort-3'); // Newest last
    });
  });

  describe('Scheduler hasActiveWorkflows()', () => {
    it('should detect scheduled workflows as active', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await scheduledDraft('scheduled-active-1', pastTime);

      const started = await scheduler.startIfNeeded();

      // Should start because there's a scheduled workflow ready
      expect(started).toBe(true);
    });

    it('should NOT start if only future scheduled workflows exist', async () => {
      const futureTime = new Date(Date.now() + 3600000); // 1 hour in future

      await scheduledDraft('scheduled-future-only', futureTime);

      const started = await scheduler.startIfNeeded();

      // Should not start - workflow is in the future
      expect(started).toBe(false);
    });
  });

  describe('Scheduled Workflow Execution', () => {
    it('should NOT execute paused scheduled workflows via query', async () => {
      const pastTime = new Date(Date.now() - 1000);

      await scheduledDraft('scheduled-paused-exec', pastTime, { paused: true });

      // Query should not return paused workflow
      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());
      expect(result.data).toHaveLength(0);
    });
  });

  describe('Pagination Edge Cases', () => {
    it('should handle large batches of scheduled workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      // Create 150 scheduled workflows (more than default limit of 100)
      await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
          scheduledDraft(`scheduled-batch-${i}`, new Date(pastTime.getTime() + i)),
        ),
      );

      // First poll should get up to limit (100)
      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(
        new Date(),
        { limit: 100 },
      );

      // Result should have data property with workflows
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.data.length).toBeLessThanOrEqual(100);
    });
  });
});
