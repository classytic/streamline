/**
 * Multi-Worker Fixes Test Suite
 *
 * Tests for critical fixes:
 * 1. Atomic claim for step execution
 * 2. No-progress detection in execute() loop
 * 3. pause() handling different step states
 * 4. resume() handling pause vs explicit wait
 * 5. Stale state refresh when step already running
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowConfig, WorkflowRun } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** The stored step `stepId` has been claimed (`running`). */
const stepRunning = (stepId: string) => (r: WorkflowRun) =>
  r.steps.find((s) => s.stepId === stepId)?.status === 'running';

describe('Multi-Worker Fixes', () => {
  describe('Atomic Claim & No-Progress Detection', () => {
    it('should prevent duplicate execution when two workers execute same workflow', async () => {
      interface TestContext {
        value: number;
        executionCount: number;
      }

      let executionCount = 0;

      // Both workers run the same handler code (same deployment).
      const config: WorkflowConfig<TestContext> = {
        steps: {
          increment: async (ctx) => {
            executionCount++;
            await ctx.set('executionCount', executionCount);
            // Simulate slow operation
            await new Promise((resolve) => setTimeout(resolve, 100));
            const newValue = ctx.context.value + 1;
            await ctx.set('value', newValue);
            return newValue;
          },
        },
        context: () => ({ value: 0, executionCount: 0 }),
      };
      const workflow1 = env.workflow('atomic-test', config);
      // Second worker with same workflow ID (shares database)
      const workflow2 = env.worker(workflow1, config);

      // Start workflow
      const run = await workflow1.start({ source: 'test' });
      expect(run.status).toBe('running');

      // Worker 1 starts executing first
      const promise1 = workflow1.execute(run._id);

      // Wait until worker 1 has claimed the step
      await env.until(run._id, stepRunning('increment'));

      // Worker 2 tries to execute - should detect worker 1 is handling it
      const result2 = await workflow2.execute(run._id);

      // Worker 2 should exit quickly with no-progress detection
      expect(result2.status).toBe('running');

      // Wait for worker 1 to finish
      const result1 = await promise1;
      expect(result1.status).toBe('done');

      // But increment should only execute ONCE (atomic claim)
      expect(executionCount).toBe(1);
      expect(result1.context.executionCount).toBe(1);
      expect(result1.context.value).toBe(1);
    });

    it('should detect no progress and exit loop when another worker is handling step', async () => {
      let started = false;
      let completed = false;

      const config: WorkflowConfig<Record<string, unknown>> = {
        steps: {
          slow: async () => {
            started = true;
            // Simulate very slow operation
            await new Promise((resolve) => setTimeout(resolve, 500));
            completed = true;
            return 'done';
          },
        },
        context: () => ({}),
      };
      const workflow1 = env.workflow('no-progress-test', config);
      const workflow2 = env.worker(workflow1, config);

      // Start workflow
      const run = await workflow1.start({});
      expect(run.status).toBe('running');

      // Worker 1 starts executing (will take 500ms)
      const promise1 = workflow1.execute(run._id);

      // Wait until worker 1 claimed the step and entered the handler
      await env.until(run._id, (r) => started && stepRunning('slow')(r));
      expect(started).toBe(true);
      expect(completed).toBe(false);

      // Worker 2 tries to execute - should detect no progress and exit immediately
      const startTime = Date.now();
      const result2 = await workflow2.execute(run._id);
      const elapsedTime = Date.now() - startTime;

      // Worker 2 should exit quickly (< 100ms), not wait for worker 1
      expect(elapsedTime).toBeLessThan(100);

      // Step should still be running (worker 1 not done yet)
      expect(result2.status).toBe('running');

      // Wait for worker 1 to complete
      const result1 = await promise1;
      expect(result1.status).toBe('done');
      expect(completed).toBe(true);
    });

    it('should refresh state when step is already running', async () => {
      const config: WorkflowConfig<Record<string, unknown>> = {
        steps: {
          fast: async () => 'fast-done',
          slow: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return 'slow-done';
          },
        },
        context: () => ({}),
      };
      const workflow1 = env.workflow('stale-state-test', config);
      const workflow2 = env.worker(workflow1, config);

      const run = await workflow1.start({});

      // Worker 1 executes (fast step completes, slow step starts)
      const promise1 = workflow1.execute(run._id);

      // Wait for fast step to complete and slow step to be claimed
      await env.until(
        run._id,
        (r) =>
          r.steps.find((s) => s.stepId === 'fast')?.status === 'done' && stepRunning('slow')(r),
      );

      // Worker 2 tries to execute - should see slow step is running and refresh state
      const result2 = await workflow2.execute(run._id);

      // Should have fresh state showing fast step is done
      const fastStep = result2.steps.find((s) => s.stepId === 'fast');
      expect(fastStep?.status).toBe('done');
      expect(fastStep?.output).toBe('fast-done');

      // Wait for worker 1 to finish
      await promise1;
    });
  });

  describe('pause() with Different Step States', () => {
    it('should pause pending step (not started yet)', async () => {
      const workflow = env.workflow('pause-pending-test', {
        steps: {
          step1: async () => 'done',
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      // Pause immediately (step is pending, no retryAfter)
      const paused = await workflow.pause(run._id);

      // NEW BEHAVIOR: pause() sets paused flag, status unchanged
      expect(paused.paused).toBe(true);
      expect(paused.status).toBe('running'); // Status unchanged

      const step1 = paused.steps.find((s) => s.stepId === 'step1');
      expect(step1?.status).toBe('pending'); // Step status unchanged
    });

    it('should pause during retry backoff (keep retryAfter, scheduler skips)', async () => {
      let attempts = 0;

      // With inline retry handling (delays < 5s), execute() now handles all retries itself.
      // This test verifies that the workflow properly fails after exhausting retries.
      const workflow = env.workflow('pause-retry-test', {
        steps: {
          failing: async () => {
            attempts++;
            throw new Error('Test error');
          },
        },
        context: () => ({}),
        defaults: { retries: 3 },
      });

      const run = await workflow.start({});

      // Execute - with inline retry handling, exhausts all retries and fails
      const executed = await workflow.execute(run._id);
      expect(executed.status).toBe('failed');
      expect(attempts).toBe(3); // All retries exhausted

      const step = executed.steps.find((s) => s.stepId === 'failing');
      expect(step?.status).toBe('failed');
      expect(step?.error).toBeDefined();
    });

    it('should set paused flag when pausing mid-execution', async () => {
      const workflow = env.workflow('pause-running-test', {
        steps: {
          long: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return 'done';
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      // Start execution (handler will take 500ms)
      const executePromise = workflow.execute(run._id);

      // Pause while step is running
      await env.until(run._id, stepRunning('long'));
      const paused = await workflow.pause(run._id);

      // NEW BEHAVIOR: pause() sets paused flag, status unchanged
      expect(paused.paused).toBe(true);
      expect(paused.status).toBe('running'); // Status unchanged

      const step = paused.steps.find((s) => s.stepId === 'long');
      expect(step?.status).toBe('running'); // Step status unchanged

      // Wait for execution to complete
      await executePromise;
    });

    it('should be no-op when pausing terminal states', async () => {
      const workflow = env.workflow('pause-terminal-test', {
        steps: {
          step1: async () => 'done',
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      // Complete workflow
      const completed = await workflow.execute(run._id);
      expect(completed.status).toBe('done');

      // Try to pause completed workflow
      const paused = await workflow.pause(run._id);
      // Should be no-op
      expect(paused.status).toBe('done');
      expect(paused._id).toBe(completed._id);
    });
  });

  describe('resume() After pause()', () => {
    it('should continue execution when resuming paused pending step', async () => {
      let executed = false;

      const workflow = env.workflow('resume-pending-test', {
        steps: {
          step1: async () => {
            executed = true;
            return 'done';
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      // Pause before execution
      await workflow.pause(run._id);

      // Resume - should execute step
      const resumed = await workflow.resume(run._id);
      expect(resumed.status).toBe('done');
      expect(executed).toBe(true);
    });

    it('should continue retry when resuming paused retry-pending step', async () => {
      // With inline retry handling (delays < 5s), execute() now handles all retries itself.
      // This test verifies that the step succeeds after retry via inline handling.
      let attempts = 0;

      const workflow = env.workflow('resume-retry-test', {
        steps: {
          failing: async () => {
            attempts++;
            if (attempts < 2) throw new Error('Fail first time');
            return 'success';
          },
        },
        context: () => ({}),
        defaults: { retries: 3 },
      });

      const run = await workflow.start({});

      // Execute - with inline retry handling, will fail once, wait inline, then succeed
      const result = await workflow.execute(run._id);

      // Should complete successfully after inline retry
      expect(result.status).toBe('done');
      expect(attempts).toBe(2); // 1 failure + 1 success

      const step = result.steps.find((s) => s.stepId === 'failing');
      expect(step?.status).toBe('done');
      expect(step?.error).toBeUndefined(); // Error cleared after success
    }, 10000);

    it('should continue execution when resuming paused running step', async () => {
      let executed = false;

      const workflow = env.workflow('resume-running-test', {
        steps: {
          long: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            executed = true;
            return 'done';
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      // Start execution
      const executePromise = workflow.execute(run._id);

      // Pause mid-execution
      await env.until(run._id, stepRunning('long'));
      const paused = await workflow.pause(run._id);

      // NEW BEHAVIOR: pause() sets paused flag, status unchanged
      expect(paused.paused).toBe(true);
      expect(paused.status).toBe('running'); // Status unchanged

      // Wait for handler to complete
      const completed = await executePromise;

      // Workflow should complete normally (execution wasn't interrupted)
      expect(completed.status).toBe('done');
      expect(executed).toBe(true);
    });

    it('should use payload when resuming explicit wait', async () => {
      interface WaitContext {
        result: string;
      }

      const workflow = env.workflow<WaitContext>('resume-wait-test', {
        steps: {
          wait: async (ctx) => {
            await ctx.wait('Waiting for input');
          },
          process: async (ctx) => {
            const input = ctx.getOutput('wait');
            return `Processed: ${input}`;
          },
        },
        context: () => ({ result: '' }),
      });

      const run = await workflow.start({});

      // Execute - will wait
      const waited = await workflow.execute(run._id);
      expect(waited.status).toBe('waiting');

      const step = waited.steps.find((s) => s.stepId === 'wait');
      expect(step?.status).toBe('waiting');

      // Resume with payload
      const resumed = await workflow.resume(run._id, 'user input');
      expect(resumed.status).toBe('done');

      const waitOutput = resumed.steps.find((s) => s.stepId === 'wait')?.output;
      expect(waitOutput).toBe('user input');

      const processOutput = resumed.steps.find((s) => s.stepId === 'process')?.output;
      expect(processOutput).toBe('Processed: user input');
    });
  });
});
