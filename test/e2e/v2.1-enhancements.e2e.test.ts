/**
 * E2E tests for v2.1 enhancements:
 * 1. Persisted step-level logging (ctx.log -> stepLogs)
 * 2. Configurable retry backoff (retryDelay, retryBackoff)
 * 3. Typed checkpoint (generic checkpoint<T>)
 * 4. Per-step metrics (completedAt, durationMs)
 * 5. External event subscriptions (createEventSink)
 */

import { describe, expect, it } from 'vitest';
import { createEventSink, type StepLogEntry } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** ctx.log() persistence is a fire-and-forget $push — wait until `n` entries landed. */
const hasLogs = (n: number) => (run: { stepLogs?: StepLogEntry[] }) =>
  (run.stepLogs?.length ?? 0) >= n;

// ============================================================================
// 1. Persisted Step-Level Logging
// ============================================================================

describe('Step-level logging (stepLogs)', () => {
  it('should persist ctx.log() calls to the run document', async () => {
    const workflow = env.workflow('log-test', {
      steps: {
        greet: async (ctx) => {
          ctx.log('Starting greet step');
          ctx.log('Processing user', { userId: 'u-123' });
          return 'hello';
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Read directly from MongoDB once the (fire-and-forget) log writes land
    const doc = await env.until(run._id, hasLogs(2));
    expect(doc).toBeTruthy();
    expect(doc.stepLogs).toBeDefined();
    expect(doc.stepLogs!.length).toBeGreaterThanOrEqual(2);

    const logs = doc.stepLogs as StepLogEntry[];
    expect(logs[0].stepId).toBe('greet');
    expect(logs[0].message).toBe('Starting greet step');
    expect(logs[0].attempt).toBeGreaterThanOrEqual(1);
    expect(logs[0].timestamp).toBeDefined();

    expect(logs[1].message).toBe('Processing user');
    expect(logs[1].data).toEqual({ userId: 'u-123' });
  });
});

// ============================================================================
// 2. Configurable Retry Backoff
// ============================================================================

describe('Configurable retry backoff', () => {
  it('should accept retryDelay and retryBackoff per step — retries inline for short delays', async () => {
    let attempts = 0;

    const workflow = env.workflow('retry-config-test', {
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
    });

    const run = await workflow.start({});

    // Short retryDelay (<5s) is handled inline — all retries happen within execute()
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(attempts).toBe(3); // 2 failures + 1 success
  });

  it('should support workflow-level retry defaults', async () => {
    let attempts = 0;

    const workflow = env.workflow('retry-defaults-test', {
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
    });

    const run = await workflow.start({});

    // Short delay = inline retry
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(attempts).toBe(2); // 1 failure + 1 success
  });
});

// ============================================================================
// 3. Typed Checkpoint
// ============================================================================

describe('Typed checkpoint', () => {
  it('should support typed checkpoint and getCheckpoint', async () => {
    interface Progress {
      processedCount: number;
      lastId: string;
    }

    const workflow = env.workflow<{ items: string[] }, { items: string[] }>(
      'checkpoint-typed-test',
      {
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
        context: (input) => ({ items: input.items }),
      },
    );

    const run = await workflow.start({ items: ['a', 'b', 'c'] });
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ total: 3 });
  });
});

// ============================================================================
// 4. Per-Step Metrics (completedAt, durationMs)
// ============================================================================

describe('Per-step metrics', () => {
  it('should record completedAt and durationMs on completed steps', async () => {
    const workflow = env.workflow('metrics-test', {
      steps: {
        fast: async () => {
          return 'quick';
        },
        slow: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'delayed';
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const doc = await env.runs.get(run._id);
    expect(doc).toBeTruthy();

    const fastStep = doc!.steps.find((s) => s.stepId === 'fast');
    const slowStep = doc!.steps.find((s) => s.stepId === 'slow');

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
  });

  it('should record durationMs on failed steps', async () => {
    const workflow = env.workflow('metrics-fail-test', {
      steps: {
        failing: {
          handler: async () => {
            await new Promise((r) => setTimeout(r, 50));
            throw new Error('intentional');
          },
          retries: 1,
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const doc = await env.runs.get(run._id);
    const failingStep = doc!.steps.find((s) => s.stepId === 'failing');
    expect(failingStep!.durationMs).toBeDefined();
    expect(failingStep!.durationMs).toBeGreaterThanOrEqual(40);
  });
});

// ============================================================================
// 5. External Event Subscriptions (createEventSink)
// ============================================================================

describe('createEventSink', () => {
  it('should receive workflow lifecycle events via sink', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];

    const workflow = env.workflow('sink-test', {
      steps: {
        step1: async () => 'result1',
        step2: async () => 'result2',
      },
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
  });

  it('should filter events by runId', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];

    const workflow = env.workflow('sink-filter-test', {
      steps: {
        step1: async () => 'ok',
      },
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
    expect(events.some((e) => (e.payload as { runId?: string }).runId === run1._id)).toBe(true);

    unsub();
  });
});

// ============================================================================
// Smoke Test — Full Workflow with All Enhancements
// ============================================================================

describe('Smoke test: all v2.1 features combined', () => {
  it('should run a workflow using logs, metrics, typed checkpoint, and event sink', async () => {
    const sinkEvents: string[] = [];

    interface MyCtx {
      items: string[];
    }

    const workflow = env.workflow<MyCtx, { items: string[] }>('smoke-v21', {
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
      context: (input) => ({ items: input.items }),
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

    // Verify final status
    expect(result.status).toBe('done');

    // Verify metrics (read once the fire-and-forget log writes landed)
    const doc = await env.until(run._id, hasLogs(4));
    for (const step of doc.steps) {
      if (step.status === 'done') {
        expect(step.completedAt).toBeDefined();
        expect(typeof step.durationMs).toBe('number');
      }
    }

    // Verify logs
    expect(doc.stepLogs).toBeDefined();
    expect(doc.stepLogs!.length).toBeGreaterThanOrEqual(4);

    // Verify events
    expect(sinkEvents).toContain('step:completed');
    expect(sinkEvents).toContain('workflow:completed');

    unsub();
  });
});
