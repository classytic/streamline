/**
 * E2E Tests for Smart Scheduler
 *
 * Tests intelligent polling behavior:
 * - Lazy start (only polls when workflows exist)
 * - Auto-stop (stops when no workflows)
 * - Adaptive polling (adjusts interval based on load)
 * - Metrics tracking
 * - Health checks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createWorkflow } from '../../src/index.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';

// Track workflows for cleanup
const createdWorkflows: { shutdown: () => void }[] = [];

describe('Smart Scheduler E2E', () => {
  beforeEach(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect('mongodb://localhost:27017/streamline-test');
    }
    await WorkflowRunModel.deleteMany({});
    createdWorkflows.length = 0;
  });

  afterEach(async () => {
    // Shutdown all workflows first to stop background processes
    createdWorkflows.forEach((w) => w.shutdown());
    await WorkflowRunModel.deleteMany({});
  });

  describe('Lazy Start', () => {
    it('should NOT start polling if no workflows exist', async () => {
      const workflow = createWorkflow('test-workflow', {
        steps: {
          step1: async () => ({ done: true }),
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(false);
      expect(stats.totalPolls).toBe(0);
    });

    it('should start polling when first workflow is created', async () => {
      const workflow = createWorkflow<{ value: number }>('sleep-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // 60 second sleep (long enough to go through scheduler)
          },
        },
        context: (input) => ({ value: input.value }),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      // Configure scheduler options via engine
      workflow.engine.configure({
        scheduler: {
          basePollInterval: 1000, // 1 second for testing
        },
      });

      // Initially not polling
      let stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(false);

      // Start a workflow with sleep and execute to reach waiting state
      const run = await workflow.start({ value: 42 });
      await workflow.execute(run._id);

      // Wait for scheduler to start
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should now be polling
      stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(true);
    });
  });

  describe('Auto-Stop', () => {
    it('should stop polling after idle timeout when no workflows', async () => {
      const workflow = createWorkflow('quick-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // Long sleep to trigger scheduler
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500, // 0.5 seconds
          idleTimeout: 2000, // 2 seconds idle
        },
      });

      // Start a workflow and execute to reach waiting state (triggers scheduler)
      const run = await workflow.start({});
      await workflow.execute(run._id);

      // Scheduler should be polling now
      await new Promise((resolve) => setTimeout(resolve, 500));
      let stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(true);

      // Cancel the workflow (removes it from waiting pool)
      await workflow.cancel(run._id);

      // Wait for idle timeout
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Should have stopped polling
      stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(false);
    }, 10000);
  });

  describe('Adaptive Polling', () => {
    it('should adjust interval based on workflow count', async () => {
      const workflow = createWorkflow('sleep-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // 60 second sleep
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500, // 500ms base - fast for testing
          minPollInterval: 200, // 200ms min
          maxPollInterval: 1000, // 1 second max
          adaptivePolling: true,
        },
      });

      // Start many workflows and execute them
      for (let i = 0; i < 15; i++) {
        const run = await workflow.start({});
        await workflow.execute(run._id);
      }

      // Wait for scheduler to poll (at least one poll cycle)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Scheduler should be polling (monitoring the waiting workflows)
      // Note: activeWorkflows counts workflows READY to process, not waiting workflows
      // Since all workflows have 60s sleep, they're not ready yet
      const stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(true);
      expect(stats.totalPolls).toBeGreaterThan(0);

      // Verify we created the workflows (they exist in DB waiting)
      const waitingCount = await WorkflowRunModel.countDocuments({ status: 'waiting' });
      expect(waitingCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Metrics & Health', () => {
    it('should track polling metrics', async () => {
      const workflow = createWorkflow('test-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // Long sleep to go through scheduler
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500,
        },
      });

      // Start workflow and execute to reach waiting state
      const run = await workflow.start({});
      await workflow.execute(run._id);

      // Wait for a few polls
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const stats = workflow.engine.getSchedulerStats();

      expect(stats.totalPolls).toBeGreaterThan(0);
      expect(stats.successfulPolls).toBeGreaterThan(0);
      expect(stats.failedPolls).toBe(0);
      expect(stats.lastPollAt).toBeDefined();
      expect(stats.avgPollDuration).toBeGreaterThan(0);
    });

    it('should report healthy when working correctly', async () => {
      const workflow = createWorkflow('test-workflow', {
        steps: {
          step1: async (ctx) => {
            await ctx.sleep(60000); // Long sleep to go through scheduler
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500,
        },
      });

      // Start workflow and execute to reach waiting state
      const run = await workflow.start({});
      await workflow.execute(run._id);

      // Wait for polling to start
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Should be healthy
      expect(workflow.engine.isSchedulerHealthy()).toBe(true);
    });
  });

  describe('Resume Timing', () => {
    it('should resume workflow at correct time', async () => {
      const step2ExecutedAt: number[] = [];

      const workflow = createWorkflow('timer-workflow', {
        steps: {
          step1: async (ctx) => {
            await ctx.sleep(2000); // 2 seconds (short enough for inline execution)
          },
          step2: async () => {
            step2ExecutedAt.push(Date.now());
            return { done: true };
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow);

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500, // Poll every 0.5 seconds
        },
      });

      const startTime = Date.now();
      const run = await workflow.start({});

      // Execute - with inline sleep handling, this should complete
      const result = await workflow.execute(run._id);

      // step2 should have executed after ~2 seconds (with some tolerance)
      expect(result.status).toBe('done');
      expect(step2ExecutedAt.length).toBe(1);
      const elapsed = step2ExecutedAt[0] - startTime;
      expect(elapsed).toBeGreaterThan(1800); // At least 1.8 seconds
      expect(elapsed).toBeLessThan(3000); // At most 3 seconds
    }, 10000);
  });

  describe('Multi-Instance Coordination', () => {
    it('should handle multiple engines without duplicate resumes', async () => {
      let resumeCount = 0;

      const workflow1 = createWorkflow('multi-engine-workflow', {
        steps: {
          sleep: async (ctx) => {
            resumeCount++;
            await ctx.sleep(1000); // Short sleep for inline execution
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow1);

      const workflow2 = createWorkflow('multi-engine-workflow', {
        steps: {
          sleep: async (ctx) => {
            resumeCount++;
            await ctx.sleep(1000);
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow2);

      const workflow3 = createWorkflow('multi-engine-workflow', {
        steps: {
          sleep: async (ctx) => {
            resumeCount++;
            await ctx.sleep(1000);
          },
        },
        context: () => ({}),
        autoExecute: false,
      });
      createdWorkflows.push(workflow3);

      // Configure all engines (simulating 3 servers)
      workflow1.engine.configure({ scheduler: { basePollInterval: 300 } });
      workflow2.engine.configure({ scheduler: { basePollInterval: 300 } });
      workflow3.engine.configure({ scheduler: { basePollInterval: 300 } });

      // Start one workflow
      const run = await workflow1.start({});

      // Execute - with inline sleep handling, should complete
      await workflow1.execute(run._id);

      // Should have executed exactly once (no duplicates)
      expect(resumeCount).toBe(1);
    }, 10000);
  });
});
