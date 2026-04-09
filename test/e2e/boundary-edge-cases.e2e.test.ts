/**
 * Boundary & Edge Case Tests
 *
 * Tests extreme values, large payloads, unusual configurations,
 * and error boundary behavior.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  WorkflowRunModel,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// Configuration Boundaries
// ============================================================================

describe('Configuration boundary conditions', () => {
  it('should reject workflow with zero steps', () => {
    expect(() =>
      createWorkflow('empty-wf', { steps: {} }),
    ).toThrow('at least one step');
  });

  it('should reject negative retries', () => {
    expect(() =>
      createWorkflow('bad-retries', {
        steps: { a: async () => 1 },
        defaults: { retries: -1 },
      }),
    ).toThrow('non-negative integer');
  });

  it('should reject zero timeout', () => {
    expect(() =>
      createWorkflow('bad-timeout', {
        steps: { a: async () => 1 },
        defaults: { timeout: 0 },
      }),
    ).toThrow('positive integer');
  });

  it('should reject float retries', () => {
    expect(() =>
      createWorkflow('float-retries', {
        steps: { a: async () => 1 },
        defaults: { retries: 2.5 },
      }),
    ).toThrow('non-negative integer');
  });

  it('should accept retries: 1 (single attempt, no retries)', () => {
    const wf = createWorkflow('single-attempt', {
      steps: {
        a: { handler: async () => 'ok', retries: 1 },
      },
      autoExecute: false,
    });
    expect(wf.definition.steps[0].retries).toBe(1);
    wf.shutdown();
  });
});

// ============================================================================
// Large Payloads
// ============================================================================

describe('Large payload handling', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should handle large input and context objects', async () => {
    const largeArray = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      data: 'x'.repeat(100),
    }));

    const wf = createWorkflow<{ items: typeof largeArray }>('large-payload', {
      steps: {
        count: async (ctx) => {
          return { total: ctx.context.items.length };
        },
      },
      context: (input: { items: typeof largeArray }) => ({ items: input.items }),
      autoExecute: false,
    });

    const run = await wf.start({ items: largeArray });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ total: 1000 });

    wf.shutdown();
  });

  it('should handle deeply nested output objects', async () => {
    const wf = createWorkflow('deep-nesting', {
      steps: {
        nest: async () => {
          let obj: any = { value: 'leaf' };
          for (let i = 0; i < 20; i++) {
            obj = { child: obj };
          }
          return obj;
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');

    // Navigate to the leaf
    let node: any = result.output;
    for (let i = 0; i < 20; i++) {
      node = node.child;
    }
    expect(node.value).toBe('leaf');

    wf.shutdown();
  });
});

// ============================================================================
// Error Handling Boundaries
// ============================================================================

describe('Error handling edge cases', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should handle step throwing non-Error objects', async () => {
    const wf = createWorkflow('throw-string', {
      steps: {
        bad: {
          handler: async () => {
            throw 'string error'; // Not an Error instance
          },
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');

    wf.shutdown();
  });

  it('should handle step throwing null', async () => {
    const wf = createWorkflow('throw-null', {
      steps: {
        bad: {
          handler: async () => {
            throw null;
          },
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');

    wf.shutdown();
  });

  it('should handle synchronous throw in async handler', async () => {
    const wf = createWorkflow('sync-throw', {
      steps: {
        bad: {
          handler: async () => {
            JSON.parse('{{invalid json}}'); // Synchronous throw inside async
            return 'unreachable';
          },
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].error?.message).toBeDefined();

    wf.shutdown();
  });

  it('should mark non-retriable errors as immediately failed', async () => {
    let attempts = 0;

    const wf = createWorkflow('non-retriable', {
      steps: {
        fatal: {
          handler: async () => {
            attempts++;
            const err = new Error('Fatal: bad credentials');
            (err as any).retriable = false; // Explicitly non-retriable
            throw err;
          },
          retries: 5, // Has retries, but error says no
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(1); // Should NOT retry

    wf.shutdown();
  });
});

// ============================================================================
// Step Timeout Behavior
// ============================================================================

describe('Step timeout behavior', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should timeout a step that exceeds configured duration', async () => {
    const wf = createWorkflow('timeout-test', {
      steps: {
        slow: {
          handler: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return 'too-late';
          },
          timeout: 100, // 100ms timeout
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].error?.message).toContain('timeout');

    wf.shutdown();
  });

  it('should not timeout a step that completes within duration', async () => {
    const wf = createWorkflow('fast-enough', {
      steps: {
        quick: {
          handler: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return 'on-time';
          },
          timeout: 5000,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toBe('on-time');

    wf.shutdown();
  });
});

// ============================================================================
// Output Chaining (getOutput)
// ============================================================================

describe('Step output chaining', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should chain outputs across 5 sequential steps', async () => {
    const wf = createWorkflow('output-chain', {
      steps: {
        s1: async () => ({ n: 1 }),
        s2: async (ctx) => ({ n: ctx.getOutput<{ n: number }>('s1')!.n + 1 }),
        s3: async (ctx) => ({ n: ctx.getOutput<{ n: number }>('s2')!.n + 1 }),
        s4: async (ctx) => ({ n: ctx.getOutput<{ n: number }>('s3')!.n + 1 }),
        s5: async (ctx) => ({ n: ctx.getOutput<{ n: number }>('s4')!.n + 1 }),
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ n: 5 });

    wf.shutdown();
  });

  it('should return undefined for non-existent step output', async () => {
    const wf = createWorkflow('output-missing', {
      steps: {
        check: async (ctx) => {
          const missing = ctx.getOutput('nonexistent-step');
          return { missing: missing === undefined };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.output).toEqual({ missing: true });

    wf.shutdown();
  });
});

// ============================================================================
// Conditional Execution Edge Cases
// ============================================================================

describe('Conditional execution edge cases', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should skip all middle steps and still complete', async () => {
    const wf = createWorkflow<{ mode: string }>('skip-all-middle', {
      steps: {
        start: async () => ({ started: true }),
        skip1: { handler: async () => 'skipped', skipIf: () => true },
        skip2: { handler: async () => 'skipped', skipIf: () => true },
        skip3: { handler: async () => 'skipped', skipIf: () => true },
        finish: async () => ({ finished: true }),
      },
      context: (input: { mode: string }) => ({ mode: input.mode }),
      autoExecute: false,
    });

    const run = await wf.start({ mode: 'minimal' });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');

    const skipped = result.steps.filter((s) => s.status === 'skipped');
    expect(skipped).toHaveLength(3);

    const done = result.steps.filter((s) => s.status === 'done');
    expect(done).toHaveLength(2); // start + finish

    wf.shutdown();
  });

  it('should support runIf condition based on context', async () => {
    interface FeatureCtx {
      isPremium: boolean;
    }

    const wf = createWorkflow<FeatureCtx>('runif-test', {
      steps: {
        basic: async () => ({ tier: 'basic' }),
        premium_feature: {
          handler: async () => ({ tier: 'premium' }),
          runIf: (ctx) => ctx.isPremium,
        },
        done: async () => ({ complete: true }),
      },
      context: (input: { isPremium: boolean }) => ({ isPremium: input.isPremium }),
      autoExecute: false,
    });

    // Non-premium user — should skip premium step
    const run1 = await wf.start({ isPremium: false });
    const result1 = await wf.execute(run1._id);
    expect(result1.steps.find((s) => s.stepId === 'premium_feature')?.status).toBe('skipped');

    await cleanupTestDB();

    // Premium user — should run premium step
    const run2 = await wf.start({ isPremium: true });
    const result2 = await wf.execute(run2._id);
    expect(result2.steps.find((s) => s.stepId === 'premium_feature')?.status).toBe('done');

    wf.shutdown();
  });
});
