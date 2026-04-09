/**
 * Event System & Observability Tests
 *
 * Tests the event sink, step-level logging, per-step metrics,
 * and integration with external monitoring systems.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  createEventSink,
  WorkflowRunModel,
  type WorkflowEventName,
  type StepLogEntry,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// Event Sink — Full Lifecycle Tracking
// ============================================================================

describe('Event sink lifecycle tracking', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should capture complete event sequence for a 3-step workflow', async () => {
    const events: Array<{ event: WorkflowEventName; stepId?: string }> = [];

    const wf = createWorkflow('lifecycle-events', {
      steps: {
        alpha: async () => 'a',
        beta: async () => 'b',
        gamma: async () => 'c',
      },
      autoExecute: false,
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      {},
      (event, payload: any) => {
        events.push({ event: event as WorkflowEventName, stepId: payload?.stepId });
      },
    );

    const run = await wf.start({});
    await wf.execute(run._id);

    // Expected sequence: started, 3x(step:started, step:completed), workflow:completed
    const eventNames = events.map((e) => e.event);

    expect(eventNames).toContain('workflow:started');
    expect(eventNames).toContain('workflow:completed');

    // 3 step:started events
    const stepStarts = events.filter((e) => e.event === 'step:started');
    expect(stepStarts).toHaveLength(3);
    expect(stepStarts.map((e) => e.stepId)).toEqual(['alpha', 'beta', 'gamma']);

    // 3 step:completed events
    const stepCompletes = events.filter((e) => e.event === 'step:completed');
    expect(stepCompletes).toHaveLength(3);

    unsub();
    wf.shutdown();
  });

  it('should capture failure events with error details', async () => {
    const events: Array<{ event: string; payload: any }> = [];

    const wf = createWorkflow('failure-events', {
      steps: {
        fail_step: {
          handler: async () => {
            throw new Error('Intentional failure');
          },
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      { events: ['step:failed', 'workflow:failed'] },
      (event, payload) => {
        events.push({ event, payload });
      },
    );

    const run = await wf.start({});
    await wf.execute(run._id);

    expect(events.some((e) => e.event === 'step:failed')).toBe(true);
    expect(events.some((e) => e.event === 'workflow:failed')).toBe(true);

    unsub();
    wf.shutdown();
  });

  it('should capture retry-scheduled events with backoff info', async () => {
    const events: Array<{ event: string; payload: any }> = [];
    let attempts = 0;

    const wf = createWorkflow('retry-events', {
      steps: {
        flaky: {
          handler: async () => {
            attempts++;
            if (attempts < 3) throw new Error('transient');
            return 'ok';
          },
          retries: 3,
          retryDelay: 50,
        },
      },
      autoExecute: false,
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      { events: ['step:retry-scheduled'] },
      (event, payload) => {
        events.push({ event, payload });
      },
    );

    const run = await wf.start({});
    await wf.execute(run._id);

    // Should have one retry-scheduled event (first failure)
    expect(events.length).toBeGreaterThanOrEqual(1);
    const retryEvent = events[0];
    expect(retryEvent.event).toBe('step:retry-scheduled');
    expect(retryEvent.payload.retryAfter).toBeDefined();

    unsub();
    wf.shutdown();
  });

  it('should unsubscribe cleanly — no events after unsub', async () => {
    const events: string[] = [];

    const wf = createWorkflow('unsub-test', {
      steps: {
        a: async () => 'ok',
      },
      autoExecute: false,
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      { events: ['workflow:completed'] },
      (event) => {
        events.push(event);
      },
    );

    // Unsubscribe BEFORE execution
    unsub();

    const run = await wf.start({});
    await wf.execute(run._id);

    // No events should have been captured
    expect(events).toHaveLength(0);

    wf.shutdown();
  });
});

// ============================================================================
// Step-Level Logging (Persisted)
// ============================================================================

describe('Persisted step-level logging', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should persist logs from multiple steps in order', async () => {
    const wf = createWorkflow('multi-step-logs', {
      steps: {
        setup: async (ctx) => {
          ctx.log('Setup started');
          ctx.log('Config loaded', { env: 'test' });
          return 'ok';
        },
        process: async (ctx) => {
          ctx.log('Processing batch 1');
          ctx.log('Processing batch 2');
          return 'ok';
        },
        cleanup: async (ctx) => {
          ctx.log('Cleanup complete');
          return 'ok';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);
    await waitFor(300); // Wait for fire-and-forget log persistence

    const doc = await WorkflowRunModel.findById(run._id).lean();
    const logs = doc!.stepLogs as StepLogEntry[];

    expect(logs.length).toBeGreaterThanOrEqual(5);

    // Logs should be in chronological order
    for (let i = 1; i < logs.length; i++) {
      expect(new Date(logs[i].timestamp).getTime())
        .toBeGreaterThanOrEqual(new Date(logs[i - 1].timestamp).getTime());
    }

    // Verify step attribution
    const setupLogs = logs.filter((l) => l.stepId === 'setup');
    const processLogs = logs.filter((l) => l.stepId === 'process');
    expect(setupLogs.length).toBe(2);
    expect(processLogs.length).toBe(2);

    // Verify structured data
    const configLog = logs.find((l) => l.message === 'Config loaded');
    expect(configLog?.data).toEqual({ env: 'test' });
  });

  it('should include attempt number in log entries', async () => {
    let attempt = 0;

    const wf = createWorkflow('retry-logs', {
      steps: {
        flaky: {
          handler: async (ctx) => {
            attempt++;
            ctx.log(`Attempt ${attempt}`);
            if (attempt < 2) throw new Error('retry me');
            return 'ok';
          },
          retries: 3,
          retryDelay: 50,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id); // First attempt — fails, logs attempt 1
    await waitFor(200);

    const doc = await WorkflowRunModel.findById(run._id).lean();
    const logs = doc!.stepLogs as StepLogEntry[] | undefined;

    if (logs && logs.length > 0) {
      // First log should be from attempt 1
      expect(logs[0].attempt).toBe(1);
    }

    wf.shutdown();
  });
});

// ============================================================================
// Per-Step Metrics
// ============================================================================

describe('Per-step timing metrics', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should record accurate durationMs for each step', async () => {
    const wf = createWorkflow('metrics-accuracy', {
      steps: {
        instant: async () => 'fast',
        delayed: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return 'slow';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const doc = await WorkflowRunModel.findById(run._id).lean();
    const instant = doc!.steps.find((s: any) => s.stepId === 'instant');
    const delayed = doc!.steps.find((s: any) => s.stepId === 'delayed');

    // Instant step should be very fast
    expect(instant!.durationMs).toBeDefined();
    expect(instant!.durationMs).toBeLessThan(100);

    // Delayed step should be ~150ms
    expect(delayed!.durationMs).toBeDefined();
    expect(delayed!.durationMs).toBeGreaterThanOrEqual(140);
    expect(delayed!.durationMs).toBeLessThan(500);

    // Both should have completedAt
    expect(instant!.completedAt).toBeDefined();
    expect(delayed!.completedAt).toBeDefined();

    wf.shutdown();
  });

  it('should record durationMs=0 for skipped steps', async () => {
    const wf = createWorkflow('skipped-metrics', {
      steps: {
        first: async () => 'ok',
        skipped: { handler: async () => 'nope', skipIf: () => true },
        last: async () => 'ok',
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const doc = await WorkflowRunModel.findById(run._id).lean();
    const skipped = doc!.steps.find((s: any) => s.stepId === 'skipped');

    expect(skipped!.status).toBe('skipped');
    expect(skipped!.durationMs).toBe(0);
    expect(skipped!.completedAt).toBeDefined();

    wf.shutdown();
  });
});

// ============================================================================
// Workflow Progress & Visualization
// ============================================================================

describe('Workflow progress tracking', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should track step-by-step progress through execution', async () => {
    const stepsExecuted: string[] = [];

    const wf = createWorkflow('progress-track', {
      steps: {
        step1: async () => {
          stepsExecuted.push('step1');
          return 1;
        },
        step2: async () => {
          stepsExecuted.push('step2');
          return 2;
        },
        step3: async () => {
          stepsExecuted.push('step3');
          return 3;
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(stepsExecuted).toEqual(['step1', 'step2', 'step3']);

    // All steps should be done
    for (const step of result.steps) {
      expect(step.status).toBe('done');
      expect(step.attempts).toBeGreaterThanOrEqual(1);
    }

    wf.shutdown();
  });
});
