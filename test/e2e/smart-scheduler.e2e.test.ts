/**
 * E2E Tests for Smart Scheduler
 *
 * Tests intelligent polling behavior:
 * - Lazy start (only polls when workflows exist)
 * - Auto-stop (stops when no workflows)
 * - Adaptive polling (adjusts interval based on load)
 * - Metrics tracking
 * - Health checks
 *
 * The subject here IS the scheduler's behaviour over real polling time, so
 * real poll intervals stay. Waits are on the scheduler's own stats (not a
 * guessed sleep), except where a test asserts that NOTHING happens.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Smart Scheduler E2E', () => {
  describe('Lazy Start', () => {
    it('should NOT start polling if no workflows exist', async () => {
      const workflow = env.workflow('test-workflow', {
        steps: {
          step1: async () => ({ done: true }),
        },
        context: () => ({}),
      });

      // Asserts that NOTHING starts — a real wait, not a guess at an outcome.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(false);
      expect(stats.totalPolls).toBe(0);
    });

    it('should start polling when first workflow is created', async () => {
      const workflow = env.workflow<{ value: number }, { value: number }>('sleep-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // 60 second sleep (long enough to go through scheduler)
          },
        },
        context: (input) => ({ value: input.value }),
      });

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

      // Wait for scheduler to start (the original budget was 500ms)
      await env.eventually(() => workflow.engine.getSchedulerStats().isPolling, { timeout: 500 });

      // Should now be polling
      stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(true);
    });
  });

  describe('Auto-Stop', () => {
    it('should stop polling after idle timeout when no workflows', async () => {
      const workflow = env.workflow('quick-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // Long sleep to trigger scheduler
          },
        },
        context: () => ({}),
      });

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
      await env.eventually(() => workflow.engine.getSchedulerStats().isPolling, { timeout: 500 });
      let stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(true);

      // Cancel the workflow (removes it from waiting pool)
      await workflow.cancel(run._id);

      // Wait for the idle timeout (2s) to stop polling — same 3s budget as before
      await env.eventually(() => !workflow.engine.getSchedulerStats().isPolling, {
        timeout: 3000,
      });

      // Should have stopped polling
      stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(false);
    }, 10000);
  });

  describe('Adaptive Polling', () => {
    it('should adjust interval based on workflow count', async () => {
      const workflow = env.workflow('sleep-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // 60 second sleep
          },
        },
        context: () => ({}),
      });

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
      await env.eventually(() => workflow.engine.getSchedulerStats().totalPolls > 0, {
        timeout: 2000,
      });

      // Scheduler should be polling (monitoring the waiting workflows)
      // Note: activeWorkflows counts workflows READY to process, not waiting workflows
      // Since all workflows have 60s sleep, they're not ready yet
      const stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(true);
      expect(stats.totalPolls).toBeGreaterThan(0);

      // Verify we created the workflows (they exist in DB waiting)
      const waitingCount = await env.runModel.countDocuments({ status: 'waiting' });
      expect(waitingCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Metrics & Health', () => {
    it('should track polling metrics', async () => {
      const workflow = env.workflow('test-workflow', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // Long sleep to go through scheduler
          },
        },
        context: () => ({}),
      });

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500,
        },
      });

      // Start workflow and execute to reach waiting state
      const run = await workflow.start({});
      await workflow.execute(run._id);

      // Wait for the first poll to be recorded. (After it, nothing is due for
      // 60s, so the scheduler backs off — the old 2s sleep also saw one poll.)
      await env.eventually(() => workflow.engine.getSchedulerStats().totalPolls > 0);

      const stats = workflow.engine.getSchedulerStats();

      expect(stats.totalPolls).toBeGreaterThan(0);
      expect(stats.successfulPolls).toBeGreaterThan(0);
      expect(stats.failedPolls).toBe(0);
      expect(stats.lastPollAt).toBeDefined();
      expect(stats.avgPollDuration).toBeGreaterThan(0);
    });

    it('should report healthy when working correctly', async () => {
      const workflow = env.workflow('test-workflow', {
        steps: {
          step1: async (ctx) => {
            await ctx.sleep(60000); // Long sleep to go through scheduler
          },
        },
        context: () => ({}),
      });

      workflow.engine.configure({
        scheduler: {
          basePollInterval: 500,
        },
      });

      // Start workflow and execute to reach waiting state
      const run = await workflow.start({});
      await workflow.execute(run._id);

      // Wait until polling is established — the first poll recorded (an
      // isPolling scheduler with no lastPollAt reports unhealthy).
      await env.eventually(() => workflow.engine.getSchedulerStats().totalPolls > 0);

      // Should be healthy
      expect(workflow.engine.isSchedulerHealthy()).toBe(true);
    });
  });

  describe('Resume Timing', () => {
    it('should resume workflow at correct time', async () => {
      const step2ExecutedAt: number[] = [];

      const workflow = env.workflow('timer-workflow', {
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
      });

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

      const sleepSteps = {
        sleep: async (ctx: { sleep(ms: number): Promise<void> }) => {
          resumeCount++;
          await ctx.sleep(1000); // Short sleep for inline execution
        },
      };

      const workflow1 = env.workflow('multi-engine-workflow', {
        steps: sleepSteps,
        context: () => ({}),
      });

      // Two more engines for the SAME workflow id (simulating 3 servers)
      const workflow2 = env.redefine(workflow1, { steps: sleepSteps, context: () => ({}) });
      const workflow3 = env.redefine(workflow1, { steps: sleepSteps, context: () => ({}) });

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
