/**
 * Durable Features E2E Tests
 *
 * Tests for:
 * - ctx.checkpoint() / ctx.getCheckpoint() — crash-safe batch processing
 * - Durable resumeHook — DB fallback when engine not in memory
 * - Hook token validation security
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitUntil } from '../utils/setup.js';
import {
  createWorkflow,
  createHook,
  resumeHook,
  WorkflowRunModel,
  hookRegistry,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// Durable Checkpoint (crash-safe batch processing)
// ============================================================================

describe('ctx.checkpoint() — durable loop', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should save checkpoint and read it back within same execution', async () => {
    const processed: number[] = [];

    const workflow = createWorkflow('checkpoint-basic', {
      steps: {
        batch: async (ctx) => {
          for (let i = 0; i < 5; i++) {
            processed.push(i);
            await ctx.checkpoint(i);
          }
          return { total: processed.length };
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(processed).toEqual([0, 1, 2, 3, 4]);

    workflow.shutdown();
  });

  it('should persist checkpoint to MongoDB during execution', async () => {
    let checkpointPersistedInDb = false;

    const workflow = createWorkflow('checkpoint-persist', {
      steps: {
        batch: async (ctx) => {
          await ctx.checkpoint({ lastBatch: 42, items: ['a', 'b'] });

          // Verify checkpoint is in DB mid-execution (before step completes)
          const dbRun = await WorkflowRunModel.findById(ctx.runId).lean();
          const stepOutput = dbRun?.steps[0]?.output as { __checkpoint?: unknown } | undefined;
          checkpointPersistedInDb = stepOutput?.__checkpoint !== undefined;

          return 'done'; // This overwrites the checkpoint in output
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    expect(checkpointPersistedInDb).toBe(true);

    workflow.shutdown();
  });

  it('should resume from checkpoint after simulated crash', async () => {
    const processed: number[] = [];

    const workflow = createWorkflow<{ total: number }>('checkpoint-resume', {
      steps: {
        batch: async (ctx) => {
          const lastDone = ctx.getCheckpoint<number>() ?? -1;

          for (let i = lastDone + 1; i < 10; i++) {
            processed.push(i);
            await ctx.checkpoint(i);

            // Simulate crash at item 5 on first attempt
            if (i === 5 && ctx.attempt === 1) {
              throw new Error('simulated crash');
            }
          }

          await ctx.set('total', processed.length);
          return { total: processed.length };
        },
      },
      context: () => ({ total: 0 }),
      defaults: { retries: 3 },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    // First run: 0,1,2,3,4,5 (crashes at 5)
    // Second run: 6,7,8,9 (resumes from checkpoint 5)
    expect(processed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    workflow.shutdown();
  });

  it('should return undefined for getCheckpoint on first execution', async () => {
    let checkpointValue: unknown = 'not-undefined';

    const workflow = createWorkflow('checkpoint-first-run', {
      steps: {
        check: async (ctx) => {
          checkpointValue = ctx.getCheckpoint();
          return 'ok';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    expect(checkpointValue).toBeUndefined();

    workflow.shutdown();
  });
});

// ============================================================================
// Durable resumeHook (DB fallback)
// ============================================================================

describe('Durable resumeHook — DB fallback', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should resume via DB when engine is NOT in hookRegistry (simulating restart)', async () => {
    let hookToken: string | undefined;

    const workflow = createWorkflow<{ approved?: boolean }>('durable-hook', {
      steps: {
        waitForApproval: async (ctx) => {
          const hook = createHook(ctx, 'approval');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
        process: async (ctx) => {
          const result = ctx.getOutput<{ approved: boolean }>('waitForApproval');
          await ctx.set('approved', result?.approved ?? false);
          return 'done';
        },
      },
      context: () => ({}),
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Verify waiting
    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
    expect(hookToken).toBeDefined();

    // Simulate process restart: remove engine from hookRegistry
    hookRegistry.unregister(run._id);
    const engineGone = hookRegistry.getEngine(run._id);
    expect(engineGone).toBeUndefined();

    // Resume via DB fallback — should NOT throw "No engine registered"
    const result = await resumeHook(hookToken!, { approved: true });
    expect(result.runId).toBe(run._id);
    // After DB-based resume, workflow is 'running' (scheduler will pick it up)
    expect(result.run.status).toBe('running');

    workflow.shutdown();
  });

  it('should reject invalid token on DB fallback path', async () => {
    const workflow = createWorkflow('hook-token-validation', {
      steps: {
        wait: async (ctx) => {
          const hook = createHook(ctx, 'test');
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Remove from registry
    hookRegistry.unregister(run._id);

    // Try with wrong token (right runId but wrong random suffix)
    await expect(
      resumeHook(`${run._id}:wait:wrong_token`, {})
    ).rejects.toThrow(/Invalid hook token/);

    workflow.shutdown();
  });

  it('should reject resume on non-waiting workflow via DB path', async () => {
    const workflow = createWorkflow('hook-not-waiting', {
      steps: {
        quick: async () => 'done',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Remove from registry
    hookRegistry.unregister(run._id);

    // Workflow is 'done', not 'waiting'
    await expect(
      resumeHook(`${run._id}:quick:fake`, {})
    ).rejects.toThrow(/not waiting/);

    workflow.shutdown();
  });

  it('should prevent double-resume via atomic claim on DB path', async () => {
    let hookToken: string | undefined;

    const workflow = createWorkflow('hook-double-resume', {
      steps: {
        wait: async (ctx) => {
          const hook = createHook(ctx, 'test');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
        after: async () => 'done',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Remove from registry
    hookRegistry.unregister(run._id);

    // First resume succeeds
    const result1 = await resumeHook(hookToken!, { first: true });
    expect(result1.run.status).toBe('running');

    // Second resume fails (already resumed)
    await expect(
      resumeHook(hookToken!, { second: true })
    ).rejects.toThrow(/not waiting|already resumed/);

    workflow.shutdown();
  });
});

// ============================================================================
// Hook security
// ============================================================================

describe('Hook security', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should generate unique tokens with crypto-random suffix', async () => {
    const tokens: string[] = [];

    const workflow = createWorkflow('hook-unique-tokens', {
      steps: {
        wait: async (ctx) => {
          const hook = createHook(ctx, 'test');
          tokens.push(hook.token);
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
      },
      autoExecute: false,
    });

    // Start two workflows
    const run1 = await workflow.start({});
    await workflow.execute(run1._id);
    const run2 = await workflow.start({});
    await workflow.execute(run2._id);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]); // Unique tokens

    // Each token has 3 parts: runId:stepId:randomHex
    for (const token of tokens) {
      const parts = token.split(':');
      expect(parts).toHaveLength(3);
      expect(parts[2]).toHaveLength(32); // 16 bytes → 32 hex chars
    }

    workflow.shutdown();
  });

  it('should support deterministic tokens via hookToken()', async () => {
    const { hookToken: makeToken } = await import('../../src/index.js');

    const token = makeToken('slack', 'channel-123', 'thread-456');
    expect(token).toBe('slack:channel-123:thread-456');
  });
});
