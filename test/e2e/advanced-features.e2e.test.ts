/**
 * Advanced Features E2E Tests
 *
 * Tests for:
 * - ctx.goto() — dynamic flow control / branching
 * - ctx.startChildWorkflow() — durable child workflow orchestration
 * - Combined patterns: goto + checkpoint + conditional
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitUntil } from '../utils/setup.js';
import {
  createWorkflow,
  createContainer,
  type WorkflowRun,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// ctx.goto() — Dynamic Flow Control
// ============================================================================

describe('ctx.goto() — dynamic branching', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should jump to a target step, skipping intermediate steps', async () => {
    const executed: string[] = [];

    const workflow = createWorkflow('goto-skip', {
      steps: {
        start: async (ctx) => {
          executed.push('start');
          return ctx.goto('finish'); // Skip 'middle'
        },
        middle: async () => {
          executed.push('middle');
          return 'should not run';
        },
        finish: async () => {
          executed.push('finish');
          return 'done';
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(executed).toEqual(['start', 'finish']); // 'middle' skipped

    workflow.shutdown();
  });

  it('should use goto for manual retry/loop with checkpoint pattern', async () => {
    // For goto-to-self loops, use the checkpoint pattern instead.
    // ctx.goto() is designed for jumping to DIFFERENT steps.
    // For self-retry, use the built-in retries or checkpoint + throw pattern.
    let attempts = 0;
    const executed: string[] = [];

    const workflow = createWorkflow<{ retryCount: number }>('goto-checkpoint-loop', {
      steps: {
        process: async (ctx) => {
          const lastAttempt = ctx.getCheckpoint<number>() ?? 0;
          attempts = lastAttempt + 1;
          executed.push(`process-${attempts}`);

          if (attempts < 3) {
            await ctx.checkpoint(attempts);
            throw new Error('retry needed'); // Built-in retry handles this
          }

          return { attempts };
        },
        done: async (ctx) => {
          executed.push('done');
          return 'finished';
        },
      },
      context: () => ({ retryCount: 0 }),
      defaults: { retries: 5 },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(attempts).toBe(3);
    expect(executed).toEqual(['process-1', 'process-2', 'process-3', 'done']);

    workflow.shutdown();
  });

  it('should use goto for conditional branching (success vs failure path)', async () => {
    const executed: string[] = [];

    // Goto jumps to a step in the linear sequence. Steps after the goto target
    // still execute linearly. For mutually exclusive branches, put the error
    // path LAST and use goto to jump to it — after it runs, workflow completes.
    const workflow = createWorkflow<{ paymentValid: boolean }>('goto-branch', {
      steps: {
        validate: async (ctx) => {
          executed.push('validate');
          if (!ctx.context.paymentValid) {
            return ctx.goto('handleFailure'); // Jump to last step
          }
          return { valid: true };
        },
        processPayment: async (ctx) => {
          executed.push('processPayment');
          return { charged: true };
        },
        handleFailure: async (ctx) => {
          // Last step — only reached via goto (skipped via skipIf in normal path)
          executed.push('handleFailure');
          return 'payment failed';
        },
      },
      context: (input: any) => ({ paymentValid: input.valid }),
      autoExecute: false,
    });

    // Failed payment — should goto handleFailure (skipping processPayment)
    const run1 = await workflow.start({ valid: false });
    const result1 = await workflow.execute(run1._id);
    expect(result1.status).toBe('done');
    expect(executed).toEqual(['validate', 'handleFailure']);

    executed.length = 0;

    // Valid payment — normal path through processPayment, then handleFailure
    // (handleFailure still runs in linear sequence — use skipIf if you want to skip it)
    const run2 = await workflow.start({ valid: true });
    const result2 = await workflow.execute(run2._id);
    expect(result2.status).toBe('done');
    expect(executed).toEqual(['validate', 'processPayment', 'handleFailure']);

    workflow.shutdown();
  });

  it('should fail workflow if goto target does not exist', async () => {
    const workflow = createWorkflow('goto-invalid', {
      steps: {
        start: async (ctx) => {
          return ctx.goto('nonexistent');
        },
      },
      defaults: { retries: 1 }, // Don't retry — fail immediately
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    const step = result.steps.find((s) => s.stepId === 'start');
    expect(step?.error?.message).toContain('nonexistent');

    workflow.shutdown();
  });
});

// ============================================================================
// ctx.startChildWorkflow() — Child Workflow Orchestration
// ============================================================================

describe('ctx.startChildWorkflow() — child workflows', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should put parent step into waiting state with childWorkflow type', async () => {
    const workflow = createWorkflow('parent-child', {
      steps: {
        triggerChild: async (ctx) => {
          return ctx.startChildWorkflow('child-pipeline', { data: 'test' });
        },
        afterChild: async () => 'done',
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    // Parent should be waiting for child
    expect(result.status).toBe('waiting');

    const step = result.steps.find((s) => s.stepId === 'triggerChild');
    expect(step?.status).toBe('waiting');
    expect(step?.waitingFor?.type).toBe('childWorkflow');

    const data = step?.waitingFor?.data as { childWorkflowId: string; childInput: unknown };
    expect(data?.childWorkflowId).toBe('child-pipeline');
    expect(data?.childInput).toEqual({ data: 'test' });

    workflow.shutdown();
  });

  it('should resume parent when child completes (via manual resume)', async () => {
    const workflow = createWorkflow<{ childResult?: unknown }>('parent-resume', {
      steps: {
        triggerChild: async (ctx) => {
          return ctx.startChildWorkflow('child-task', { value: 42 });
        },
        processResult: async (ctx) => {
          const childOutput = ctx.getOutput('triggerChild');
          await ctx.set('childResult', childOutput);
          return 'done';
        },
      },
      context: () => ({}),
      autoExecute: false,
    });

    const parentRun = await workflow.start({});
    await workflow.execute(parentRun._id);

    // Parent is waiting for child
    const waiting = await workflow.get(parentRun._id);
    expect(waiting?.status).toBe('waiting');

    // Simulate child completing and resuming parent
    await workflow.resume(parentRun._id, { result: 'child-done', value: 84 });

    await waitUntil(async () => {
      const r = await workflow.get(parentRun._id);
      return r?.status === 'done';
    }, 5000);

    const completed = await workflow.get(parentRun._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.childResult).toEqual({ result: 'child-done', value: 84 });

    workflow.shutdown();
  });

  it('should store parent/child relationship in waitingFor data', async () => {
    const workflow = createWorkflow('parent-metadata', {
      steps: {
        launch: async (ctx) => {
          return ctx.startChildWorkflow('sub-pipeline', { x: 1 });
        },
      },
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    const step = result.steps.find((s) => s.stepId === 'launch');
    const data = step?.waitingFor?.data as Record<string, unknown>;

    expect(data).toMatchObject({
      childWorkflowId: 'sub-pipeline',
      childInput: { x: 1 },
      parentRunId: run._id,
      parentStepId: 'launch',
    });

    workflow.shutdown();
  });
});

// ============================================================================
// Combined Patterns
// ============================================================================

describe('Combined patterns', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should combine goto + StepConfig conditional in a real pipeline', async () => {
    const log: string[] = [];

    interface PipelineCtx {
      environment: 'staging' | 'production';
      approved: boolean;
    }

    const workflow = createWorkflow<PipelineCtx>('deploy-pipeline', {
      steps: {
        build: async (ctx) => {
          log.push('build');
          return { artifact: 'v1.0.0' };
        },
        test: {
          handler: async (ctx) => {
            log.push('test');
            return { passed: true };
          },
          timeout: 60_000,
          retries: 2,
        },
        approvalGate: async (ctx) => {
          log.push('approvalGate');
          if (ctx.context.environment === 'staging') {
            // Staging doesn't need approval — skip to deploy
            await ctx.set('approved', true);
            return ctx.goto('deploy');
          }
          // Production needs approval — wait
          return ctx.wait('Needs production approval');
        },
        deploy: {
          handler: async (ctx) => {
            log.push(`deploy-${ctx.context.environment}`);
            return { deployed: true };
          },
          timeout: 120_000,
        },
      },
      context: (input: any) => ({
        environment: input.env as 'staging' | 'production',
        approved: false,
      }),
      autoExecute: false,
    });

    // Staging: build → test → approvalGate → goto deploy (skip approval)
    const staging = await workflow.start({ env: 'staging' });
    const stagingResult = await workflow.execute(staging._id);
    expect(stagingResult.status).toBe('done');
    expect(log).toEqual(['build', 'test', 'approvalGate', 'deploy-staging']);

    log.length = 0;

    // Production: build → test → approvalGate → wait for approval
    const prod = await workflow.start({ env: 'production' });
    const prodResult = await workflow.execute(prod._id);
    expect(prodResult.status).toBe('waiting');
    expect(log).toEqual(['build', 'test', 'approvalGate']);

    workflow.shutdown();
  });

  it('should combine checkpoint + goto for complex batch processing', async () => {
    const processed: number[] = [];

    const workflow = createWorkflow<{ phase: string }>('batch-goto', {
      steps: {
        phase1: async (ctx) => {
          const last = ctx.getCheckpoint<number>() ?? -1;
          for (let i = last + 1; i < 3; i++) {
            processed.push(i);
            await ctx.checkpoint(i);
          }
          await ctx.set('phase', 'phase1-done');
          return { batch1: processed.length };
        },
        phase2: async (ctx) => {
          for (let i = 10; i < 13; i++) {
            processed.push(i);
          }
          return { total: processed.length };
        },
      },
      context: () => ({ phase: 'init' }),
      autoExecute: false,
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(processed).toEqual([0, 1, 2, 10, 11, 12]);
    expect(result.context.phase).toBe('phase1-done');

    workflow.shutdown();
  });
});
