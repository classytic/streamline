/**
 * E2E tests for v2.1 enhancements:
 * 1. Persisted step-level logging (ctx.log -> stepLogs)
 * 2. Configurable retry backoff (retryDelay, retryBackoff)
 * 3. Typed checkpoint (generic checkpoint<T>)
 * 4. Per-step metrics (completedAt, durationMs)
 * 5. External event subscriptions (createEventSink)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  createEventSink,
  WorkflowRunModel,
  type StepLogEntry,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// 1. Persisted Step-Level Logging
// ============================================================================

describe('Step-level logging (stepLogs)', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should persist ctx.log() calls to the run document', async () => {
    const workflow = createWorkflow('log-test', {
      steps: {
        greet: async (ctx) => {
          ctx.log('Starting greet step');
          ctx.log('Processing user', { userId: 'u-123' });
          return 'hello';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Give log persistence a moment (fire-and-forget $push operations)
    await waitFor(500);

    // Read directly from MongoDB to check stepLogs
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc).toBeTruthy();
    expect(doc!.stepLogs).toBeDefined();
    expect(doc!.stepLogs!.length).toBeGreaterThanOrEqual(2);

    const logs = doc!.stepLogs as StepLogEntry[];
    expect(logs[0].stepId).toBe('greet');
    expect(logs[0].message).toBe('Starting greet step');
    expect(logs[0].attempt).toBeGreaterThanOrEqual(1);
    expect(logs[0].timestamp).toBeDefined();

    expect(logs[1].message).toBe('Processing user');
    expect(logs[1].data).toEqual({ userId: 'u-123' });

    workflow.shutdown();
  });
});

// ============================================================================
// 2. Configurable Retry Backoff
// ============================================================================

describe('Configurable retry backoff', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should accept retryDelay and retryBackoff per step — retries inline for short delays', async () => {
    let attempts = 0;

    const workflow = createWorkflow('retry-config-test', {
      steps: {
        flaky: {
          handler: async () => {
            attempts++;
            if (attempts < 3) throw new Error('fail');
            return 'ok';
          },
          retries: 3,
          retryDelay: 100, // <5s = inline retry within same execute()
          retryBackoff: 'linear',
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});

    // Short retryDelay (<5s) is handled inline — all retries happen within execute()
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(attempts).toBe(3); // 2 failures + 1 success

    workflow.shutdown();
  });

  it('should support workflow-level retry defaults', async () => {
    let attempts = 0;

    const workflow = createWorkflow('retry-defaults-test', {
      steps: {
        step1: async () => {
          attempts++;
          if (attempts < 2) throw new Error('fail');
          return 'ok';
        },
      },
      defaults: {
        retries: 3,
        retryDelay: 50,
        retryBackoff: 'fixed',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});

    // Short delay = inline retry
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(attempts).toBe(2); // 1 failure + 1 success

    workflow.shutdown();
  });
});

// ============================================================================
// 3. Typed Checkpoint
// ============================================================================

describe('Typed checkpoint', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should support typed checkpoint and getCheckpoint', async () => {
    interface Progress {
      processedCount: number;
      lastId: string;
    }

    const workflow = createWorkflow<{ items: string[] }>('checkpoint-typed-test', {
      steps: {
        process: async (ctx) => {
          const prev = ctx.getCheckpoint<Progress>();
          const start = prev ? prev.processedCount : 0;

          for (let i = start; i < ctx.context.items.length; i++) {
            await ctx.checkpoint<Progress>({
              processedCount: i + 1,
              lastId: ctx.context.items[i],
            });
          }

          return { total: ctx.context.items.length };
        },
      },
      context: (input: { items: string[] }) => ({ items: input.items }),
      autoExecute: false,
    });

    const run = await workflow.start({ items: ['a', 'b', 'c'] });
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ total: 3 });

    workflow.shutdown();
  });
});

// ============================================================================
// 4. Per-Step Metrics (completedAt, durationMs)
// ============================================================================

describe('Per-step metrics', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should record completedAt and durationMs on completed steps', async () => {
    const workflow = createWorkflow('metrics-test', {
      steps: {
        fast: async () => {
          return 'quick';
        },
        slow: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'delayed';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc).toBeTruthy();

    const fastStep = doc!.steps.find((s: any) => s.stepId === 'fast');
    const slowStep = doc!.steps.find((s: any) => s.stepId === 'slow');

    // Fast step
    expect(fastStep!.status).toBe('done');
    expect(fastStep!.completedAt).toBeDefined();
    expect(fastStep!.durationMs).toBeDefined();
    expect(typeof fastStep!.durationMs).toBe('number');
    expect(fastStep!.durationMs).toBeGreaterThanOrEqual(0);

    // Slow step
    expect(slowStep!.status).toBe('done');
    expect(slowStep!.completedAt).toBeDefined();
    expect(slowStep!.durationMs).toBeDefined();
    expect(slowStep!.durationMs).toBeGreaterThanOrEqual(90);

    workflow.shutdown();
  });

  it('should record durationMs on failed steps', async () => {
    const workflow = createWorkflow('metrics-fail-test', {
      steps: {
        failing: {
          handler: async () => {
            await new Promise((r) => setTimeout(r, 50));
            throw new Error('intentional');
          },
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const doc = await WorkflowRunModel.findById(run._id).lean();
    const failingStep = doc!.steps.find((s: any) => s.stepId === 'failing');
    expect(failingStep!.durationMs).toBeDefined();
    expect(failingStep!.durationMs).toBeGreaterThanOrEqual(40);

    workflow.shutdown();
  });
});

// ============================================================================
// 5. External Event Subscriptions (createEventSink)
// ============================================================================

describe('createEventSink', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should receive workflow lifecycle events via sink', async () => {
    const events: Array<{ event: string; payload: any }> = [];

    const workflow = createWorkflow('sink-test', {
      steps: {
        step1: async () => 'result1',
        step2: async () => 'result2',
      },
      autoExecute: false,
    });

    const unsub = createEventSink(
      workflow.container.eventBus,
      { events: ['workflow:started', 'step:completed', 'workflow:completed'] },
      (event, payload) => {
        events.push({ event, payload });
      },
    );

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Should have received events
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.event === 'workflow:started')).toBe(true);
    expect(events.some((e) => e.event === 'step:completed')).toBe(true);
    expect(events.some((e) => e.event === 'workflow:completed')).toBe(true);

    // Unsubscribe
    unsub();

    workflow.shutdown();
  });

  it('should filter events by runId', async () => {
    const events: Array<{ event: string; payload: any }> = [];

    const workflow = createWorkflow('sink-filter-test', {
      steps: {
        step1: async () => 'ok',
      },
      autoExecute: false,
    });

    const run1 = await workflow.start({});

    const unsub = createEventSink(
      workflow.container.eventBus,
      { events: ['workflow:completed'], runId: run1._id },
      (event, payload) => {
        events.push({ event, payload });
      },
    );

    await workflow.execute(run1._id);

    // Should have the completion event for run1
    expect(events.some((e) => e.payload.runId === run1._id)).toBe(true);

    unsub();
    workflow.shutdown();
  });
});

// ============================================================================
// Smoke Test — Full Workflow with All Enhancements
// ============================================================================

describe('Smoke test: all v2.1 features combined', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should run a workflow using logs, metrics, typed checkpoint, and event sink', async () => {
    const sinkEvents: string[] = [];

    interface MyCtx {
      items: string[];
    }

    const workflow = createWorkflow<MyCtx>('smoke-v21', {
      steps: {
        setup: async (ctx) => {
          ctx.log('Initializing pipeline', { count: ctx.context.items.length });
          return { ready: true };
        },
        process: async (ctx) => {
          const prev = ctx.getCheckpoint<number>() ?? 0;
          for (let i = prev; i < ctx.context.items.length; i++) {
            ctx.log(`Processing item ${i}`);
            await ctx.checkpoint<number>(i + 1);
          }
          return { processed: ctx.context.items.length };
        },
        finalize: async (ctx) => {
          ctx.log('Done!');
          return { success: true };
        },
      },
      context: (input: { items: string[] }) => ({ items: input.items }),
      autoExecute: false,
    });

    // Subscribe to events
    const unsub = createEventSink(
      workflow.container.eventBus,
      { events: ['step:completed', 'workflow:completed'] },
      (event) => {
        sinkEvents.push(event);
      },
    );

    const run = await workflow.start({ items: ['a', 'b', 'c'] });
    const result = await workflow.execute(run._id);
    await waitFor(300);

    // Verify final status
    expect(result.status).toBe('done');

    // Verify metrics
    const doc = await WorkflowRunModel.findById(run._id).lean();
    for (const step of doc!.steps) {
      if (step.status === 'done') {
        expect(step.completedAt).toBeDefined();
        expect(typeof step.durationMs).toBe('number');
      }
    }

    // Verify logs
    expect(doc!.stepLogs).toBeDefined();
    expect(doc!.stepLogs!.length).toBeGreaterThanOrEqual(4);

    // Verify events
    expect(sinkEvents).toContain('step:completed');
    expect(sinkEvents).toContain('workflow:completed');

    unsub();
    workflow.shutdown();
  });
});
