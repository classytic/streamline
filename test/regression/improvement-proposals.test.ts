/**
 * Streamline Improvement Proposals — Tests
 *
 * TDD: These tests define the contract for proposals #1-#4.
 * Written RED first, then made GREEN by implementation.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// ============================================================================
// Proposal #1 & #4: Export Workflow and WorkflowConfig types
// ============================================================================

describe('Proposal #1 & #4: Export Workflow and WorkflowConfig types', () => {
  it('should export Workflow type from package index', async () => {
    const mod = await import('../../src/index.js');
    // Workflow is a type-only export — we verify it exists via the module's type exports
    // At runtime, we verify createWorkflow is exported and returns an object matching the Workflow interface
    expect(mod.createWorkflow).toBeDefined();
  });

  it('should allow typing a variable as Workflow without ReturnType workaround', async () => {
    // This test validates the type export works at the module boundary.
    // If Workflow type is not exported, consumers get TS4023.
    // We verify by dynamically importing and checking the type re-export exists.
    const indexModule = await import('../../src/index.js');

    // createWorkflow should be a function
    expect(typeof indexModule.createWorkflow).toBe('function');

    // The module should export from workflow/define.js which now exports Workflow
    const defineModule = await import('../../src/workflow/define.js');
    // Workflow and WorkflowConfig are type-only exports — they won't appear at runtime
    // But we can verify the module doesn't throw when imported
    expect(defineModule.createWorkflow).toBeDefined();
  });

  it('should re-export Workflow and WorkflowConfig as type exports from index', async () => {
    // We verify by reading the index source to confirm type exports exist
    // This is a structural test — TypeScript compilation is the real validator
    const fs = await import('node:fs');
    const indexSource = fs.readFileSync(
      new URL('../../src/index.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      'utf-8',
    );

    expect(indexSource).toContain('Workflow');
    expect(indexSource).toContain('WorkflowConfig');
  });
});

// ============================================================================
// Proposal #2: Per-step timeout / retries override
// ============================================================================

describe('Proposal #2: Per-step timeout/retries override in createWorkflow()', () => {
  it('should accept StepConfig objects alongside plain handlers', async () => {
    interface Ctx {
      value: number;
    }

    // Should not throw when mixing plain handlers and StepConfig objects
    const workflow = env.workflow<Ctx>('step-config-mixed', {
      steps: {
        fast: async () => {
          return { done: true };
        },
        slow: {
          handler: async () => {
            return { done: true };
          },
          timeout: 120_000,
          retries: 5,
        },
      },
      context: () => ({ value: 1 }),
    });

    expect(workflow.definition.steps).toHaveLength(2);
    expect(workflow.definition.steps[0]?.id).toBe('fast');
    expect(workflow.definition.steps[1]?.id).toBe('slow');
  });

  it('should apply per-step timeout from StepConfig', async () => {
    interface Ctx {
      result?: string;
    }

    const workflow = env.workflow<Ctx>('step-timeout-override', {
      steps: {
        quickStep: {
          handler: async () => {
            return 'quick';
          },
          timeout: 500, // Very short timeout
        },
        slowStep: {
          handler: async () => {
            // This should have the default/workflow timeout, not the quick one
            return 'slow';
          },
          timeout: 60_000,
        },
      },
      context: () => ({}),
    });

    // Verify step definitions carry timeout
    const quickStep = workflow.definition.steps.find((s) => s.id === 'quickStep');
    const slowStep = workflow.definition.steps.find((s) => s.id === 'slowStep');

    expect(quickStep?.timeout).toBe(500);
    expect(slowStep?.timeout).toBe(60_000);
  });

  it('should apply per-step retries from StepConfig', async () => {
    interface Ctx {
      attempts: number;
    }

    const workflow = env.workflow<Ctx>('step-retries-override', {
      steps: {
        fragile: {
          handler: async () => {
            return 'ok';
          },
          retries: 1, // Only 1 attempt, no retries
        },
        resilient: {
          handler: async () => {
            return 'ok';
          },
          retries: 10, // Very resilient
        },
      },
      context: () => ({ attempts: 0 }),
    });

    const fragile = workflow.definition.steps.find((s) => s.id === 'fragile');
    const resilient = workflow.definition.steps.find((s) => s.id === 'resilient');

    expect(fragile?.retries).toBe(1);
    expect(resilient?.retries).toBe(10);
  });

  it('should use workflow defaults when StepConfig omits timeout/retries', async () => {
    const workflow = env.workflow('step-config-defaults', {
      steps: {
        withConfig: {
          handler: async () => 'ok',
          // No timeout or retries — should inherit from defaults
        },
        plainHandler: async () => 'ok',
      },
      defaults: { retries: 7, timeout: 30_000 },
    });

    // StepConfig without timeout/retries should NOT set them on the step
    // (they should fall through to workflow defaults at runtime)
    const withConfig = workflow.definition.steps.find((s) => s.id === 'withConfig');
    expect(withConfig?.timeout).toBeUndefined();
    expect(withConfig?.retries).toBeUndefined();

    // Plain handler also shouldn't have step-level overrides
    const plain = workflow.definition.steps.find((s) => s.id === 'plainHandler');
    expect(plain?.timeout).toBeUndefined();
    expect(plain?.retries).toBeUndefined();
  });

  it('should execute workflow with mixed StepConfig and plain handlers', async () => {
    interface Ctx {
      results: string[];
    }

    const workflow = env.workflow<Ctx>('step-config-execution', {
      steps: {
        step1: async (ctx) => {
          ctx.context.results.push('step1');
          return 'step1-done';
        },
        step2: {
          handler: async (ctx) => {
            ctx.context.results.push('step2');
            return 'step2-done';
          },
          timeout: 10_000,
          retries: 2,
        },
        step3: async (ctx) => {
          ctx.context.results.push('step3');
          return 'step3-done';
        },
      },
      context: () => ({ results: [] as string[] }),
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.results).toEqual(['step1', 'step2', 'step3']);
  });

  it('should respect per-step timeout during actual execution', async () => {
    interface Ctx {
      done: boolean;
    }

    const workflow = env.workflow<Ctx>('step-timeout-execution', {
      steps: {
        willTimeout: {
          handler: async () => {
            // Wait longer than the timeout
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return 'should not reach';
          },
          timeout: 200, // 200ms timeout — handler takes 2000ms
          retries: 1, // No retries so it fails fast
        },
      },
      context: () => ({ done: false }),
    });

    const run = await workflow.start({});
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    const step = result.steps.find((s) => s.stepId === 'willTimeout');
    expect(step?.error?.message).toContain('timeout');
  });

  it('should support conditional execution via StepConfig', async () => {
    interface Ctx {
      skipOptional: boolean;
      results: string[];
    }

    const workflow = env.workflow<Ctx, { skip: boolean }>('step-config-conditional', {
      steps: {
        always: async (ctx) => {
          ctx.context.results.push('always');
          return 'ok';
        },
        optional: {
          handler: async (ctx) => {
            ctx.context.results.push('optional');
            return 'ok';
          },
          skipIf: (ctx: Ctx) => ctx.skipOptional,
        },
        final: async (ctx) => {
          ctx.context.results.push('final');
          return 'ok';
        },
      },
      context: (input) => ({ skipOptional: input.skip, results: [] as string[] }),
    });

    // Run with skip=true
    const run1 = await workflow.start({ skip: true });
    const result1 = await workflow.execute(run1._id);
    expect(result1.status).toBe('done');
    expect(result1.context.results).toEqual(['always', 'final']);

    // Run with skip=false
    const run2 = await workflow.start({ skip: false });
    const result2 = await workflow.execute(run2._id);
    expect(result2.status).toBe('done');
    expect(result2.context.results).toEqual(['always', 'optional', 'final']);
  });
});

// ============================================================================
// Proposal #3: Scheduler concurrency limit
// ============================================================================

describe('Proposal #3: Scheduler concurrency limit', () => {
  it('should accept maxConcurrentExecutions in SmartSchedulerConfig', async () => {
    const { DEFAULT_SCHEDULER_CONFIG } = await import('../../src/execution/smart-scheduler.js');

    // Default should be Infinity (backwards compatible)
    expect(DEFAULT_SCHEDULER_CONFIG.maxConcurrentExecutions).toBe(Infinity);
  });

  it('should expose maxConcurrentExecutions through engine configure', async () => {
    const workflow = env.workflow('concurrency-config', {
      steps: {
        step1: async () => 'ok',
      },
    });

    // Should not throw when configuring maxConcurrentExecutions
    workflow.engine.configure({
      scheduler: { maxConcurrentExecutions: 5 },
    });
  });

  it('should track running count via repository', async () => {
    // Create a slow workflow
    const workflow = env.workflow('concurrency-test', {
      steps: {
        slow: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 'done';
        },
      },
    });

    // Start 3 workflow runs
    const run1 = await workflow.start({});
    const run2 = await workflow.start({});
    const run3 = await workflow.start({});

    // All should be in running state (since autoExecute is false, they're actually running status from start)
    const runningCount = await env.container.repository.countRunning();
    expect(runningCount).toBeGreaterThanOrEqual(3);

    // Execute them
    await Promise.all([
      workflow.execute(run1._id),
      workflow.execute(run2._id),
      workflow.execute(run3._id),
    ]);
  });
});
