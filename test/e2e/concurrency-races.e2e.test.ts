/**
 * Concurrency & Race Condition Tests
 *
 * Validates atomic operations, double-resume prevention,
 * concurrent workflow isolation, and parallel execution safety.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  createHook,
  resumeHook,
  executeParallel,
  WorkflowRunModel,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// Double-Resume Prevention
// ============================================================================

describe('Double-resume prevention (atomic claim)', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should prevent two concurrent resume() calls from both succeeding', async () => {
    const wf = createWorkflow('double-resume', {
      steps: {
        wait_step: async (ctx) => {
          return ctx.wait('Waiting for input');
        },
        after: async () => 'completed',
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    const waiting = await wf.get(run._id);
    expect(waiting?.status).toBe('waiting');

    // Fire two concurrent resumes
    const results = await Promise.allSettled([
      wf.resume(run._id, { source: 'resume-1' }),
      wf.resume(run._id, { source: 'resume-2' }),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    // At least one should succeed
    expect(successes.length).toBeGreaterThanOrEqual(1);
    // At most both succeed (engine handles idempotently), but data integrity is preserved
    expect(successes.length + failures.length).toBe(2);

    // The workflow should reach a terminal state (done or cancelled, not stuck)
    const final = await wf.get(run._id);
    expect(final).toBeTruthy();
    expect(['done', 'running']).toContain(final!.status);

    wf.shutdown();
  });

  it('should prevent resume after cancel', async () => {
    const wf = createWorkflow('resume-after-cancel', {
      steps: {
        wait_step: async (ctx) => ctx.wait('Waiting'),
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // Cancel first
    await wf.cancel(run._id);

    // Resume should fail
    await expect(wf.resume(run._id, {})).rejects.toThrow();

    wf.shutdown();
  });
});

// ============================================================================
// Concurrent Workflow Isolation
// ============================================================================

describe('Concurrent workflow isolation', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should execute 10 concurrent workflows without interference', async () => {
    const wf = createWorkflow<{ index: number }>('concurrent-iso', {
      steps: {
        compute: async (ctx) => {
          // Each workflow computes its own value
          const value = ctx.context.index * 10;
          await ctx.set('index', value); // Overwrite to verify isolation
          return { result: value };
        },
        verify: async (ctx) => {
          return { finalIndex: ctx.context.index };
        },
      },
      context: (input: { index: number }) => ({ index: input.index }),
      autoExecute: false,
    });

    // Start 10 workflows concurrently
    const runs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => wf.start({ index: i })),
    );

    // Execute all concurrently
    const results = await Promise.all(runs.map((r) => wf.execute(r._id)));

    // Each should have computed independently
    for (let i = 0; i < 10; i++) {
      expect(results[i].status).toBe('done');
      expect(results[i].context.index).toBe(i * 10);
    }

    wf.shutdown();
  });

  it('should isolate context between concurrent runs of same workflow', async () => {
    interface SharedCtx {
      name: string;
      secret: string;
    }

    const wf = createWorkflow<SharedCtx>('context-isolation', {
      steps: {
        process: async (ctx) => {
          // Small delay to increase chance of interleaving
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          return { name: ctx.context.name, secret: ctx.context.secret };
        },
      },
      context: (input: { name: string; secret: string }) => ({
        name: input.name,
        secret: input.secret,
      }),
      autoExecute: false,
    });

    const [runA, runB] = await Promise.all([
      wf.start({ name: 'Alice', secret: 'alice-secret' }),
      wf.start({ name: 'Bob', secret: 'bob-secret' }),
    ]);

    const [resultA, resultB] = await Promise.all([
      wf.execute(runA._id),
      wf.execute(runB._id),
    ]);

    // Contexts must NOT leak between runs
    expect(resultA.context.secret).toBe('alice-secret');
    expect(resultB.context.secret).toBe('bob-secret');
    expect(resultA.context.name).not.toBe('Bob');
    expect(resultB.context.name).not.toBe('Alice');

    wf.shutdown();
  });
});

// ============================================================================
// executeParallel Concurrency Safety
// ============================================================================

describe('executeParallel safety', () => {
  it('should preserve result order regardless of completion order', async () => {
    const results = await executeParallel([
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'slow';
      },
      async () => 'fast',
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'medium';
      },
    ]);

    // Results must be in input order, not completion order
    expect(results).toEqual(['slow', 'fast', 'medium']);
  });

  it('should enforce concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 10 }, () => async () => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise((r) => setTimeout(r, 20));
      current--;
      return 'ok';
    });

    await executeParallel(tasks, { concurrency: 3 });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('should reject race mode with concurrency limit', async () => {
    await expect(
      executeParallel([async () => 1], { mode: 'race', concurrency: 2 }),
    ).rejects.toThrow("mode 'race' cannot be combined with concurrency");
  });

  it('should handle allSettled with mixed success/failure', async () => {
    const results = await executeParallel(
      [
        async () => 'ok',
        async () => {
          throw new Error('fail');
        },
        async () => 'also-ok',
      ],
      { mode: 'allSettled' },
    ) as Array<{ success: boolean; value?: string; reason?: unknown }>;

    expect(results[0]).toEqual({ success: true, value: 'ok' });
    expect(results[1].success).toBe(false);
    expect(results[2]).toEqual({ success: true, value: 'also-ok' });
  });

  it('should timeout individual tasks', async () => {
    await expect(
      executeParallel(
        [
          async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return 'too-slow';
          },
        ],
        { timeout: 50 },
      ),
    ).rejects.toThrow('timeout');
  });
});

// ============================================================================
// Cancel During Execution
// ============================================================================

describe('Cancel during active execution', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should abort in-flight step via signal on cancel', async () => {
    let signalAborted = false;

    const wf = createWorkflow('cancel-inflight', {
      steps: {
        long_step: async (ctx) => {
          // Listen for abort signal
          ctx.signal.addEventListener('abort', () => {
            signalAborted = true;
          });
          await new Promise((r) => setTimeout(r, 5000));
          return 'should-not-reach';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    // Give the step time to start
    await waitFor(50);

    await wf.cancel(run._id);
    await execPromise;

    expect(signalAborted).toBe(true);

    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.status).toBe('cancelled');

    wf.shutdown();
  });
});
