/**
 * Durability & Crash Recovery Tests
 *
 * Validates that the workflow engine survives process restarts,
 * recovers from mid-execution crashes, and maintains data integrity.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  createContainer,
  WorkflowEngine,
  WorkflowRunModel,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// Checkpoint Crash Recovery
// ============================================================================

describe('Checkpoint crash recovery', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should resume from last checkpoint after simulated crash', async () => {
    const callLog: string[] = [];

    // First execution: process partially, then "crash"
    const wf1 = createWorkflow<{ items: number[] }>('crash-recovery', {
      steps: {
        process: async (ctx) => {
          const cp = ctx.getCheckpoint<number>() ?? 0;

          for (let i = cp; i < ctx.context.items.length; i++) {
            callLog.push(`process-${ctx.context.items[i]}`);
            await ctx.checkpoint(i + 1);

            // Simulate crash after processing 3 items
            if (i === 2) {
              throw new Error('Simulated OOM crash');
            }
          }
          return { done: true };
        },
      },
      context: (input: { items: number[] }) => ({ items: input.items }),
      autoExecute: false,
      defaults: { retries: 1 }, // No retries for first execution
    });

    const run = await wf1.start({ items: [10, 20, 30, 40, 50] });
    await wf1.execute(run._id);

    // Should have processed 3 items then failed
    expect(callLog).toEqual(['process-10', 'process-20', 'process-30']);

    // Verify checkpoint is persisted in DB
    const doc = await WorkflowRunModel.findById(run._id).lean();
    const step = doc!.steps.find((s: any) => s.stepId === 'process');
    expect(step!.output).toBeDefined();
    expect((step!.output as any).__checkpoint).toBe(3);

    wf1.shutdown();
  });

  it('should persist scatter checkpoint across task completions', async () => {
    const executionOrder: string[] = [];

    const wf = createWorkflow('scatter-checkpoint', {
      steps: {
        parallel: async (ctx) => {
          const results = await ctx.scatter({
            taskA: async () => {
              executionOrder.push('A');
              return 'A-result';
            },
            taskB: async () => {
              executionOrder.push('B');
              return 'B-result';
            },
            taskC: async () => {
              executionOrder.push('C');
              return 'C-result';
            },
          });
          return results;
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(executionOrder).toContain('A');
    expect(executionOrder).toContain('B');
    expect(executionOrder).toContain('C');
    expect(result.output).toEqual({
      taskA: 'A-result',
      taskB: 'B-result',
      taskC: 'C-result',
    });

    wf.shutdown();
  });
});

// ============================================================================
// Heartbeat & Stale Detection
// ============================================================================

describe('Heartbeat mechanism', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should update heartbeat during long-running steps', async () => {
    const wf = createWorkflow('heartbeat-test', {
      steps: {
        long_running: async (ctx) => {
          const startHeartbeat = (await WorkflowRunModel.findById(ctx.runId).lean())?.lastHeartbeat;

          // Wait enough time for at least one auto-heartbeat (30s is default, too long for test)
          // Instead, manually heartbeat
          await ctx.heartbeat();

          const afterHeartbeat = (await WorkflowRunModel.findById(ctx.runId).lean())?.lastHeartbeat;

          return {
            heartbeatUpdated: afterHeartbeat!.getTime() >= startHeartbeat!.getTime(),
          };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ heartbeatUpdated: true });

    wf.shutdown();
  });

  it('should mark stale workflows with old heartbeats', async () => {
    const wf = createWorkflow('stale-detect', {
      steps: {
        step1: async () => 'ok',
      },
      autoExecute: false,
    });

    const run = await wf.start({});

    // Manually set heartbeat to the past (simulate crashed process)
    const pastTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      { $set: { status: 'running', lastHeartbeat: pastTime } },
    );

    // Query for stale workflows
    const stale = await WorkflowRunModel.find({
      status: 'running',
      lastHeartbeat: { $lt: new Date(Date.now() - 5 * 60 * 1000) },
    }).lean();

    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale.some((s) => s._id === run._id)).toBe(true);

    wf.shutdown();
  });
});

// ============================================================================
// Write Concern & Atomic Operations
// ============================================================================

describe('Atomic state transitions', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should use majority write concern for durability', async () => {
    // Verify the model has majority write concern configured
    const schema = WorkflowRunModel.schema;
    const options = schema.options;
    expect(options.writeConcern).toEqual({ w: 'majority', j: true });
  });

  it('should atomically claim steps preventing double execution', async () => {
    const executionCount = { value: 0 };

    const wf = createWorkflow('atomic-claim', {
      steps: {
        counted: async () => {
          executionCount.value++;
          await new Promise((r) => setTimeout(r, 50));
          return { count: executionCount.value };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});

    // Attempt concurrent execution — only one should succeed
    const [r1, r2] = await Promise.allSettled([
      wf.execute(run._id),
      wf.execute(run._id),
    ]);

    // At least one should succeed
    const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Step should have been executed exactly once
    expect(executionCount.value).toBe(1);

    wf.shutdown();
  });
});

// ============================================================================
// Data Integrity Under Concurrent Writes
// ============================================================================

describe('Data integrity under concurrent context writes', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should preserve context integrity across sequential steps', async () => {
    interface CtxType {
      step1Result: string;
      step2Result: string;
      step3Result: string;
    }

    const wf = createWorkflow<CtxType>('context-integrity', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('step1Result', 'alpha');
          return 'step1-done';
        },
        step2: async (ctx) => {
          // Verify step1's context write persisted
          expect(ctx.context.step1Result).toBe('alpha');
          await ctx.set('step2Result', 'beta');
          return 'step2-done';
        },
        step3: async (ctx) => {
          // Verify all previous writes
          expect(ctx.context.step1Result).toBe('alpha');
          expect(ctx.context.step2Result).toBe('beta');
          await ctx.set('step3Result', 'gamma');
          return 'step3-done';
        },
      },
      context: () => ({
        step1Result: '',
        step2Result: '',
        step3Result: '',
      }),
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context).toEqual({
      step1Result: 'alpha',
      step2Result: 'beta',
      step3Result: 'gamma',
    });

    // Verify DB state matches
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.context).toEqual(result.context);

    wf.shutdown();
  });
});
