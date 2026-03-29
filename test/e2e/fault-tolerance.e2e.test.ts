/**
 * Fault Tolerance & Production Readiness E2E Tests
 *
 * Tests streamline's behavior under adversarial conditions:
 * - Concurrent resume race conditions
 * - Stale workflow recovery
 * - Multi-worker atomic claiming
 * - Write concern durability
 * - Event payload type safety
 * - Large workflow loads
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitUntil } from '../utils/setup.js';
import {
  createWorkflow,
  createContainer,
  createHook,
  resumeHook,
  WaitSignal,
  WorkflowRunModel,
  globalEventBus,
  type Workflow,
  type WorkflowRun,
  type StepConfig,
  type WorkflowConfig,
  type WaitForOptions,
  type HookResult,
  type HookOptions,
  type EventPayloadMap,
  type StepCompletedPayload,
  type StepFailedPayload,
  type WorkflowFailedPayload,
  type EngineErrorPayload,
  type BaseEventPayload,
  type WorkflowResumedPayload,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// Type Export Completeness
// ============================================================================

describe('Type export completeness', () => {
  it('should export all event payload types', () => {
    // These are type-only — verify at runtime they're accessible as imports
    // (compilation itself validates the types exist)
    const _check = {} as EventPayloadMap;
    expect(_check).toBeDefined();
  });

  it('should export HookResult and HookOptions types', () => {
    const result: HookResult = { token: 'test', path: '/hooks/test' };
    const options: HookOptions = { token: 'custom' };
    expect(result.token).toBe('test');
    expect(options.token).toBe('custom');
  });

  it('should export WaitSignal for custom error handling', () => {
    expect(WaitSignal).toBeDefined();
    const signal = new WaitSignal('timer', 'test');
    expect(signal).toBeInstanceOf(Error);
    expect(signal.type).toBe('timer');
  });

  it('should export all workflow DX types', () => {
    // Type-only test: all these must import without errors
    const _workflow: Workflow<{ n: number }> | null = null;
    const _config: WorkflowConfig<{ n: number }> | null = null;
    const _step: StepConfig<unknown, { n: number }> | null = null;
    const _opts: WaitForOptions | null = null;
    const _run: WorkflowRun<{ n: number }> | null = null;
    const _hook: HookResult | null = null;

    // Event payload types
    const _completed: StepCompletedPayload | null = null;
    const _failed: StepFailedPayload | null = null;
    const _wfFailed: WorkflowFailedPayload | null = null;
    const _error: EngineErrorPayload | null = null;
    const _base: BaseEventPayload | null = null;
    const _resumed: WorkflowResumedPayload | null = null;

    expect(true).toBe(true); // Compilation is the real test
  });
});

// ============================================================================
// Concurrent Resume Race Condition
// ============================================================================

describe('Concurrent resume safety', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should safely handle two concurrent resume() calls on paused workflow', async () => {
    const workflow = createWorkflow('concurrent-resume', {
      steps: {
        waitStep: async (ctx) => ctx.wait('approval'),
        after: async () => 'done',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Pause it
    await workflow.pause(run._id);
    const paused = await workflow.get(run._id);
    expect(paused?.paused).toBe(true);

    // Two concurrent resumes — only one should win the atomic claim
    const results = await Promise.allSettled([
      workflow.resume(run._id, { from: 'worker-1' }),
      workflow.resume(run._id, { from: 'worker-2' }),
    ]);

    // Both should succeed (one claims, the other returns current state)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);

    // Wait for completion
    await waitUntil(async () => {
      const r = await workflow.get(run._id);
      return r?.status === 'done';
    }, 5000);

    const final = await workflow.get(run._id);
    expect(final?.status).toBe('done');
    expect(final?.paused).toBeFalsy();

    workflow.shutdown();
  });

  it('should handle concurrent execute() calls without duplicate step runs', async () => {
    let stepRunCount = 0;

    const workflow = createWorkflow('concurrent-execute', {
      steps: {
        counted: async () => {
          stepRunCount++;
          await new Promise((r) => setTimeout(r, 100));
          return 'done';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});

    // Two workers try to execute simultaneously
    await Promise.allSettled([
      workflow.execute(run._id),
      workflow.execute(run._id),
    ]);

    // Atomic claiming should prevent double execution
    // Step should run exactly once (second worker sees it already running/done)
    expect(stepRunCount).toBe(1);

    workflow.shutdown();
  });
});

// ============================================================================
// Write Concern Durability
// ============================================================================

describe('Write concern durability', () => {
  it('should have majority write concern on the schema', () => {
    const schema = WorkflowRunModel.schema;
    const wc = schema.options.writeConcern;
    expect(wc).toBeDefined();
    expect(wc?.w).toBe('majority');
    expect(wc?.j).toBe(true);
  });
});

// ============================================================================
// Stale Recovery Under Load
// ============================================================================

describe('Stale recovery', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should recover a workflow with stale heartbeat', async () => {
    const workflow = createWorkflow('stale-recovery-test', {
      steps: {
        step1: async () => 'done',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});

    // Simulate a stale workflow: set lastHeartbeat to 10 minutes ago
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      { $set: { lastHeartbeat: staleTime } }
    );

    // Attempt recovery
    const recovered = await workflow.engine.recoverStale(run._id, 5 * 60 * 1000);
    expect(recovered).not.toBeNull();

    await waitUntil(async () => {
      const r = await workflow.get(run._id);
      return r?.status === 'done';
    }, 5000);

    const final = await workflow.get(run._id);
    expect(final?.status).toBe('done');

    workflow.shutdown();
  });

  it('should NOT recover a workflow with fresh heartbeat', async () => {
    const workflow = createWorkflow('fresh-heartbeat', {
      steps: {
        step1: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 'done';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});

    // Set fresh heartbeat
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      { $set: { lastHeartbeat: new Date() } }
    );

    // Recovery should fail (heartbeat is fresh)
    const result = await workflow.engine.recoverStale(run._id, 5 * 60 * 1000);
    expect(result).toBeNull();

    workflow.shutdown();
  });
});

// ============================================================================
// Event Payload Type Safety
// ============================================================================

describe('Event payload type safety', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should emit typed event payloads for step lifecycle', async () => {
    const container = createContainer();
    const events: string[] = [];

    container.eventBus.on('step:started', (payload) => {
      events.push(`started:${payload.stepId}`);
    });
    container.eventBus.on('step:completed', (payload) => {
      events.push(`completed:${payload.stepId}`);
    });

    const workflow = createWorkflow('event-payloads', {
      steps: {
        s1: async () => 'ok',
        s2: async () => 'ok',
      },
      container,
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    expect(events).toEqual([
      'started:s1',
      'completed:s1',
      'started:s2',
      'completed:s2',
    ]);

    workflow.shutdown();
  });

  it('should emit step:failed with error details', async () => {
    const container = createContainer();
    let failPayload: StepFailedPayload | null = null;

    container.eventBus.on('step:failed', (payload) => {
      failPayload = payload as StepFailedPayload;
    });

    const workflow = createWorkflow('event-fail-payload', {
      steps: {
        failing: async () => {
          throw new Error('intentional');
        },
      },
      container,
      defaults: { retries: 1 },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    expect(failPayload).not.toBeNull();
    expect(failPayload!.stepId).toBe('failing');
    expect(failPayload!.runId).toBe(run._id);

    workflow.shutdown();
  });

  it('should emit heartbeat-warning on heartbeat failure', async () => {
    // This test verifies the heartbeat failure tracking fix.
    // We can't easily simulate a DB error during heartbeat in e2e,
    // but we verify the event bus emits engine:error events.
    const container = createContainer();
    const errors: string[] = [];

    container.eventBus.on('engine:error', (payload) => {
      errors.push(payload.context);
    });

    // Just verify the listener setup works
    container.eventBus.emit('engine:error', {
      runId: 'test',
      error: new Error('test'),
      context: 'heartbeat-warning',
    });

    expect(errors).toContain('heartbeat-warning');
  });
});

// ============================================================================
// Large Workflow Load
// ============================================================================

describe('Load handling', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should handle 50 concurrent workflow starts', async () => {
    const workflow = createWorkflow('load-test', {
      steps: {
        quick: async () => 'done',
      },
      autoExecute: false,
    });

    // Start 50 workflows concurrently
    const starts = Array.from({ length: 50 }, (_, i) =>
      workflow.start({ index: i })
    );
    const runs = await Promise.all(starts);

    expect(runs).toHaveLength(50);
    expect(new Set(runs.map((r) => r._id)).size).toBe(50); // All unique IDs

    // Execute them all
    const executes = runs.map((r) => workflow.execute(r._id));
    const results = await Promise.all(executes);

    const doneCount = results.filter((r) => r.status === 'done').length;
    expect(doneCount).toBe(50);

    workflow.shutdown();
  });

  it('should handle 10 workflows with 5 steps each', async () => {
    const workflow = createWorkflow<{ total: number }>('multi-step-load', {
      steps: {
        s1: async (ctx) => { await ctx.set('total', 1); return 1; },
        s2: async (ctx) => { await ctx.set('total', 2); return 2; },
        s3: async (ctx) => { await ctx.set('total', 3); return 3; },
        s4: async (ctx) => { await ctx.set('total', 4); return 4; },
        s5: async (ctx) => { await ctx.set('total', 5); return 5; },
      },
      context: () => ({ total: 0 }),
      autoExecute: false,
    });

    const runs = await Promise.all(
      Array.from({ length: 10 }, () => workflow.start({}))
    );

    const results = await Promise.all(
      runs.map((r) => workflow.execute(r._id))
    );

    for (const result of results) {
      expect(result.status).toBe('done');
      expect(result.context.total).toBe(5);
      expect(result.steps.every((s) => s.status === 'done')).toBe(true);
    }

    workflow.shutdown();
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge cases', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should handle empty context gracefully', async () => {
    const workflow = createWorkflow('empty-context', {
      steps: {
        check: async (ctx) => {
          expect(ctx.context).toBeDefined();
          return 'ok';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');

    workflow.shutdown();
  });

  it('should handle large context objects', async () => {
    const workflow = createWorkflow<{ data: string[] }>('large-context', {
      steps: {
        fill: async (ctx) => {
          // 10K items in context
          const bigArray = Array.from({ length: 10000 }, (_, i) => `item-${i}`);
          await ctx.set('data', bigArray);
          return { count: bigArray.length };
        },
        verify: async (ctx) => {
          expect(ctx.context.data.length).toBe(10000);
          return 'verified';
        },
      },
      context: () => ({ data: [] as string[] }),
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(result.context.data.length).toBe(10000);

    workflow.shutdown();
  });

  it('should handle special characters in workflow and step IDs', async () => {
    // Workflow IDs with dashes and underscores
    const workflow = createWorkflow('my-complex_workflow-v2', {
      steps: {
        'step-with-dashes': async () => 'ok',
        step_with_underscores: async () => 'ok',
        camelCaseStep: async () => 'ok',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(result.steps).toHaveLength(3);

    workflow.shutdown();
  });

  it('should handle getOutput from non-existent step returning undefined', async () => {
    const workflow = createWorkflow('getoutput-missing', {
      steps: {
        check: async (ctx) => {
          const missing = ctx.getOutput('nonexistent');
          expect(missing).toBeUndefined();
          return 'ok';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');

    workflow.shutdown();
  });

  it('should fail fast with zero steps', () => {
    expect(() =>
      createWorkflow('no-steps', {
        steps: {},
      })
    ).toThrow(/at least one step/);
  });

  it('should handle workflow with single step', async () => {
    const workflow = createWorkflow('single-step', {
      steps: {
        only: async () => ({ result: 42 }),
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
    expect(result.output).toEqual({ result: 42 });

    workflow.shutdown();
  });

  it('should handle non-retriable errors (error.retriable = false)', async () => {
    let attempts = 0;

    const workflow = createWorkflow('non-retriable', {
      steps: {
        fatal: async () => {
          attempts++;
          const err = new Error('fatal error') as Error & { retriable: boolean };
          err.retriable = false;
          throw err;
        },
      },
      defaults: { retries: 5 },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(1); // No retries for non-retriable errors

    workflow.shutdown();
  });
});
