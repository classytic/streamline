/**
 * Scheduler Core Tests
 *
 * Tests the SmartScheduler functionality:
 * - Timer-based workflow resumption
 * - Lazy start/stop behavior
 * - Adaptive polling
 * - Race condition handling (atomic resume)
 * - Long delay support (> 24.8 days)
 *
 * Note: The engine handles short delays (<= 5 seconds) inline via setTimeout.
 * Longer delays use the scheduler for MongoDB-based polling.
 * Tests that observe 'waiting' status need longer delays or human-approval waits.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Scheduler Core Tests', () => {
  describe('Timer-Based Resumption', () => {
    it('should complete workflow with short sleep (inline execution)', async () => {
      // Short delays (<= 5s) are handled inline by the engine
      // This tests the inline sleep mechanism
      const workflow = env.workflow<{ timestamp?: number }>('short-sleep', {
        steps: {
          before: async (ctx) => {
            await ctx.set('timestamp', Date.now());
            return { ready: true };
          },
          sleep: async (ctx) => {
            await ctx.sleep(100); // 100ms - handled inline
          },
          after: async () => {
            return { resumed: true };
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});
      const result = await workflow.execute(run._id);

      // With inline execution, workflow completes directly
      expect(result.status).toBe('done');
      expect(result.steps[2]?.status).toBe('done');
      expect(result.steps[2]?.output).toEqual({ resumed: true });
    });

    it('should handle multiple concurrent sleeps (inline execution)', async () => {
      // Note: ctx.sleep() throws WaitSignal, so code after it in same step doesn't run
      // Put post-sleep logic in a separate step
      const workflow = env.workflow<{ id: string; sleptAt?: number }, { id: string }>(
        'multi-sleep',
        {
          steps: {
            sleep: async (ctx) => {
              await ctx.sleep(100); // Short delay - inline
            },
            complete: async (ctx) => {
              await ctx.set('sleptAt', Date.now());
              return { done: true };
            },
          },
          context: (input) => ({ id: input.id }),
        },
      );

      // Start 3 workflows
      const runs = await Promise.all([
        workflow.start({ id: 'wf-1' }),
        workflow.start({ id: 'wf-2' }),
        workflow.start({ id: 'wf-3' }),
      ]);

      // Execute all - with inline sleeps, they complete directly
      for (const run of runs) {
        const result = await workflow.execute(run._id);
        expect(result.status).toBe('done');
        expect(result.context.sleptAt).toBeDefined();
      }
    });
  });

  describe('Lazy Scheduler Behavior', () => {
    it('should NOT start polling when no workflows exist', async () => {
      const workflow = env.workflow('lazy-test', {
        steps: {
          noop: async () => ({ done: true }),
        },
        context: () => ({}),
      });

      // Give the scheduler a window in which it must NOT start (asserts absence)
      await delay(100);

      // Check scheduler stats
      const stats = workflow.engine.getSchedulerStats();
      expect(stats.isPolling).toBe(false);
      expect(stats.totalPolls).toBe(0);
    });

    it('should start polling when workflow with long sleep is created', async () => {
      const workflow = env.workflow('polling-start-test', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // 1 minute - goes through scheduler
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});
      await workflow.execute(run._id); // Execute to reach waiting state

      // Verify workflow is waiting (long delay bypasses inline execution)
      const current = await workflow.get(run._id);
      expect(current?.status).toBe('waiting');

      // Scheduler should now be polling (1s: vi.waitFor's default budget)
      await env.eventually(() => expect(workflow.engine.getSchedulerStats().isPolling).toBe(true), {
        timeout: 1000,
      });
    });
  });

  describe('Atomic Resume (Race Condition Prevention)', () => {
    it('should prevent duplicate resume when multiple engines try to resume same workflow', async () => {
      let resumeCount = 0;

      const steps: WorkflowConfig<Record<string, unknown>>['steps'] = {
        wait: async (ctx) => {
          await ctx.wait('waiting for resume', {});
        },
        count: async () => {
          resumeCount++;
          return { counted: true };
        },
      };

      const workflow1 = env.workflow('race-test', { steps, context: () => ({}) });

      // Two more engines for the SAME workflow id, each with its own container
      // (own cache + bus) on the env's connection — separate "processes".
      const workflow2 = env.worker(workflow1, { steps, context: () => ({}) });
      const workflow3 = env.worker(workflow1, { steps, context: () => ({}) });

      // Start workflow with workflow1
      const run = await workflow1.start({});
      await workflow1.execute(run._id); // Execute to reach waiting state

      // Verify it's waiting
      const waiting = await workflow1.get(run._id);
      expect(waiting?.status).toBe('waiting');

      // All 3 engines try to resume simultaneously
      await Promise.allSettled([
        workflow1.resume(run._id),
        workflow2.resume(run._id),
        workflow3.resume(run._id),
      ]);

      // Wait for execution to complete
      await env.until(run._id, 'done');

      // Only ONE should have actually resumed (atomic claim)
      // The count handler should execute exactly once
      expect(resumeCount).toBe(1);
    });
  });

  describe('Long Delay Support', () => {
    it('should handle delays exceeding setTimeout limit (24.8 days)', async () => {
      const workflow = env.workflow<{ longSleep?: boolean }>('long-delay-test', {
        steps: {
          'long-sleep': async (ctx) => {
            // 30 days in milliseconds
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            await ctx.sleep(thirtyDays);
            await ctx.set('longSleep', true);
          },
        },
        context: () => ({}),
      });

      // 30 days in milliseconds
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;

      const run = await workflow.start({});
      await workflow.execute(run._id); // Execute to reach waiting state

      // Should be in waiting state (long delay bypasses inline)
      const current = await workflow.get(run._id);
      expect(current?.status).toBe('waiting');
      expect(current?.steps[0]?.waitingFor?.type).toBe('timer');

      // Verify resumeAt is ~30 days in the future
      const resumeAt = current?.steps[0]?.waitingFor?.resumeAt;
      expect(resumeAt).toBeDefined();

      const expectedResumeTime = Date.now() + thirtyDays;
      const actualResumeTime = new Date(resumeAt ?? 0).getTime();
      const diff = Math.abs(actualResumeTime - expectedResumeTime);

      // Should be within 1 second of expected time
      expect(diff).toBeLessThan(1000);
    });
  });

  describe('Scheduler Health and Metrics', () => {
    it('should track scheduler metrics correctly', async () => {
      // Use long sleep (> 5s) to trigger scheduler polling
      const workflow = env.workflow('metrics-test', {
        steps: {
          sleep: async (ctx) => {
            await ctx.sleep(60000); // 1 minute - goes through scheduler
          },
        },
        context: () => ({}),
      });

      const run = await workflow.start({});
      await workflow.execute(run._id); // Execute to reach waiting state

      // Verify waiting state
      const current = await workflow.get(run._id);
      expect(current?.status).toBe('waiting');

      // Wait for scheduler to start (1s: vi.waitFor's default budget)
      await env.eventually(() => expect(workflow.engine.getSchedulerStats().isPolling).toBe(true), {
        timeout: 1000,
      });

      const stats = workflow.engine.getSchedulerStats();

      // Verify scheduler is active
      expect(stats.isPolling).toBe(true);
      expect(stats.pollInterval).toBeGreaterThan(0);

      workflow.shutdown();

      // After shutdown, should not be polling
      const finalStats = workflow.engine.getSchedulerStats();
      expect(finalStats.isPolling).toBe(false);
    });
  });

  describe('Payment Gateway Scenario', () => {
    it('should handle payment verification workflow with short timeout', async () => {
      interface PaymentContext {
        orderId: string;
        amount: number;
        paymentId?: string;
        verified?: boolean;
        status?: 'pending' | 'completed' | 'failed';
      }

      // Note: ctx.sleep() throws WaitSignal, so post-sleep logic must be in next step
      const workflow = env.workflow<PaymentContext, { orderId: string; amount: number }>(
        'payment-verification',
        {
          steps: {
            initiate: async (ctx) => {
              const paymentId = `PAY_${Date.now()}`;
              await ctx.set('paymentId', paymentId);
              return { paymentId };
            },
            'wait-verification': async (ctx) => {
              // Short sleep - handled inline
              await ctx.sleep(100);
            },
            'mark-verified': async (ctx) => {
              await ctx.set('verified', true);
            },
            complete: async (ctx) => {
              expect(ctx.context.verified).toBe(true);
              await ctx.set('status', 'completed' as const);
              return { completed: true };
            },
          },
          context: (input) => ({
            orderId: input.orderId,
            amount: input.amount,
            status: 'pending' as const,
          }),
          defaults: { timeout: 5000 },
        },
      );

      const run = await workflow.start({ orderId: 'ORD-123', amount: 10000 });

      // Execute - short sleep is handled inline, workflow completes
      const result = await workflow.execute(run._id);
      expect(result.status).toBe('done');
      expect(result.context.paymentId).toBeDefined();
      expect(result.context.verified).toBe(true);
      expect(result.context.status).toBe('completed');
    });
  });

  describe('Loan Approval Scenario', () => {
    it('should handle multi-step loan approval with human review', async () => {
      interface LoanContext {
        applicationId: string;
        amount: number;
        creditScore?: number;
        autoApproved?: boolean;
        manualReview?: boolean;
        approved?: boolean;
        reviewedBy?: string;
      }

      const workflow = env.workflow<LoanContext, { applicationId: string; amount: number }>(
        'loan-approval',
        {
          steps: {
            'credit-check': async (ctx) => {
              // Simulate credit check
              const creditScore = 720;
              await ctx.set('creditScore', creditScore);
              return { creditScore };
            },
            'auto-decision': async (ctx) => {
              // Auto-approve if credit score > 750 and amount < 50000
              const autoApprove =
                (ctx.context.creditScore ?? 0) >= 750 && ctx.context.amount < 50000;
              await ctx.set('autoApproved', autoApprove);

              if (!autoApprove) {
                await ctx.set('manualReview', true);
              }

              return { autoApproved: autoApprove };
            },
            'manual-review': async (ctx) => {
              // Skip if auto-approved
              if (ctx.context.autoApproved) {
                return { skipped: true };
              }

              // Wait for human review - payload goes to step output
              await ctx.wait('Loan requires manual review', {
                applicationId: ctx.context.applicationId,
                amount: ctx.context.amount,
                creditScore: ctx.context.creditScore,
              });
            },
            finalize: async (ctx) => {
              // Get approval decision from manual-review step output (resume payload)
              const reviewResult = ctx.getOutput<{ approved?: boolean; reviewedBy?: string }>(
                'manual-review',
              );
              if (reviewResult?.approved) {
                await ctx.set('approved', true);
                if (reviewResult.reviewedBy !== undefined) {
                  await ctx.set('reviewedBy', reviewResult.reviewedBy);
                }
              }
              return {
                approved: ctx.context.autoApproved || ctx.context.approved,
                final: true,
              };
            },
          },
          context: (input) => ({
            applicationId: input.applicationId,
            amount: input.amount,
          }),
        },
      );

      // Test case: Low credit score, requires manual review
      const run = await workflow.start({ applicationId: 'LOAN-456', amount: 30000 });

      // Execute - will pause at manual-review wait
      const afterExec = await workflow.execute(run._id);
      expect(afterExec.status).toBe('waiting');
      expect(afterExec.currentStepId).toBe('manual-review');
      expect(afterExec.context.creditScore).toBe(720);
      expect(afterExec.context.autoApproved).toBe(false);

      // Manager approves the loan - payload goes to step output
      await workflow.resume(run._id, {
        approved: true,
        reviewedBy: 'manager@bank.com',
      });

      await env.until(run._id, 'done');

      const current = await workflow.get(run._id);
      expect(current?.status).toBe('done');
      expect(current?.context.approved).toBe(true);
      expect(current?.context.reviewedBy).toBe('manager@bank.com');
    });
  });
});
