/**
 * Core Engine Tests
 *
 * Tests fundamental workflow execution:
 * - Basic workflow lifecycle (start → execute → complete)
 * - Wait/resume functionality
 * - Error handling and retries
 * - State persistence
 */

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

type PersistCtx = { step1?: string; step2?: string };

describe('Core Engine Tests', () => {
  describe('Basic Workflow Execution', () => {
    it('should execute simple 2-step workflow', async () => {
      const workflow = env.workflow<{ counter: number }>('simple-test', {
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
        autoExecute: true,
      });

      const run = await workflow.start({});

      // start() auto-executes; wait for the run to finish
      await env.until(run._id, 'done');
      const result = await workflow.get(run._id);

      // Verify
      expect(result?.status).toBe('done');
      expect(result?.context.counter).toBe(2); // (0 + 1) * 2 = 2
      expect(result?.steps).toHaveLength(2);
      expect(result?.steps[0]?.status).toBe('done');
      expect(result?.steps[1]?.status).toBe('done');
    });

    it('should handle workflow with retries', async () => {
      let attempts = 0;

      const workflow = env.workflow<{ result?: string }>('retry-test', {
        steps: {
          flaky: async (ctx) => {
            attempts++;
            if (attempts < 3) {
              throw new Error('Temporary failure');
            }
            if (!ctx.context) {
              throw new Error('Context is undefined');
            }
            await ctx.set('result', 'success');
            return { attempts };
          },
        },
        context: () => ({}),
        defaults: { retries: 4 }, // Allow enough retries for 3 attempts
      });

      const run = await workflow.start({});

      // With inline retry handling (delays < 5s), execute() will handle all retries:
      // Attempt 1: fails, wait 1s inline
      // Attempt 2: fails, wait 2s inline
      // Attempt 3: succeeds
      const result = await workflow.execute(run._id);

      expect(result.status).toBe('done');
      expect(result.context.result).toBe('success');
      expect(attempts).toBe(3);
    }, 10000);

    it('should fail after max retries', async () => {
      const workflow = env.workflow('fail-test', {
        steps: {
          'always-fail': async () => {
            throw new Error('Permanent failure');
          },
        },
        context: () => ({}),
        defaults: { retries: 2 },
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
      await env.until(run._id, 'failed', { timeout: 8000 });
      const result = await workflow.get(run._id);

      expect(result?.status).toBe('failed');
      expect(result?.steps[0]?.status).toBe('failed');
      expect(result?.steps[0]?.error?.message).toBe('Permanent failure');
      expect(result?.steps[0]?.attempts).toBeGreaterThan(1);
    }, 10000);
  });

  describe('Wait and Resume', () => {
    it('should pause at wait signal and resume with payload', async () => {
      const workflow = env.workflow<{ approved?: boolean; approver?: string }>('wait-test', {
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
        autoExecute: true,
      });

      const run = await workflow.start({});

      // Wait for execution to pause
      await env.until(run._id, 'waiting');
      let current = await workflow.get(run._id);

      expect(current?.status).toBe('waiting');
      expect(current?.currentStepId).toBe('wait');
      expect(current?.steps[1]?.waitingFor?.type).toBe('human');

      // Resume with approval
      await workflow.resume(run._id, { approved: true, approver: 'Alice' });

      await env.until(run._id, 'done');
      current = await workflow.get(run._id);

      expect(current?.status).toBe('done');
      expect(current?.context.approved).toBe(true);
      expect(current?.context.approver).toBe('Alice');
    });

    it('should handle sleep correctly', async () => {
      const workflow = env.workflow<{ startTime?: number; endTime?: number }>('sleep-test', {
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
      });

      const run = await workflow.start({});

      // Execute - with inline sleep handling for short delays (<= 5s),
      // this should complete synchronously after ~500ms
      const result = await workflow.execute(run._id);

      expect(result.status).toBe('done');
      expect(result.context.endTime).toBeDefined();

      const current = await workflow.get(run._id);

      expect(current?.status).toBe('done');
      expect(current?.context.endTime).toBeDefined();

      const { startTime, endTime } = current?.context ?? {};
      expect(startTime).toBeDefined();
      const duration = (endTime ?? 0) - (startTime ?? 0);
      expect(duration).toBeGreaterThanOrEqual(500);
      expect(duration).toBeLessThan(800);
    });
  });

  describe('State Persistence', () => {
    it('should persist context updates immediately', async () => {
      const steps: WorkflowConfig<PersistCtx>['steps'] = {
        step1: async (ctx) => {
          await ctx.set('step1', 'completed');
          return { done: true };
        },
        step2: async (ctx) => {
          await ctx.set('step2', 'completed');
          return { done: true };
        },
      };
      const workflow = env.workflow<PersistCtx>('persist-test', {
        steps,
        context: () => ({}),
        autoExecute: true,
      });

      const run = await workflow.start({});

      await env.until(run._id, 'done');

      // A new workflow instance with its OWN container (fresh cache) on the
      // same connection — reads must come from the database, not memory.
      const workflow2 = env.worker<PersistCtx>(workflow, { steps, context: () => ({}) });
      const persisted = await workflow2.get(run._id);

      expect(persisted?.status).toBe('done');
      expect(persisted?.context.step1).toBe('completed');
      expect(persisted?.context.step2).toBe('completed');
    });
  });

  describe('Concurrent Workflows', () => {
    it('should handle multiple workflows concurrently', async () => {
      const workflow = env.workflow<{ id: string; processed?: boolean }, { id: string }>(
        'concurrent-test',
        {
          steps: {
            process: async (ctx) => {
              await delay(50);
              await ctx.set('processed', true);
              return { id: ctx.context.id };
            },
          },
          context: (input) => ({ id: input.id }),
          autoExecute: true,
        },
      );

      // Start 5 workflows concurrently
      const runs = await Promise.all([
        workflow.start({ id: 'wf-1' }),
        workflow.start({ id: 'wf-2' }),
        workflow.start({ id: 'wf-3' }),
        workflow.start({ id: 'wf-4' }),
        workflow.start({ id: 'wf-5' }),
      ]);

      // Wait for all to complete, then verify each
      for (const run of runs) {
        await env.until(run._id, 'done');
        const result = await workflow.get(run._id);
        expect(result?.status).toBe('done');
        expect(result?.context.processed).toBe(true);
      }
    });
  });
});
