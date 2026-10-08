/**
 * Event System & Observability Tests
 *
 * Tests the event sink, step-level logging, per-step metrics,
 * and integration with external monitoring systems.
 */

import { describe, expect, it } from 'vitest';
import { createEventSink, type WorkflowEventName } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// ============================================================================
// Event Sink — Full Lifecycle Tracking
// ============================================================================

describe('Event sink lifecycle tracking', () => {
  it('should capture complete event sequence for a 3-step workflow', async () => {
    const events: Array<{ event: WorkflowEventName; stepId: string | undefined }> = [];

    const wf = env.workflow('lifecycle-events', {
      steps: {
        alpha: async () => 'a',
        beta: async () => 'b',
        gamma: async () => 'c',
      },
    });

    const unsub = createEventSink(wf.container.eventBus, {}, (event, payload) => {
      events.push({ event, stepId: (payload as { stepId?: string } | undefined)?.stepId });
    });

    try {
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
    } finally {
      unsub();
    }
  });

  it('should capture failure events with error details', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];

    const wf = env.workflow('failure-events', {
      steps: {
        fail_step: {
          handler: async () => {
            throw new Error('Intentional failure');
          },
          retries: 1,
        },
      },
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      { events: ['step:failed', 'workflow:failed'] },
      (event, payload) => {
        events.push({ event, payload });
      },
    );

    try {
      const run = await wf.start({});
      await wf.execute(run._id);

      expect(events.some((e) => e.event === 'step:failed')).toBe(true);
      expect(events.some((e) => e.event === 'workflow:failed')).toBe(true);
    } finally {
      unsub();
    }
  });

  it('should capture retry-scheduled events with backoff info', async () => {
    const events: Array<{ event: string; payload: { retryAfter?: unknown } }> = [];
    let attempts = 0;

    const wf = env.workflow('retry-events', {
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
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      { events: ['step:retry-scheduled'] },
      (event, payload) => {
        events.push({ event, payload: payload as { retryAfter?: unknown } });
      },
    );

    try {
      const run = await wf.start({});
      await wf.execute(run._id);

      // Should have one retry-scheduled event (first failure)
      expect(events.length).toBeGreaterThanOrEqual(1);
      const retryEvent = events[0];
      expect(retryEvent?.event).toBe('step:retry-scheduled');
      expect(retryEvent?.payload.retryAfter).toBeDefined();
    } finally {
      unsub();
    }
  });

  it('should unsubscribe cleanly — no events after unsub', async () => {
    const events: string[] = [];

    const wf = env.workflow('unsub-test', {
      steps: {
        a: async () => 'ok',
      },
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
  });
});

// ============================================================================
// Step-Level Logging (Persisted)
// ============================================================================

describe('Persisted step-level logging', () => {
  it('should persist logs from multiple steps in order', async () => {
    const wf = env.workflow('multi-step-logs', {
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
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // Log persistence is fire-and-forget — wait for all five to land
    const doc = await env.until(run._id, (r) => (r.stepLogs?.length ?? 0) >= 5);
    const logs = doc.stepLogs ?? [];

    expect(logs.length).toBeGreaterThanOrEqual(5);

    // Logs should be in chronological order
    for (let i = 1; i < logs.length; i++) {
      expect(new Date(logs[i]?.timestamp ?? 0).getTime()).toBeGreaterThanOrEqual(
        new Date(logs[i - 1]?.timestamp ?? 0).getTime(),
      );
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

    const wf = env.workflow('retry-logs', {
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
    });

    const run = await wf.start({});
    await wf.execute(run._id); // First attempt — fails, logs attempt 1

    // Log persistence is fire-and-forget — wait for the first entry to land
    const doc = await env.until(run._id, (r) => (r.stepLogs?.length ?? 0) > 0);
    const logs = doc.stepLogs;

    if (logs && logs.length > 0) {
      // First log should be from attempt 1
      expect(logs[0]?.attempt).toBe(1);
    }
  });
});

// ============================================================================
// Per-Step Metrics
// ============================================================================

describe('Per-step timing metrics', () => {
  it('should record accurate durationMs for each step', async () => {
    const wf = env.workflow('metrics-accuracy', {
      steps: {
        instant: async () => 'fast',
        delayed: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return 'slow';
        },
      },
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const doc = await env.runs.get(run._id);
    const instant = doc?.steps.find((s) => s.stepId === 'instant');
    const delayed = doc?.steps.find((s) => s.stepId === 'delayed');

    // Instant step should be very fast
    expect(instant?.durationMs).toBeDefined();
    expect(instant?.durationMs).toBeLessThan(100);

    // Delayed step should be ~150ms
    expect(delayed?.durationMs).toBeDefined();
    expect(delayed?.durationMs).toBeGreaterThanOrEqual(140);
    expect(delayed?.durationMs).toBeLessThan(500);

    // Both should have completedAt
    expect(instant?.completedAt).toBeDefined();
    expect(delayed?.completedAt).toBeDefined();
  });

  it('should record durationMs=0 for skipped steps', async () => {
    const wf = env.workflow('skipped-metrics', {
      steps: {
        first: async () => 'ok',
        skipped: { handler: async () => 'nope', skipIf: () => true },
        last: async () => 'ok',
      },
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const doc = await env.runs.get(run._id);
    const skipped = doc?.steps.find((s) => s.stepId === 'skipped');

    expect(skipped?.status).toBe('skipped');
    expect(skipped?.durationMs).toBe(0);
    expect(skipped?.completedAt).toBeDefined();
  });
});

// ============================================================================
// Workflow Progress & Visualization
// ============================================================================

describe('Workflow progress tracking', () => {
  it('should track step-by-step progress through execution', async () => {
    const stepsExecuted: string[] = [];

    const wf = env.workflow('progress-track', {
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
  });
});
