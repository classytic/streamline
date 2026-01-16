/**
 * Core Engine Tests
 *
 * Tests fundamental workflow execution:
 * - Basic workflow lifecycle (start → execute → complete)
 * - Wait/resume functionality
 * - Error handling and retries
 * - State persistence
 *
 * Uses in-memory MongoDB for isolation and speed
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { setupTestDB, cleanupTestDB, teardownTestDB, waitFor } from '../utils/setup.js';

describe('Core Engine Tests', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterEach(async () => {
    await cleanupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  describe('Basic Workflow Execution', () => {
    it('should execute simple 2-step workflow', async () => {
      const workflow = createWorkflow<{ counter: number }>('simple-test', {
        steps: {
          increment: async (ctx) => {
            await ctx.set('counter', ctx.context.counter + 1);
            return { incremented: true };
          },
          multiply: async (ctx) => {
            await ctx.set('counter', ctx.context.counter * 2);
            return { multiplied: true };
          },
        },
        context: () => ({ counter: 0 }),
      });

      const run = await workflow.start({});

      // Wait for execution
      await waitFor(100);
      const result = await workflow.get(run._id);

      // Verify
      expect(result?.status).toBe('done');
      expect(result?.context.counter).toBe(2); // (0 + 1) * 2 = 2
      expect(result?.steps).toHaveLength(2);
      expect(result?.steps[0]?.status).toBe('done');
      expect(result?.steps[1]?.status).toBe('done');

      workflow.shutdown();
    });

    it('should handle workflow with retries', async () => {
      let attempts = 0;

      const workflow = createWorkflow<{ result?: string }>('retry-test', {
        steps: {
          flaky: async (ctx) => {
            attempts++;
            console.log(`Attempt ${attempts}, context:`, ctx.context);
            if (attempts < 3) {
              throw new Error('Temporary failure');
            }
            console.log(`Setting result, ctx.context is:`, ctx.context);
            if (!ctx.context) {
              console.error('ctx.context is undefined!');
              throw new Error('Context is undefined');
            }
            await ctx.set('result', 'success');
            return { attempts };
          },
        },
        context: () => ({ result: undefined }),
        defaults: { retries: 4 }, // Allow enough retries for 3 attempts
        autoExecute: false,
      });

      const run = await workflow.start({});

      // With inline retry handling (delays < 5s), execute() will handle all retries:
      // Attempt 1: fails, wait 1s inline
      // Attempt 2: fails, wait 2s inline
      // Attempt 3: succeeds
      const result = await workflow.execute(run._id);

      console.log('Result status:', result.status);
      console.log('Attempts:', attempts);
      console.log('Step state:', result.steps[0]);

      expect(result.status).toBe('done');
      expect(result.context.result).toBe('success');
      expect(attempts).toBe(3);

      workflow.shutdown();
    }, 10000);

    it('should fail after max retries', async () => {
      const workflow = createWorkflow('fail-test', {
        steps: {
          'always-fail': async () => {
            throw new Error('Permanent failure');
          },
        },
        context: () => ({}),
        defaults: { retries: 2 },
        autoExecute: false,
      });

      // Configure fast scheduler for retries
      workflow.engine.configure({
        scheduler: {
          basePollInterval: 100,
          minPollInterval: 100,
          maxPollInterval: 100,
        },
      });

      const run = await workflow.start({});
      await workflow.execute(run._id); // First attempt fails

      // With exponential backoff (1s base) and retries: 2:
      // Attempt 1: fails, wait 1s
      // Attempt 2: fails, wait 2s
      // Attempt 3: fails (exhausted retries)
      await waitFor(5000);
      const result = await workflow.get(run._id);

      expect(result?.status).toBe('failed');
      expect(result?.steps[0]?.status).toBe('failed');
      expect(result?.steps[0]?.error?.message).toBe('Permanent failure');
      expect(result?.steps[0]?.attempts).toBeGreaterThan(1);

      workflow.shutdown();
    }, 10000);
  });

  describe('Wait and Resume', () => {
    it('should pause at wait signal and resume with payload', async () => {
      const workflow = createWorkflow<{ approved?: boolean; approver?: string }>('wait-test', {
        steps: {
          submit: async () => {
            return { submitted: true };
          },
          wait: async (ctx) => {
            await ctx.wait('Waiting for approval', { requestId: 'REQ-123' });
          },
          process: async (ctx) => {
            // Resume payload is available via getOutput of the wait step
            const approval = ctx.getOutput('wait') as { approved: boolean; approver: string };
            expect(approval?.approved).toBe(true);
            expect(approval?.approver).toBe('Alice');
            // Store in context for later verification
            await ctx.set('approved', approval?.approved);
            await ctx.set('approver', approval?.approver);
            return { processed: true };
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      // Wait for execution to pause
      await waitFor(100);
      let current = await workflow.get(run._id);

      expect(current?.status).toBe('waiting');
      expect(current?.currentStepId).toBe('wait');
      expect(current?.steps[1]?.waitingFor?.type).toBe('human');

      // Resume with approval
      await workflow.resume(run._id, { approved: true, approver: 'Alice' });

      await waitFor(100);
      current = await workflow.get(run._id);

      expect(current?.status).toBe('done');
      expect(current?.context.approved).toBe(true);
      expect(current?.context.approver).toBe('Alice');

      workflow.shutdown();
    });

    it('should handle sleep correctly', async () => {
      const workflow = createWorkflow<{ startTime?: number; endTime?: number }>('sleep-test', {
        steps: {
          start: async (ctx) => {
            await ctx.set('startTime', Date.now());
            return { started: true };
          },
          sleep: async (ctx) => {
            await ctx.sleep(500); // Sleep 500ms (inline execution for short delays)
          },
          end: async (ctx) => {
            await ctx.set('endTime', Date.now());
            return { ended: true };
          },
        },
        context: () => ({}),
        autoExecute: false,
      });

      const run = await workflow.start({});

      // Execute - with inline sleep handling for short delays (<= 5s),
      // this should complete synchronously after ~500ms
      const result = await workflow.execute(run._id);

      expect(result.status).toBe('done');
      expect(result.context.endTime).toBeDefined();

      let current = await workflow.get(run._id);

      expect(current?.status).toBe('done');
      expect(current?.context.endTime).toBeDefined();

      const duration = current!.context.endTime! - current!.context.startTime!;
      expect(duration).toBeGreaterThanOrEqual(500);
      expect(duration).toBeLessThan(800);

      workflow.shutdown();
    });
  });

  describe('State Persistence', () => {
    it('should persist context updates immediately', async () => {
      const workflow = createWorkflow<{ step1?: string; step2?: string }>('persist-test', {
        steps: {
          step1: async (ctx) => {
            await ctx.set('step1', 'completed');
            return { done: true };
          },
          step2: async (ctx) => {
            await ctx.set('step2', 'completed');
            return { done: true };
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});

      await waitFor(100);

      // Create new workflow instance to verify persistence
      const workflow2 = createWorkflow<{ step1?: string; step2?: string }>('persist-test', {
        steps: {
          step1: async (ctx) => {
            await ctx.set('step1', 'completed');
            return { done: true };
          },
          step2: async (ctx) => {
            await ctx.set('step2', 'completed');
            return { done: true };
          },
        },
        context: () => ({}),
      });
      const persisted = await workflow2.get(run._id);

      expect(persisted?.status).toBe('done');
      expect(persisted?.context.step1).toBe('completed');
      expect(persisted?.context.step2).toBe('completed');

      workflow.shutdown();
      workflow2.shutdown();
    });
  });

  describe('Concurrent Workflows', () => {
    it('should handle multiple workflows concurrently', async () => {
      const workflow = createWorkflow<{ id: string; processed?: boolean }, { id: string }>('concurrent-test', {
        steps: {
          process: async (ctx) => {
            await waitFor(50);
            await ctx.set('processed', true);
            return { id: ctx.context.id };
          },
        },
        context: (input) => ({ id: input.id }),
      });

      // Start 5 workflows concurrently
      const runs = await Promise.all([
        workflow.start({ id: 'wf-1' }),
        workflow.start({ id: 'wf-2' }),
        workflow.start({ id: 'wf-3' }),
        workflow.start({ id: 'wf-4' }),
        workflow.start({ id: 'wf-5' }),
      ]);

      // Wait for all to complete
      await waitFor(200);

      // Verify all completed
      for (const run of runs) {
        const result = await workflow.get(run._id);
        expect(result?.status).toBe('done');
        expect(result?.context.processed).toBe(true);
      }

      workflow.shutdown();
    });
  });
});
