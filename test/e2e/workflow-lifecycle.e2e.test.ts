/**
 * Comprehensive E2E tests for workflow lifecycle.
 *
 * Covers critical gaps: cancel, rewind, heartbeat, hooks,
 * per-step config execution, scheduler concurrency, and multi-step scenarios.
 */

import { describe, expect, it } from 'vitest';
import { createHook, createWorkflow, resumeHook, type Workflow } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** `getOutput` is optional by type; these tests' steps always produced it. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing output: ${what}`);
  return value;
}

// ============================================================================
// Cancel Workflow
// ============================================================================

describe('Cancel workflow', () => {
  it('should cancel a running workflow and mark it cancelled', async () => {
    const workflow = env.workflow('cancel-test', {
      steps: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return 'should not reach';
        },
      },
    });

    const run = await workflow.start({});
    // Don't await execute — start it and cancel immediately
    const executePromise = workflow.execute(run._id).catch(() => {});

    // Wait until execute has actually started the step
    await env.until(run._id, (r) => r.steps[0]?.status === 'running');

    const cancelled = await workflow.cancel(run._id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.endedAt).toBeInstanceOf(Date);

    await executePromise;
  });

  it('should prevent resuming a cancelled workflow', async () => {
    const workflow = env.workflow('cancel-no-resume', {
      steps: {
        waitStep: async (ctx) => ctx.wait('test'),
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Should be waiting
    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');

    // Cancel
    await workflow.cancel(run._id);

    // Resume should fail
    await expect(workflow.resume(run._id, { data: 'test' })).rejects.toThrow();
  });

  it('should cancel without error on already-done workflow', async () => {
    const workflow = env.workflow('cancel-done', {
      steps: {
        quick: async () => 'done',
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const done = await workflow.get(run._id);
    expect(done?.status).toBe('done');

    // Cancel a completed workflow — idempotent NO-OP as of 2.7.0: the run
    // is returned UNCHANGED (still 'done'). Pre-2.7 this overwrote the
    // terminal status with 'cancelled' — an illegal RUN_MACHINE transition
    // that retroactively falsified a completed outcome.
    const result = await workflow.cancel(run._id);
    expect(result.status).toBe('done');

    const persisted = await workflow.get(run._id);
    expect(persisted?.status).toBe('done');
  });
});

// ============================================================================
// Rewind Workflow
// ============================================================================

describe('Rewind workflow', () => {
  it('should rewind to a previous step and re-execute', async () => {
    let step2Count = 0;

    const workflow = env.workflow<{ value: number }>('rewind-test', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('value', 10);
          return 'step1-done';
        },
        step2: async () => {
          step2Count++;
          return { count: step2Count };
        },
        step3: async () => {
          return 'final';
        },
      },
      context: () => ({ value: 0 }),
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const done = await workflow.get(run._id);
    expect(done?.status).toBe('done');
    expect(step2Count).toBe(1);

    // Rewind to step2
    const rewound = await workflow.rewindTo(run._id, 'step2');
    expect(rewound.status).toBe('running');
    expect(rewound.currentStepId).toBe('step2');
    expect(rewound.steps[0].status).toBe('done'); // step1 kept
    expect(rewound.steps[1].status).toBe('pending'); // step2 reset
    expect(rewound.steps[2].status).toBe('pending'); // step3 reset

    // Re-execute from step2
    const reExecuted = await workflow.execute(rewound._id);
    expect(reExecuted.status).toBe('done');
    expect(step2Count).toBe(2); // step2 ran again
  });

  it('should rewind to the first step and reset everything', async () => {
    const workflow = env.workflow<{ result: number }>('rewind-first', {
      steps: {
        init: async (ctx) => {
          await ctx.set('result', 42);
          return 'init-done';
        },
        process: async (ctx) => {
          return ctx.context.result;
        },
      },
      context: () => ({ result: 0 }),
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Rewind to first step
    const rewound = await workflow.rewindTo(run._id, 'init');
    expect(rewound.currentStepId).toBe('init');
    expect(rewound.steps.every((s) => s.status === 'pending')).toBe(true);
  });
});

// ============================================================================
// Hooks (createHook / resumeHook)
// ============================================================================

describe('Hook-based resume', () => {
  it('should create a hook, pause, and resume via token', async () => {
    let hookToken: string | undefined;

    const workflow = env.workflow<{ approved?: boolean }>('hook-test', {
      steps: {
        requestApproval: async (ctx) => {
          const hook = createHook(ctx, 'awaiting-approval');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
        processApproval: async (ctx) => {
          const approval = required(
            ctx.getOutput<{ approved: boolean }>('requestApproval'),
            'requestApproval',
          );
          await ctx.set('approved', approval.approved);
          return { processed: true };
        },
      },
      context: () => ({}),
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Should be waiting
    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
    expect(hookToken).toBeDefined();

    // Resume via hook token
    const result = await resumeHook(required(hookToken, 'hookToken'), { approved: true });
    expect(result.runId).toBe(run._id);

    // Wait for completion
    await env.until(run._id, 'done');

    const completed = await workflow.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.approved).toBe(true);
  });

  it('should reject invalid hook tokens', async () => {
    // With durable DB fallback, resumeHook tries DB when engine not in registry.
    // Non-existent workflow → "Workflow not found". The fallback resolves
    // through the env's container (never the default-connection singleton).
    await expect(
      resumeHook('nonexistent:step:random', {}, { container: env.container }),
    ).rejects.toThrow(/not found/);
  });

  it('should generate secure tokens with crypto random suffix', async () => {
    const workflow = env.workflow('hook-token-test', {
      steps: {
        wait: async (ctx) => {
          const hook = createHook(ctx, 'test');
          // Token format: runId:stepId:randomHex
          const parts = hook.token.split(':');
          expect(parts.length).toBe(3);
          expect(parts[2].length).toBe(32); // 16 bytes = 32 hex chars
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
  });
});

// ============================================================================
// Per-Step Config E2E (actual execution with failures)
// ============================================================================

describe('StepConfig per-step retries E2E', () => {
  it('should retry fragile step only once then fail, while resilient step retries more', async () => {
    let fragileAttempts = 0;

    const workflow = env.workflow('step-retries-e2e', {
      steps: {
        fragile: {
          handler: async () => {
            fragileAttempts++;
            throw new Error(`Fragile failure #${fragileAttempts}`);
          },
          retries: 1, // Only 1 attempt total — fails immediately
        },
      },
      context: () => ({}),
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(fragileAttempts).toBe(1);
  });

  it('should apply different retries per step in same workflow', async () => {
    let step1Attempts = 0;
    let step2Attempts = 0;

    const workflow = env.workflow('mixed-retries-e2e', {
      steps: {
        step1: {
          handler: async () => {
            step1Attempts++;
            if (step1Attempts < 3) throw new Error('not yet');
            return 'ok';
          },
          retries: 5, // Enough room to succeed on attempt 3
        },
        step2: {
          handler: async () => {
            step2Attempts++;
            throw new Error('always fails');
          },
          retries: 2, // Only 2 attempts
        },
      },
      context: () => ({}),
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    // step1 should succeed after retries, step2 should fail
    expect(step1Attempts).toBe(3);
    expect(step2Attempts).toBe(2);
    expect(result.status).toBe('failed');

    const step1State = result.steps.find((s) => s.stepId === 'step1');
    const step2State = result.steps.find((s) => s.stepId === 'step2');
    expect(step1State?.status).toBe('done');
    expect(step2State?.status).toBe('failed');
  });

  it('should skipIf via StepConfig during execution', async () => {
    interface Ctx {
      premium: boolean;
      results: string[];
    }

    const workflow = env.workflow<Ctx, { premium: boolean }>('skipif-e2e', {
      steps: {
        basic: async (ctx) => {
          ctx.context.results.push('basic');
          return 'ok';
        },
        premiumFeature: {
          handler: async (ctx) => {
            ctx.context.results.push('premium');
            return 'ok';
          },
          skipIf: (ctx) => !ctx.premium,
        },
        finish: async (ctx) => {
          ctx.context.results.push('finish');
          return 'ok';
        },
      },
      context: (input) => ({ premium: input.premium, results: [] as string[] }),
    });

    // Free user — premium skipped
    const free = await workflow.start({ premium: false });
    const freeResult = await workflow.execute(free._id);
    expect(freeResult.status).toBe('done');
    expect(freeResult.context.results).toEqual(['basic', 'finish']);

    // Premium user — all steps run
    const pro = await workflow.start({ premium: true });
    const proResult = await workflow.execute(pro._id);
    expect(proResult.status).toBe('done');
    expect(proResult.context.results).toEqual(['basic', 'premium', 'finish']);
  });
});

// ============================================================================
// Heartbeat in Long-Running Steps
// ============================================================================

describe('Heartbeat mechanism', () => {
  it('should auto-send heartbeats during step execution', async () => {
    const workflow = env.workflow('heartbeat-test', {
      steps: {
        longStep: async () => {
          // Simulate work for 2 seconds (the long step IS the subject)
          await new Promise((r) => setTimeout(r, 2000));
          return 'done';
        },
      },
    });

    const run = await workflow.start({});

    await workflow.execute(run._id);

    const completed = await workflow.get(run._id);
    expect(completed?.status).toBe('done');
    // lastHeartbeat should have been updated during execution
    expect(completed?.lastHeartbeat).toBeInstanceOf(Date);
  });

  it('should allow manual heartbeat calls', async () => {
    const workflow = env.workflow('manual-heartbeat', {
      steps: {
        batchWork: async (ctx) => {
          for (let i = 0; i < 3; i++) {
            await ctx.heartbeat();
            await new Promise((r) => setTimeout(r, 100));
          }
          return 'done';
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);
    expect(result.status).toBe('done');
  });
});

// ============================================================================
// Pause + Resume combinations
// ============================================================================

describe('Pause and resume', () => {
  it('should pause a waiting workflow and resume it later', async () => {
    const workflow = env.workflow('pause-waiting', {
      steps: {
        work: async (ctx) => {
          return ctx.wait('Need approval');
        },
        after: async () => 'done',
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');

    // Pause
    const paused = await workflow.pause(run._id);
    expect(paused.paused).toBe(true);

    // Resume (should clear paused flag and continue)
    await workflow.resume(run._id, { approved: true });

    await env.until(run._id, 'done');

    const done = await workflow.get(run._id);
    expect(done?.status).toBe('done');
    expect(done?.paused).toBeFalsy();
  });

  it('should be idempotent — pausing twice is a no-op', async () => {
    const workflow = env.workflow('pause-idempotent', {
      steps: {
        work: async (ctx) => ctx.wait('test'),
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const first = await workflow.pause(run._id);
    const second = await workflow.pause(run._id);

    expect(first.paused).toBe(true);
    expect(second.paused).toBe(true);
  });
});

// ============================================================================
// Workflow type export (TS4023 regression guard)
// ============================================================================

describe('Workflow type export', () => {
  it('should allow exporting workflow instances with Workflow type annotation', () => {
    // This test guards against TS4023 regression.
    // If Workflow type is not exported, TypeScript compilation fails.
    // Deliberately `createWorkflow` (its return type is the subject); no run
    // is ever started, so the fixed id cannot collide.
    const wf: Workflow<{ n: number }> = createWorkflow<{ n: number }>('type-export-guard', {
      steps: {
        step1: async (ctx) => ctx.context.n * 2,
      },
      context: () => ({ n: 1 }),
      container: env.container,
      autoExecute: false,
    });

    try {
      expect(wf.definition.id).toBe('type-export-guard');
    } finally {
      wf.shutdown();
    }
  });
});

// ============================================================================
// Multi-step real-world scenario
// ============================================================================

describe('Real-world: order processing pipeline', () => {
  it('should process an order through validate → charge → fulfill → notify', async () => {
    interface OrderCtx {
      orderId: string;
      email: string;
      amount: number;
      chargeId?: string;
      trackingNumber?: string;
      notified: boolean;
    }

    const workflow = env.workflow<OrderCtx, { orderId: string; email: string; amount: number }>(
      'order-pipeline',
      {
        steps: {
          validate: async (ctx) => {
            if (ctx.context.amount <= 0) throw new Error('Invalid amount');
            return { valid: true };
          },
          charge: {
            handler: async (ctx) => {
              await ctx.set('chargeId', `ch_${ctx.context.orderId}`);
              return { chargeId: `ch_${ctx.context.orderId}` };
            },
            timeout: 30_000,
            retries: 3,
          },
          fulfill: {
            handler: async (ctx) => {
              const tracking = `TRK-${Date.now()}`;
              await ctx.set('trackingNumber', tracking);
              return { trackingNumber: tracking };
            },
            timeout: 60_000,
          },
          notify: async (ctx) => {
            await ctx.set('notified', true);
            return { email: ctx.context.email, sent: true };
          },
        },
        context: (input) => ({
          orderId: input.orderId,
          email: input.email,
          amount: input.amount,
          notified: false,
        }),
      },
    );

    const run = await workflow.start({
      orderId: 'ORD-001',
      email: 'customer@example.com',
      amount: 99.99,
    });

    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.chargeId).toBe('ch_ORD-001');
    expect(result.context.trackingNumber).toBeDefined();
    expect(result.context.notified).toBe(true);
    expect(result.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('should fail the pipeline if charge step fails after retries', async () => {
    let attempts = 0;

    const workflow = env.workflow('order-charge-fail', {
      steps: {
        validate: async () => ({ valid: true }),
        charge: {
          handler: async () => {
            attempts++;
            throw new Error('Payment gateway down');
          },
          retries: 2,
        },
        fulfill: async () => 'should not reach',
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(2);

    // validate should be done, charge should be failed, fulfill should be pending
    expect(result.steps[0].status).toBe('done');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('pending');
  });
});

// ============================================================================
// getOutput between steps
// ============================================================================

describe('Step output chaining', () => {
  it('should pass output from one step to the next via getOutput', async () => {
    const workflow = env.workflow('output-chain', {
      steps: {
        generate: async () => ({ id: 'user-123', name: 'Alice' }),
        transform: async (ctx) => {
          const user = required(
            ctx.getOutput<{ id: string; name: string }>('generate'),
            'generate',
          );
          return { greeting: `Hello, ${user.name}!`, userId: user.id };
        },
        finalize: async (ctx) => {
          const data = required(ctx.getOutput<{ greeting: string }>('transform'), 'transform');
          return { message: data.greeting };
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ message: 'Hello, Alice!' });
  });
});

// ============================================================================
// waitFor (poll-based completion waiting)
// ============================================================================

describe('Workflow.waitFor()', () => {
  it('should wait for workflow to complete', async () => {
    // start() executing by itself is what waitFor() waits on.
    const workflow = env.workflow('waitfor-test', {
      steps: {
        step1: async () => 'done',
      },
      autoExecute: true,
    });

    const run = await workflow.start({});
    const completed = await workflow.waitFor(run._id, { timeout: 5000 });

    expect(completed.status).toBe('done');
  });

  it('should timeout if workflow does not complete', async () => {
    const workflow = env.workflow('waitfor-timeout', {
      steps: {
        hang: async (ctx) => ctx.wait('forever'),
      },
      autoExecute: true,
    });

    const run = await workflow.start({});

    await expect(workflow.waitFor(run._id, { timeout: 500, pollInterval: 100 })).rejects.toThrow(
      /Timeout/,
    );
  });
});
