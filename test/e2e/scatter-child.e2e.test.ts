/**
 * Scatter/Gather & Child Workflow E2E Tests
 *
 * Tests:
 * - ctx.scatter() — durable parallel with crash recovery
 * - ctx.startChildWorkflow() — auto-start child, auto-resume parent
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitUntil } from '../utils/setup.js';
import {
  createWorkflow,
  createContainer,
  WorkflowRunModel,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// ctx.scatter() — Durable Parallel
// ============================================================================

describe('ctx.scatter() — durable parallel execution', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should execute all tasks in parallel and return keyed results', async () => {
    const workflow = createWorkflow('scatter-basic', {
      steps: {
        fetchAll: async (ctx) => {
          const results = await ctx.scatter({
            user: async () => ({ id: 1, name: 'Alice' }),
            orders: async () => [{ id: 'o1' }, { id: 'o2' }],
            settings: async () => ({ theme: 'dark' }),
          });

          return results;
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      user: { id: 1, name: 'Alice' },
      orders: [{ id: 'o1' }, { id: 'o2' }],
      settings: { theme: 'dark' },
    });

    workflow.shutdown();
  });

  it('should resume from checkpoint after crash — completed tasks not re-executed', async () => {
    const executionLog: string[] = [];

    const workflow = createWorkflow('scatter-crash-recovery', {
      steps: {
        fetchAll: async (ctx) => {
          const results = await ctx.scatter({
            fast: async () => {
              executionLog.push('fast');
              return 'fast-result';
            },
            slow: async () => {
              executionLog.push('slow');
              // Crash on first attempt at this task
              if (ctx.attempt === 1) {
                throw new Error('simulated crash');
              }
              return 'slow-result';
            },
          });

          return results;
        },
      },
      defaults: { retries: 3 },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    // 'fast' should only run once (checkpoint preserves its result)
    // 'slow' fails on attempt 1, succeeds on attempt 2
    // But scatter re-runs ALL pending tasks on retry — 'fast' result is restored from checkpoint
    expect(executionLog.filter((l) => l === 'fast')).toHaveLength(1);
    expect(executionLog.filter((l) => l === 'slow')).toHaveLength(2); // fail + success

    expect(result.output).toEqual({
      fast: 'fast-result',
      slow: 'slow-result',
    });

    workflow.shutdown();
  });

  it('should respect concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const workflow = createWorkflow('scatter-concurrency', {
      steps: {
        limited: async (ctx) => {
          return ctx.scatter(
            {
              a: async () => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                await new Promise((r) => setTimeout(r, 50));
                currentConcurrent--;
                return 'a';
              },
              b: async () => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                await new Promise((r) => setTimeout(r, 50));
                currentConcurrent--;
                return 'b';
              },
              c: async () => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                await new Promise((r) => setTimeout(r, 50));
                currentConcurrent--;
                return 'c';
              },
            },
            { concurrency: 2 }
          );
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(result.output).toEqual({ a: 'a', b: 'b', c: 'c' });

    workflow.shutdown();
  });

  it('should fail if any task fails (after checkpoint)', async () => {
    const workflow = createWorkflow('scatter-fail', {
      steps: {
        mixed: async (ctx) => {
          return ctx.scatter({
            ok: async () => 'fine',
            bad: async () => {
              throw new Error('task failed');
            },
          });
        },
      },
      defaults: { retries: 1 },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');

    workflow.shutdown();
  });

  it('should handle empty scatter (no tasks)', async () => {
    const workflow = createWorkflow('scatter-empty', {
      steps: {
        empty: async (ctx) => {
          return ctx.scatter({});
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({});

    workflow.shutdown();
  });
});

// ============================================================================
// ctx.startChildWorkflow() — Auto-Start & Auto-Resume
// ============================================================================

describe('Child workflow auto-orchestration', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should auto-start child and auto-resume parent on child completion', async () => {
    // Use shared container so both workflows share the same event bus
    const container = createContainer();

    // Create child workflow FIRST (must be registered before parent starts)
    const child = createWorkflow<{ doubled: number }>('math-worker', {
      steps: {
        compute: async (ctx) => {
          const input = ctx.input as { value: number };
          await ctx.set('doubled', input.value * 2);
          return { result: input.value * 2 };
        },
      },
      context: () => ({ doubled: 0 }),
      container,
    });

    // Create parent workflow
    const parent = createWorkflow<{ childResult?: unknown }>('orchestrator', {
      steps: {
        prepare: async (ctx) => {
          return { ready: true };
        },
        delegateToChild: async (ctx) => {
          return ctx.startChildWorkflow('math-worker', { value: 21 });
        },
        processChildResult: async (ctx) => {
          const childOutput = ctx.getOutput('delegateToChild');
          await ctx.set('childResult', childOutput);
          return 'done';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    const parentRun = await parent.start({});
    await parent.execute(parentRun._id);

    // Parent should be waiting for child
    const waiting = await parent.get(parentRun._id);
    expect(waiting?.status).toBe('waiting');

    // Wait for auto-orchestration: child starts, completes, parent auto-resumes
    const completed = await waitUntil(async () => {
      const r = await parent.get(parentRun._id);
      return r?.status === 'done';
    }, 10000);

    expect(completed).toBe(true);

    const final = await parent.get(parentRun._id);
    expect(final?.status).toBe('done');
    // Child output should have been passed to parent
    expect(final?.context.childResult).toEqual({ result: 42 });

    parent.shutdown();
    child.shutdown();
  });

  it('should store childRunId in waitingFor data after auto-start', async () => {
    const container = createContainer();

    const child = createWorkflow('tracked-child', {
      steps: {
        work: async (ctx) => {
          // Take a moment so we can inspect parent state
          await new Promise((r) => setTimeout(r, 200));
          return 'child-done';
        },
      },
      container,
    });

    const parent = createWorkflow('tracking-parent', {
      steps: {
        launch: async (ctx) => {
          return ctx.startChildWorkflow('tracked-child', {});
        },
      },
      container,
      autoExecute: false,
    });

    const parentRun = await parent.start({});
    await parent.execute(parentRun._id);

    // Check that childRunId was stored
    const dbRun = await WorkflowRunModel.findById(parentRun._id).lean();
    const step = dbRun?.steps?.find((s) => s.stepId === 'launch');
    const data = step?.waitingFor?.data as Record<string, unknown> | undefined;

    expect(data?.childRunId).toBeDefined();
    expect(typeof data?.childRunId).toBe('string');

    // Wait for everything to complete
    await waitUntil(async () => {
      const r = await parent.get(parentRun._id);
      return r?.status === 'done';
    }, 10000);

    parent.shutdown();
    child.shutdown();
  });
});
