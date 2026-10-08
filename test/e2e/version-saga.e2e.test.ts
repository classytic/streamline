/**
 * Version Pinning & Saga Compensation E2E Tests
 *
 * Tests:
 * 1. Version mismatch detection (in-flight workflows with deleted steps)
 * 2. Saga pattern compensation (rollback completed steps on failure)
 * 3. Scatter concurrency and limits documentation
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// ============================================================================
// 1. Version Mismatch Detection
// ============================================================================

describe('Version mismatch detection', () => {
  it('should fail gracefully with VERSION_MISMATCH when step was deleted', async () => {
    // v1: has 3 steps
    const workflowV1 = env.workflow('versioned-pipeline', {
      steps: {
        step1: async () => 'done',
        stepOld: async () => 'old-step',
        step3: async () => 'final',
      },
    });

    // Start a workflow but DON'T execute — manually set currentStepId to stepOld
    const run = await workflowV1.start({});

    // Simulate v1 run paused at stepOld (cache-safe: the engine re-reads from DB)
    await env.runs.update(run._id, { currentStepId: 'stepOld', status: 'running' });

    workflowV1.shutdown();

    // Simulate v2 deployment: recreate workflow (same id) WITHOUT stepOld
    const workflowV2 = env.redefine(workflowV1, {
      steps: {
        step1: async () => 'done',
        // stepOld DELETED
        step3: async () => 'final',
      },
      version: '2.0.0',
      // A major bump parks by default; opt into running it here to exercise
      // the step-not-found safety net underneath.
      versionPolicy: 'any',
    });

    // Execute — should hit VERSION_MISMATCH because currentStepId='stepOld' doesn't exist in v2
    const result = await workflowV2.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('VERSION_MISMATCH');
  });

  it('should succeed when step names match across versions', async () => {
    const workflowV1 = env.workflow('compatible-pipeline', {
      steps: {
        validate: async () => ({ valid: true }),
        process: async (ctx) => ctx.wait('approval'),
        complete: async () => 'done',
      },
      version: '1.0.0',
    });

    const run = await workflowV1.start({});
    await workflowV1.execute(run._id);
    expect((await workflowV1.get(run._id))?.status).toBe('waiting');

    workflowV1.shutdown();

    // v1.1: same step names, compatible (same-major) implementation change
    const workflowV2 = env.redefine(workflowV1, {
      steps: {
        validate: async () => ({ valid: true, v2: true }),
        process: async (ctx) => ctx.wait('approval'),
        complete: async () => 'done-v2',
      },
      version: '1.1.0',
    });

    // Resume should work — same major under the default 'compatible' policy
    await workflowV2.resume(run._id, { approved: true });

    await env.until(run._id, 'done');

    const final = await workflowV2.get(run._id);
    expect(final?.status).toBe('done');
  });
});

// ============================================================================
// 2. Saga Pattern Compensation
// ============================================================================

describe('Saga compensation (rollback)', () => {
  it('should run compensation handlers in reverse when workflow fails', async () => {
    const compensated: string[] = [];

    const workflow = env.workflow('saga-rollback', {
      steps: {
        chargeCard: {
          handler: async () => ({ chargeId: 'ch_123' }),
          onCompensate: async (ctx) => {
            const charge = ctx.getOutput<{ chargeId: string }>('chargeCard');
            compensated.push(`refund:${charge?.chargeId}`);
          },
        },
        provisionServer: {
          handler: async () => ({ serverId: 'srv_456' }),
          onCompensate: async (ctx) => {
            const server = ctx.getOutput<{ serverId: string }>('provisionServer');
            compensated.push(`deprovision:${server?.serverId}`);
          },
        },
        assignDomain: {
          handler: async () => {
            throw new Error('DNS provider down');
          },
          retries: 1, // Fail immediately
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    // Durable saga (v2.4): a failed run WITH compensation handlers drives the
    // compensation phase before returning, so the terminal status is
    // 'compensated' (all rollbacks succeeded), NOT the bare 'failed'. The
    // pre-v2.4 assertion of 'failed' predated the durable-saga terminal states.
    expect(result.status).toBe('compensated');

    // Compensations should run in reverse: provisionServer first, then chargeCard
    expect(compensated).toEqual(['deprovision:srv_456', 'refund:ch_123']);
  });

  it('should only compensate completed steps, not pending or failed ones', async () => {
    const compensated: string[] = [];

    const workflow = env.workflow('saga-partial', {
      steps: {
        step1: {
          handler: async () => 'ok',
          onCompensate: async () => {
            compensated.push('step1');
          },
        },
        step2: {
          handler: async () => 'ok',
          onCompensate: async () => {
            compensated.push('step2');
          },
        },
        step3: {
          handler: async () => {
            throw new Error('fail');
          },
          retries: 1,
          onCompensate: async () => {
            compensated.push('step3-should-not-run');
          },
        },
        step4: {
          handler: async () => 'should-not-reach',
          onCompensate: async () => {
            compensated.push('step4-should-not-run');
          },
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // step3 failed, step4 never ran → only step1 and step2 compensated (reverse)
    expect(compensated).toEqual(['step2', 'step1']);
  });

  it('should continue compensating even if one compensation handler fails', async () => {
    const compensated: string[] = [];
    const errors: string[] = [];

    // The env's container outlives this test — detach the listener after.
    const onEngineError = (payload: { context: string }) => {
      if (payload.context.startsWith('compensation-')) {
        errors.push(payload.context);
      }
    };
    env.container.eventBus.on('engine:error', onEngineError);

    try {
      const workflow = env.workflow('saga-compensation-error', {
        steps: {
          step1: {
            handler: async () => 'ok',
            onCompensate: async () => {
              compensated.push('step1');
            },
          },
          step2: {
            handler: async () => 'ok',
            onCompensate: async () => {
              throw new Error('compensation failed');
            },
          },
          step3: {
            handler: async () => {
              throw new Error('fail');
            },
            retries: 1,
          },
        },
      });

      const run = await workflow.start({});
      await workflow.execute(run._id);

      // step2 compensation fails, but step1 compensation still runs
      expect(compensated).toEqual(['step1']);
      expect(errors).toContain('compensation-step2');
    } finally {
      env.container.eventBus.off('engine:error', onEngineError);
    }
  });

  it('should not run compensation when workflow succeeds', async () => {
    const compensated: string[] = [];

    const workflow = env.workflow('saga-success', {
      steps: {
        step1: {
          handler: async () => 'ok',
          onCompensate: async () => {
            compensated.push('step1');
          },
        },
        step2: {
          handler: async () => 'ok',
          onCompensate: async () => {
            compensated.push('step2');
          },
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(compensated).toEqual([]); // No compensation on success
  });
});

// ============================================================================
// 3. Scatter with concurrency control (documenting OOM protection)
// ============================================================================

describe('Scatter concurrency safety', () => {
  it('should limit concurrent scatter tasks to prevent OOM', async () => {
    let peak = 0;
    let active = 0;

    const workflow = env.workflow('scatter-oom-guard', {
      steps: {
        heavyWork: async (ctx) => {
          // 20 tasks but only 3 concurrent — prevents OOM
          const tasks: Record<string, () => Promise<string>> = {};
          for (let i = 0; i < 20; i++) {
            tasks[`task${i}`] = async () => {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 20));
              active--;
              return `result-${i}`;
            };
          }

          return ctx.scatter(tasks, { concurrency: 3 });
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(peak).toBeLessThanOrEqual(3);
    expect(Object.keys(result.output as Record<string, string>)).toHaveLength(20);
  });

  it('should handle scatter with single task', async () => {
    const workflow = env.workflow('scatter-single', {
      steps: {
        single: async (ctx) => {
          return ctx.scatter({
            only: async () => 42,
          });
        },
      },
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ only: 42 });
  });
});
