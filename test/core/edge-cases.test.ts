/**
 * Edge Cases and Real-World Scenarios
 *
 * Tests complex scenarios that banks and payment gateways encounter:
 * - API response validation with smart retries
 * - Conditional branching based on step outputs
 * - Timeout handling for external services
 * - Webhook integration patterns
 * - Data consistency under concurrent load
 * - Graceful degradation patterns
 */

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Edge Cases and Real-World Scenarios', () => {
  describe('API Response Validation with Smart Retries', () => {
    it('should retry on specific API error codes (transient failures)', async () => {
      let attempt = 0;
      const errorSequence = [503, 429, 200]; // Service unavailable -> Rate limited -> Success

      interface APIContext {
        orderId: string;
        statusCode?: number;
        response?: { paymentId: string; status: string };
      }

      const workflow = env.workflow<APIContext, { orderId: string }>('api-validation', {
        steps: {
          'call-payment-api': async (ctx) => {
            const statusCode = errorSequence[attempt++];

            await ctx.set('statusCode', statusCode);

            // Simulate transient failures
            if (statusCode === 503) {
              throw Object.assign(new Error('Service Unavailable'), {
                code: 'SERVICE_UNAVAILABLE',
                retriable: true,
              });
            }

            if (statusCode === 429) {
              throw Object.assign(new Error('Rate Limit Exceeded'), {
                code: 'RATE_LIMIT',
                retriable: true,
              });
            }

            // Success
            await ctx.set('response', {
              paymentId: 'PAY-123',
              status: 'completed',
            });

            return { statusCode, success: true };
          },

          validate: async (ctx) => {
            expect(ctx.context.statusCode).toBe(200);
            expect(ctx.context.response?.status).toBe('completed');
            return { validated: true };
          },
        },
        context: (input) => ({ orderId: input.orderId }),
        defaults: { retries: 3, timeout: 5000 },
      });

      // Configure fast scheduler for retries
      workflow.engine.configure({
        scheduler: {
          basePollInterval: 100,
          minPollInterval: 100,
          maxPollInterval: 100,
        },
      });

      const run = await workflow.start({ orderId: 'ORD-789' });
      await workflow.execute(run._id); // First attempt fails

      // Retries (exponential backoff: 1s + 2s) run until the workflow finishes
      await env.until(run._id, 'done', { timeout: 8000 });

      const result = await workflow.get(run._id);

      expect(result?.status).toBe('done');
      expect(result?.context.statusCode).toBe(200);
      expect(result?.context.response?.paymentId).toBe('PAY-123');
      expect(attempt).toBe(3); // Attempted 3 times
    }, 10000);

    it('should fail immediately on non-retriable errors (permanent failures)', async () => {
      const workflow = env.workflow('permanent-failure', {
        steps: {
          'check-balance': async () => {
            // Permanent error (insufficient funds) — don't retry
            throw Object.assign(new Error('Insufficient Funds'), {
              code: 'INSUFFICIENT_FUNDS',
              retriable: false,
            });
          },
        },
        context: () => ({}),
        defaults: { retries: 3 },
      });

      const run = await workflow.start({});

      // Manual execute for a deterministic test (env workflows never auto-execute)
      await workflow.execute(run._id);

      const result = await workflow.get(run._id);

      expect(result?.status).toBe('failed');
      expect(result?.steps[0]?.attempts).toBe(1); // Only 1 attempt (no retries)
      expect(result?.steps[0]?.error?.code).toBe('INSUFFICIENT_FUNDS');
    });
  });

  describe('Conditional Branching Based on Step Outputs', () => {
    it('should branch based on risk assessment score', async () => {
      interface RiskContext {
        transactionId: string;
        amount: number;
        riskScore?: number;
        requiresReview?: boolean;
        autoApproved?: boolean;
        reviewedBy?: string;
      }

      const workflow = env.workflow<RiskContext, { transactionId: string; amount: number }>(
        'risk-assessment',
        {
          steps: {
            'calculate-risk': async (ctx) => {
              // Simulate ML-based risk calculation
              const riskScore = ctx.context.amount > 10000 ? 75 : 25;
              await ctx.set('riskScore', riskScore);
              await ctx.set('requiresReview', riskScore > 50);
              return { riskScore };
            },

            'auto-decision': async (ctx) => {
              // Low risk = auto approve
              if (!ctx.context.requiresReview) {
                await ctx.set('autoApproved', true);
                return { approved: true, auto: true };
              }
              // High risk = set autoApproved to false explicitly
              await ctx.set('autoApproved', false);
              return { approved: false, needsReview: true };
            },

            'manual-review': async (ctx) => {
              // Skip if auto-approved
              if (ctx.context.autoApproved) {
                return { skipped: true };
              }

              // Wait for human review
              await ctx.wait('High-risk transaction requires review', {
                transactionId: ctx.context.transactionId,
                amount: ctx.context.amount,
                riskScore: ctx.context.riskScore,
              });
            },

            finalize: async (ctx) => {
              // Get review result from previous step's output (resume payload)
              const reviewResult = ctx.getOutput<{ reviewedBy?: string }>('manual-review');
              if (reviewResult?.reviewedBy) {
                await ctx.set('reviewedBy', reviewResult.reviewedBy);
              }
              return {
                final: true,
                approved: ctx.context.autoApproved || ctx.context.requiresReview,
              };
            },
          },
          context: (input) => ({
            transactionId: input.transactionId,
            amount: input.amount,
          }),
        },
      );

      // Test 1: Low risk - auto approve
      const lowRisk = await workflow.start({ transactionId: 'TXN-001', amount: 5000 });
      let result = await workflow.execute(lowRisk._id);
      expect(result.status).toBe('done');
      expect(result.context.riskScore).toBe(25);
      expect(result.context.autoApproved).toBe(true);
      expect(result.context.requiresReview).toBe(false);

      // Test 2: High risk - requires manual review
      const highRisk = await workflow.start({ transactionId: 'TXN-002', amount: 15000 });
      result = await workflow.execute(highRisk._id);

      expect(result.status).toBe('waiting');
      expect(result.context.riskScore).toBe(75);
      expect(result.context.requiresReview).toBe(true);
      expect(result.context.autoApproved).toBe(false);

      // Approve manually
      result = await workflow.resume(highRisk._id, { reviewedBy: 'risk-manager@bank.com' });

      expect(result.status).toBe('done');
      expect(result.context.reviewedBy).toBe('risk-manager@bank.com');
    });
  });

  describe('Timeout Handling for External Services', () => {
    it('should timeout slow external API calls', async () => {
      const workflow = env.workflow('timeout-test', {
        steps: {
          'slow-api': async () => {
            // Simulate slow API (takes 3 seconds)
            await delay(3000);
            return { slow: true };
          },
        },
        context: () => ({}),
        defaults: { timeout: 1000, retries: 0 },
      });

      const run = await workflow.start({});
      const result = await workflow.execute(run._id);

      expect(result.status).toBe('failed');
      expect(result.steps[0]?.error?.message).toContain('timeout');
    });

    it('should succeed if API responds within timeout', async () => {
      const workflow = env.workflow('fast-api-test', {
        steps: {
          'fast-api': async () => {
            await delay(500); // Responds in 500ms
            return { fast: true };
          },
        },
        context: () => ({}),
        defaults: { timeout: 2000 },
      });

      const run = await workflow.start({});
      const result = await workflow.execute(run._id);

      expect(result.status).toBe('done');
      expect(result.steps[0]?.status).toBe('done');
    });
  });

  describe('Webhook Integration Patterns', () => {
    it('should wait for external webhook and resume with payload', async () => {
      interface WebhookContext {
        orderId: string;
        paymentGatewayId?: string;
        webhookReceived?: boolean;
        paymentStatus?: string;
      }

      const workflow = env.workflow<WebhookContext, { orderId: string }>('webhook-integration', {
        steps: {
          'initiate-payment': async (ctx) => {
            const gatewayId = `GATEWAY_${Date.now()}`;
            await ctx.set('paymentGatewayId', gatewayId);

            // In real scenario, make API call to payment gateway here
            return { gatewayId };
          },

          'wait-webhook': async (ctx) => {
            // Wait for webhook from payment gateway
            await ctx.wait('Waiting for payment gateway webhook', {
              orderId: ctx.context.orderId,
              gatewayId: ctx.context.paymentGatewayId,
            });
          },

          'process-result': async (ctx) => {
            // Get webhook result from previous step's output (resume payload)
            const webhookResult = ctx.getOutput<{
              webhookReceived?: boolean;
              paymentStatus?: string;
            }>('wait-webhook');
            if (webhookResult?.webhookReceived) {
              await ctx.set('webhookReceived', webhookResult.webhookReceived);
            }
            if (webhookResult?.paymentStatus) {
              await ctx.set('paymentStatus', webhookResult.paymentStatus);
            }
            expect(ctx.context.webhookReceived).toBe(true);
            expect(ctx.context.paymentStatus).toBe('success');
            return { processed: true };
          },
        },
        context: (input) => ({ orderId: input.orderId }),
      });

      const run = await workflow.start({ orderId: 'ORD-456' });
      let result = await workflow.execute(run._id);

      // Should be waiting for webhook
      expect(result.status).toBe('waiting');
      expect(result.currentStepId).toBe('wait-webhook');

      // Simulate webhook received from payment gateway
      result = await workflow.resume(run._id, {
        webhookReceived: true,
        paymentStatus: 'success',
        timestamp: new Date(),
      });

      expect(result.status).toBe('done');
      expect(result.context.webhookReceived).toBe(true);
      expect(result.context.paymentStatus).toBe('success');
    });
  });

  describe('Data Consistency Under Concurrent Load', () => {
    it('should maintain data consistency with 50 concurrent workflows', async () => {
      interface CounterContext {
        id: number;
        value: number;
      }

      const workflow = env.workflow<CounterContext, { id: number }>('concurrent-consistency', {
        steps: {
          increment: async (ctx) => {
            await delay(10); // Simulate async operation
            await ctx.set('value', ctx.context.value + 1);
            return { incremented: true };
          },

          double: async (ctx) => {
            await delay(10);
            await ctx.set('value', ctx.context.value * 2);
            return { doubled: true };
          },

          verify: async (ctx) => {
            // (0 + 1) * 2 = 2
            expect(ctx.context.value).toBe(2);
            return { verified: true };
          },
        },
        context: (input) => ({ id: input.id, value: 0 }),
      });

      // Start and execute 50 workflows concurrently
      const runs = await Promise.all(
        Array.from({ length: 50 }, (_, i) => workflow.start({ id: i + 1 })),
      );

      // Execute all workflows concurrently
      await Promise.all(runs.map((run) => workflow.execute(run._id)));

      // Verify all completed correctly
      for (const run of runs) {
        const result = await workflow.get(run._id);
        expect(result?.status).toBe('done');
        expect(result?.context.value).toBe(2);
      }
    });
  });

  describe('Graceful Degradation Patterns', () => {
    it('should fallback to cached data if external service fails', async () => {
      interface FallbackContext {
        userId: string;
        userData?: { id: string; name: string; fromCache: boolean };
        usedCache?: boolean;
      }

      let attempts = 0;

      const workflow = env.workflow<FallbackContext, { userId: string }>('fallback-pattern', {
        steps: {
          'fetch-user': async (ctx) => {
            attempts++;

            // Simulate external service failure
            if (attempts <= 2) {
              throw new Error('External service unavailable');
            }

            // After retries, use cached data (graceful degradation)
            await ctx.set('userData', {
              id: ctx.context.userId,
              name: 'Cached User',
              fromCache: true,
            });
            await ctx.set('usedCache', true);

            return { cached: true };
          },

          process: async (ctx) => {
            expect(ctx.context.userData).toBeDefined();
            expect(ctx.context.usedCache).toBe(true);
            return { processed: true };
          },
        },
        context: (input) => ({ userId: input.userId }),
        defaults: { retries: 3 },
      });

      // Configure fast scheduler for retries
      workflow.engine.configure({
        scheduler: {
          basePollInterval: 100,
          minPollInterval: 100,
          maxPollInterval: 100,
        },
      });

      const run = await workflow.start({ userId: 'user-123' });
      await workflow.execute(run._id); // First attempt fails

      // Retries (exponential backoff: 1s + 2s) run until the workflow finishes
      await env.until(run._id, 'done', { timeout: 8000 });

      const result = await workflow.get(run._id);

      expect(result?.status).toBe('done');
      expect(result?.context.usedCache).toBe(true);
      expect(result?.context.userData?.fromCache).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(3);
    }, 10000);
  });

  describe('Complex Payment Gateway Flow', () => {
    it('should handle complete payment flow with 3D Secure authentication', async () => {
      interface PaymentContext {
        orderId: string;
        amount: number;
        currency: string;
        requires3DS?: boolean;
        authenticationUrl?: string;
        authenticated?: boolean;
        paymentId?: string;
        status?: 'pending' | 'authenticating' | 'processing' | 'completed' | 'failed';
      }

      const workflow = env.workflow<
        PaymentContext,
        { orderId: string; amount: number; currency: string }
      >('3ds-payment-flow', {
        steps: {
          initiate: async (ctx) => {
            const paymentId = `PAY_${Date.now()}`;
            await ctx.set('paymentId', paymentId);
            await ctx.set('status', 'pending' as const);
            return { paymentId };
          },

          'check-3ds': async (ctx) => {
            // Amounts > 1000 require 3DS
            const requires3DS = ctx.context.amount > 1000;
            await ctx.set('requires3DS', requires3DS);

            if (requires3DS) {
              await ctx.set(
                'authenticationUrl',
                `https://3ds.example.com/auth/${ctx.context.paymentId}`,
              );
              await ctx.set('status', 'authenticating' as const);
            }

            return { requires3DS };
          },

          authenticate: async (ctx) => {
            if (!ctx.context.requires3DS) {
              return { skipped: true };
            }

            // Wait for customer to complete 3DS challenge
            await ctx.wait('3DS authentication required', {
              paymentId: ctx.context.paymentId,
              authenticationUrl: ctx.context.authenticationUrl,
            });

            // After resume, verify authentication
            expect(ctx.context.authenticated).toBe(true);
            return { authenticated: true };
          },

          process: async (ctx) => {
            // Get authentication result from previous step's output (resume payload)
            const authResult = ctx.getOutput<{ authenticated?: boolean }>('authenticate');
            if (authResult?.authenticated) {
              await ctx.set('authenticated', true);
            }

            await ctx.set('status', 'processing' as const);

            // Simulate payment processing
            await delay(100);

            await ctx.set('status', 'completed' as const);
            return { processed: true };
          },

          confirm: async (ctx) => {
            expect(ctx.context.status).toBe('completed');
            return { confirmed: true };
          },
        },
        context: (input) => ({
          orderId: input.orderId,
          amount: input.amount,
          currency: input.currency,
          status: 'pending' as const,
        }),
        defaults: { timeout: 10000 },
      });

      // Test high-value payment requiring 3DS
      const run = await workflow.start({
        orderId: 'ORD-999',
        amount: 5000,
        currency: 'USD',
      });

      let result = await workflow.execute(run._id);

      // Should be waiting for 3DS authentication
      expect(result.status).toBe('waiting');
      expect(result.context.requires3DS).toBe(true);
      expect(result.context.authenticationUrl).toBeDefined();
      expect(result.context.status).toBe('authenticating');

      // Customer completes 3DS authentication
      result = await workflow.resume(run._id, {
        authenticated: true,
        authenticationTime: new Date(),
      });

      expect(result.status).toBe('done');
      expect(result.context.authenticated).toBe(true);
      expect(result.context.status).toBe('completed');
    });
  });
});
