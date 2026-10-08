/**
 * Boundary & Edge Case Tests
 *
 * Tests extreme values, large payloads, unusual configurations,
 * and error boundary behavior.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// ============================================================================
// Configuration Boundaries
// ============================================================================

describe('Configuration boundary conditions', () => {
  it('should reject workflow with zero steps', () => {
    expect(() => env.workflow('empty-wf', { steps: {} })).toThrow('at least one step');
  });

  it('should reject negative retries', () => {
    expect(() =>
      env.workflow('bad-retries', {
        steps: { a: async () => 1 },
        defaults: { retries: -1 },
      }),
    ).toThrow('non-negative integer');
  });

  it('should reject zero timeout', () => {
    expect(() =>
      env.workflow('bad-timeout', {
        steps: { a: async () => 1 },
        defaults: { timeout: 0 },
      }),
    ).toThrow('positive integer');
  });

  it('should reject float retries', () => {
    expect(() =>
      env.workflow('float-retries', {
        steps: { a: async () => 1 },
        defaults: { retries: 2.5 },
      }),
    ).toThrow('non-negative integer');
  });

  it('should accept retries: 1 (single attempt, no retries)', () => {
    const wf = env.workflow('single-attempt', {
      steps: {
        a: { handler: async () => 'ok', retries: 1 },
      },
    });
    expect(wf.definition.steps[0]?.retries).toBe(1);
  });
});

// ============================================================================
// Large Payloads
// ============================================================================

describe('Large payload handling', () => {
  it('should handle large input and context objects', async () => {
    const largeArray = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      data: 'x'.repeat(100),
    }));

    const wf = env.workflow<{ items: typeof largeArray }, { items: typeof largeArray }>(
      'large-payload',
      {
        steps: {
          count: async (ctx) => {
            return { total: ctx.context.items.length };
          },
        },
        context: (input) => ({ items: input.items }),
      },
    );

    const run = await wf.start({ items: largeArray });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ total: 1000 });
  });

  it('should handle deeply nested output objects', async () => {
    type Nested = { value?: string; child?: Nested };

    const wf = env.workflow('deep-nesting', {
      steps: {
        nest: async () => {
          let obj: Nested = { value: 'leaf' };
          for (let i = 0; i < 20; i++) {
            obj = { child: obj };
          }
          return obj;
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');

    // Navigate to the leaf
    let node = result.output as Nested | undefined;
    for (let i = 0; i < 20; i++) {
      node = node?.child;
    }
    expect(node?.value).toBe('leaf');
  });
});

// ============================================================================
// Error Handling Boundaries
// ============================================================================

describe('Error handling edge cases', () => {
  it('should handle step throwing non-Error objects', async () => {
    const wf = env.workflow('throw-string', {
      steps: {
        bad: {
          handler: async () => {
            throw 'string error'; // Not an Error instance
          },
          retries: 1,
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
  });

  it('should handle step throwing null', async () => {
    const wf = env.workflow('throw-null', {
      steps: {
        bad: {
          handler: async () => {
            throw null;
          },
          retries: 1,
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
  });

  it('should handle synchronous throw in async handler', async () => {
    const wf = env.workflow('sync-throw', {
      steps: {
        bad: {
          handler: async () => {
            JSON.parse('{{invalid json}}'); // Synchronous throw inside async
            return 'unreachable';
          },
          retries: 1,
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toBeDefined();
  });

  it('should mark non-retriable errors as immediately failed', async () => {
    let attempts = 0;

    const wf = env.workflow('non-retriable', {
      steps: {
        fatal: {
          handler: async () => {
            attempts++;
            // Explicitly non-retriable
            throw Object.assign(new Error('Fatal: bad credentials'), { retriable: false });
          },
          retries: 5, // Has retries, but error says no
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(1); // Should NOT retry
  });
});

// ============================================================================
// Step Timeout Behavior
// ============================================================================

describe('Step timeout behavior', () => {
  it('should timeout a step that exceeds configured duration', async () => {
    const wf = env.workflow('timeout-test', {
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
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('timeout');
  });

  it('should not timeout a step that completes within duration', async () => {
    const wf = env.workflow('fast-enough', {
      steps: {
        quick: {
          handler: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return 'on-time';
          },
          timeout: 5000,
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toBe('on-time');
  });
});

// ============================================================================
// Output Chaining (getOutput)
// ============================================================================

describe('Step output chaining', () => {
  it('should chain outputs across 5 sequential steps', async () => {
    const next = (out: { n: number } | undefined) => ({ n: (out?.n ?? Number.NaN) + 1 });
    const wf = env.workflow('output-chain', {
      steps: {
        s1: async () => ({ n: 1 }),
        s2: async (ctx) => next(ctx.getOutput<{ n: number }>('s1')),
        s3: async (ctx) => next(ctx.getOutput<{ n: number }>('s2')),
        s4: async (ctx) => next(ctx.getOutput<{ n: number }>('s3')),
        s5: async (ctx) => next(ctx.getOutput<{ n: number }>('s4')),
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ n: 5 });
  });

  it('should return undefined for non-existent step output', async () => {
    const wf = env.workflow('output-missing', {
      steps: {
        check: async (ctx) => {
          const missing = ctx.getOutput('nonexistent-step');
          return { missing: missing === undefined };
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.output).toEqual({ missing: true });
  });
});

// ============================================================================
// Conditional Execution Edge Cases
// ============================================================================

describe('Conditional execution edge cases', () => {
  it('should skip all middle steps and still complete', async () => {
    const wf = env.workflow<{ mode: string }, { mode: string }>('skip-all-middle', {
      steps: {
        start: async () => ({ started: true }),
        skip1: { handler: async () => 'skipped', skipIf: () => true },
        skip2: { handler: async () => 'skipped', skipIf: () => true },
        skip3: { handler: async () => 'skipped', skipIf: () => true },
        finish: async () => ({ finished: true }),
      },
      context: (input) => ({ mode: input.mode }),
    });

    const run = await wf.start({ mode: 'minimal' });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');

    const skipped = result.steps.filter((s) => s.status === 'skipped');
    expect(skipped).toHaveLength(3);

    const done = result.steps.filter((s) => s.status === 'done');
    expect(done).toHaveLength(2); // start + finish
  });

  it('should support runIf condition based on context', async () => {
    interface FeatureCtx {
      isPremium: boolean;
    }

    const wf = env.workflow<FeatureCtx, { isPremium: boolean }>('runif-test', {
      steps: {
        basic: async () => ({ tier: 'basic' }),
        premium_feature: {
          handler: async () => ({ tier: 'premium' }),
          runIf: (ctx) => ctx.isPremium,
        },
        done: async () => ({ complete: true }),
      },
      context: (input) => ({ isPremium: input.isPremium }),
    });

    // Non-premium user — should skip premium step
    const run1 = await wf.start({ isPremium: false });
    const result1 = await wf.execute(run1._id);
    expect(result1.steps.find((s) => s.stepId === 'premium_feature')?.status).toBe('skipped');

    // Empty the runs (not `env.clear()` — that would shut this workflow down).
    await env.runModel.deleteMany({});

    // Premium user — should run premium step
    const run2 = await wf.start({ isPremium: true });
    const result2 = await wf.execute(run2._id);
    expect(result2.steps.find((s) => s.stepId === 'premium_feature')?.status).toBe('done');
  });
});
