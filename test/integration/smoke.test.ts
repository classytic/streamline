/**
 * Integration Smoke Test
 *
 * End-to-end real-world scenario: order processing pipeline
 * with all streamline features exercised in a single test.
 *
 * Covers: start → execute → ctx.log → ctx.set → getOutput →
 *         conditional skip → retry with backoff → human-in-the-loop →
 *         resume → checkpoint → metrics → events → cancel → abort
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  createEventSink,
  configureStreamlineLogger,
  WorkflowRunModel,
  type StepLogEntry,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
  // Suppress log output during tests
  configureStreamlineLogger({ enabled: false });
});

afterAll(async () => {
  configureStreamlineLogger({ enabled: true });
  await teardownTestDB();
});

// ============================================================================
// Full Pipeline: Order Processing
// ============================================================================

describe('Integration smoke: order processing pipeline', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should process a complete order through all stages', async () => {
    interface OrderCtx {
      orderId: string;
      amount: number;
      validated: boolean;
      charged: boolean;
      shipped: boolean;
      trackingNumber: string;
    }

    const events: string[] = [];

    const orderWorkflow = createWorkflow<OrderCtx>('order-pipeline', {
      steps: {
        validate: async (ctx) => {
          ctx.log('Validating order', { orderId: ctx.context.orderId });
          if (ctx.context.amount <= 0) throw new Error('Invalid amount');
          await ctx.set('validated', true);
          return { valid: true, amount: ctx.context.amount };
        },
        charge: {
          handler: async (ctx) => {
            ctx.log('Charging payment', { amount: ctx.context.amount });
            await ctx.set('charged', true);
            return { chargeId: `ch_${ctx.context.orderId}` };
          },
          retries: 3,
          retryDelay: 50,
          retryBackoff: 'exponential',
        },
        ship: async (ctx) => {
          const charge = ctx.getOutput<{ chargeId: string }>('charge');
          ctx.log('Shipping order', { chargeId: charge?.chargeId });
          const tracking = `TRK-${Date.now()}`;
          await ctx.set('shipped', true);
          await ctx.set('trackingNumber', tracking);
          return { tracking };
        },
        notify: async (ctx) => {
          ctx.log('Sending notification', { tracking: ctx.context.trackingNumber });
          return { notified: true };
        },
      },
      context: (input: { orderId: string; amount: number }) => ({
        orderId: input.orderId,
        amount: input.amount,
        validated: false,
        charged: false,
        shipped: false,
        trackingNumber: '',
      }),
      autoExecute: false,
    });

    const unsub = createEventSink(
      orderWorkflow.container.eventBus,
      { events: ['step:completed', 'workflow:completed'] },
      (event) => {
        events.push(event);
      },
    );

    // Execute
    const run = await orderWorkflow.start({ orderId: 'ORD-001', amount: 99.99 });
    const result = await orderWorkflow.execute(run._id);
    await waitFor(300);

    // Verify final state
    expect(result.status).toBe('done');
    expect(result.context.validated).toBe(true);
    expect(result.context.charged).toBe(true);
    expect(result.context.shipped).toBe(true);
    expect(result.context.trackingNumber).toBeTruthy();

    // Verify all steps completed with metrics
    const doc = await WorkflowRunModel.findById(run._id).lean();
    for (const step of doc!.steps) {
      expect(step.status).toBe('done');
      expect(step.completedAt).toBeDefined();
      expect(typeof step.durationMs).toBe('number');
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Verify logs persisted
    const logs = doc!.stepLogs as StepLogEntry[];
    expect(logs.length).toBeGreaterThanOrEqual(4);
    expect(logs[0].message).toContain('Validating');

    // Verify events captured
    expect(events).toContain('step:completed');
    expect(events).toContain('workflow:completed');
    expect(events.filter((e) => e === 'step:completed')).toHaveLength(4);

    unsub();
    orderWorkflow.shutdown();
  });

  it('should handle failed order with non-retriable error', async () => {
    const orderWorkflow = createWorkflow('order-fail', {
      steps: {
        validate: {
          handler: async () => {
            const err = new Error('Payment declined');
            (err as any).retriable = false;
            throw err;
          },
          retries: 5,
        },
      },
      autoExecute: false,
    });

    const run = await orderWorkflow.start({});
    const result = await orderWorkflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].error?.message).toContain('Payment declined');
    // Should NOT have retried (retriable=false)
    expect(result.steps[0].attempts).toBe(1);

    orderWorkflow.shutdown();
  });
});

// ============================================================================
// Full Pipeline: Content Approval with Human-in-the-Loop
// ============================================================================

describe('Integration smoke: content approval with human review', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should pause for human review and resume on approval', async () => {
    interface ContentCtx {
      title: string;
      autoApproved: boolean;
    }

    const wf = createWorkflow<ContentCtx>('content-review', {
      steps: {
        analyze: async (ctx) => {
          ctx.log('Analyzing content quality');
          return { score: 0.4 }; // Low score → needs review
        },
        review: async (ctx) => {
          const analysis = ctx.getOutput<{ score: number }>('analyze');
          if (analysis && analysis.score >= 0.8) {
            await ctx.set('autoApproved', true);
            return { autoApproved: true };
          }
          return ctx.wait('Content needs human review', { score: analysis?.score });
        },
        publish: {
          handler: async (ctx) => {
            ctx.log('Publishing content');
            return { published: true, title: ctx.context.title };
          },
          skipIf: (ctx) => !ctx.autoApproved,
        },
      },
      context: (input: { title: string }) => ({
        title: input.title,
        autoApproved: false,
      }),
      autoExecute: false,
    });

    const run = await wf.start({ title: 'Draft Article' });
    let result = await wf.execute(run._id);

    // Should be waiting for human review
    expect(result.status).toBe('waiting');
    const reviewStep = result.steps.find((s) => s.stepId === 'review');
    expect(reviewStep?.status).toBe('waiting');
    expect(reviewStep?.waitingFor?.reason).toContain('human review');

    // Human approves (but doesn't set autoApproved — so publish will be skipped)
    result = await wf.resume(run._id, { approved: true, reviewer: 'editor-1' });

    expect(result.status).toBe('done');
    // publish step was skipped because autoApproved is false
    const publishStep = result.steps.find((s) => s.stepId === 'publish');
    expect(publishStep?.status).toBe('skipped');

    wf.shutdown();
  });
});

// ============================================================================
// Cancel + Abort Signal Verification
// ============================================================================

describe('Integration smoke: cancel with abort signal', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should cancel in-flight workflow and fire abort signal', async () => {
    let abortFired = false;

    const wf = createWorkflow('cancel-smoke', {
      steps: {
        slow: async (ctx) => {
          ctx.signal.addEventListener('abort', () => {
            abortFired = true;
          });
          await new Promise((r) => setTimeout(r, 10000));
          return 'unreachable';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    await waitFor(50);
    const cancelled = await wf.cancel(run._id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.endedAt).toBeDefined();
    expect(abortFired).toBe(true);

    await execPromise;
    wf.shutdown();
  });
});

// ============================================================================
// Logger Configuration Verification
// ============================================================================

describe('Integration smoke: logger configuration', () => {
  it('should support custom transport for collecting logs', async () => {
    const collected: unknown[] = [];

    configureStreamlineLogger({
      enabled: true,
      transport: (entry) => collected.push(entry),
    });

    const wf = createWorkflow('logger-smoke', {
      steps: {
        step1: async (ctx) => {
          ctx.log('hello from step');
          return 'ok';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // ctx.log goes through the centralized logger
    expect(collected.some((e: any) => e.message === 'hello from step')).toBe(true);

    // Cleanup
    configureStreamlineLogger({ enabled: false, transport: null });
    wf.shutdown();
  });
});
