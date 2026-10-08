import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../../helpers/index.js';

const env = useStreamlineEnv();

interface TestContext {
  value: number;
  result?: number;
  step1Done?: boolean;
  step2Done?: boolean;
}

type TestInput = { value: number };
const context = (input: TestInput): TestContext => ({ value: input.value });

describe('WorkflowEngine', () => {
  it('should start and execute a simple workflow', async () => {
    const workflow = env.workflow<TestContext, TestInput>('simple-test', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('step1Done', true);
          ctx.log('Step 1 executed');
          return { step: 1 };
        },
        step2: async (ctx) => {
          await ctx.set('step2Done', true);
          const result = ctx.context.value * 2;
          await ctx.set('result', result);
          ctx.log('Step 2 executed', { result });
          return { step: 2, result };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 10 });

    expect(run._id).toBeDefined();
    expect(run.workflowId).toBe(workflow.engine.definition.id);
    expect(run.status).toBe('running');

    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.step1Done).toBe(true);
    expect(result.context.step2Done).toBe(true);
    expect(result.context.result).toBe(20);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].status).toBe('done');
    expect(result.steps[1].status).toBe('done');
  });

  it('should handle workflow with retry', async () => {
    let attemptCount = 0;

    const workflow = env.workflow<TestContext, TestInput>('retry-test', {
      steps: {
        flaky: async (ctx) => {
          attemptCount++;
          if (attemptCount < 2) {
            throw new Error('Temporary failure');
          }
          await ctx.set('result', ctx.context.value * 3);
          return { success: true, attempts: attemptCount };
        },
      },
      context,
      defaults: { retries: 2 },
    });

    const run = await workflow.start({ value: 5 });
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.result).toBe(15);
    expect(attemptCount).toBe(2);
  });

  it('should handle workflow failure after max retries', async () => {
    const workflow = env.workflow<TestContext, TestInput>('failure-test', {
      steps: {
        alwaysFail: async () => {
          throw new Error('Permanent failure');
        },
      },
      context,
      defaults: { retries: 1 },
    });

    const run = await workflow.start({ value: 5 });
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toBeDefined();
    expect(result.steps[0].error?.message).toBe('Permanent failure');
  });

  it('should handle wait and resume', async () => {
    const workflow = env.workflow<TestContext, TestInput>('wait-test', {
      steps: {
        start: async (ctx) => {
          await ctx.set('step1Done', true);
          return { started: true };
        },
        wait: async (ctx) => {
          await ctx.wait('Please approve', { value: ctx.context.value });
        },
        finish: async (ctx) => {
          await ctx.set('step2Done', true);
          await ctx.set('result', ctx.context.value * 10);
          return { finished: true };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 7 });
    const waitingRun = await workflow.execute(run._id);

    expect(waitingRun.status).toBe('waiting');
    expect(waitingRun.steps[1].status).toBe('waiting');
    expect(waitingRun.steps[1].waitingFor?.type).toBe('human');
    expect(waitingRun.steps[1].waitingFor?.reason).toBe('Please approve');

    const resumedRun = await workflow.resume(run._id, { approved: true });

    expect(resumedRun.status).toBe('done');
    expect(resumedRun.context.result).toBe(70);
    expect(resumedRun.steps[2].status).toBe('done');
  });

  it('should handle pause and resume', async () => {
    const workflow = env.workflow<TestContext, TestInput>('pause-test', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('step1Done', true);
          return { step: 1 };
        },
        wait: async (ctx) => {
          await ctx.wait('manual-resume', { message: 'Waiting for manual resume' });
          return { waited: true };
        },
        step2: async (ctx) => {
          await ctx.set('result', ctx.context.value * 2);
          return { step: 2 };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 12 });

    // Execute until waiting
    const current = await workflow.execute(run._id);
    expect(current.status).toBe('waiting');

    // Pause (should still work on waiting workflow)
    const pausedRun = await workflow.pause(run._id);
    expect(pausedRun.status).toBe('waiting');

    // Resume with payload
    await workflow.resume(run._id, { approved: true });

    // Execute remaining steps
    const finalRun = await workflow.execute(run._id);
    expect(finalRun.status).toBe('done');
    expect(finalRun.context.result).toBe(24);
  });

  it('should handle cancel', async () => {
    const workflow = env.workflow<TestContext, TestInput>('cancel-test', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('step1Done', true);
          return { step: 1 };
        },
        wait: async (ctx) => {
          await ctx.wait('Waiting for input');
        },
        step2: async (ctx) => {
          await ctx.set('result', ctx.context.value * 3);
          return { step: 2 };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 8 });
    await workflow.execute(run._id);

    const canceledRun = await workflow.cancel(run._id);

    expect(canceledRun.status).toBe('cancelled');
    expect(canceledRun.steps[2].status).toBe('pending');
  });

  it('should handle rewindTo', async () => {
    const workflow = env.workflow<TestContext, TestInput>('rewind-test', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('step1Done', true);
          return { step: 1 };
        },
        step2: async (ctx) => {
          await ctx.set('step2Done', true);
          return { step: 2 };
        },
        step3: async (ctx) => {
          await ctx.set('result', ctx.context.value * 4);
          return { step: 3 };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 6 });
    await workflow.execute(run._id);

    // Rewind to step2
    const rewoundRun = await workflow.rewindTo(run._id, 'step2');

    expect(rewoundRun.status).toBe('running');
    expect(rewoundRun.currentStepId).toBe('step2');
    expect(rewoundRun.steps[0].status).toBe('done');
    expect(rewoundRun.steps[1].status).toBe('pending');
    expect(rewoundRun.steps[2].status).toBe('pending');

    // Re-execute from step2
    const reExecutedRun = await workflow.execute(rewoundRun._id);

    expect(reExecutedRun.status).toBe('done');
    expect(reExecutedRun.context.result).toBe(24);
  });

  it('should retrieve workflow from cache', async () => {
    const workflow = env.workflow<TestContext, TestInput>('cache-test', {
      steps: {
        step1: async (ctx) => {
          await ctx.set('result', ctx.context.value * 5);
          return { step: 1 };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 9 });

    // First get - from DB
    const run1 = await workflow.get(run._id);
    expect(run1).toBeDefined();

    // Second get - should be from cache
    const run2 = await workflow.get(run._id);
    expect(run2).toBeDefined();
    expect(run2?._id).toBe(run1?._id);
  });

  it('should handle step timeout', async () => {
    const workflow = env.workflow<TestContext, TestInput>('timeout-test', {
      steps: {
        slow: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { completed: true };
        },
      },
      context,
      defaults: { timeout: 100, retries: 0 },
    });

    const run = await workflow.start({ value: 1 });
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error?.message).toContain('timeout');
  });

  it('should handle getOutput from previous steps', async () => {
    const workflow = env.workflow<TestContext, TestInput>('getoutput-test', {
      steps: {
        step1: async () => {
          return { data: 100 };
        },
        step2: async (ctx) => {
          const step1Output = ctx.getOutput<{ data: number }>('step1');
          return { data: step1Output!.data * 2 };
        },
        step3: async (ctx) => {
          const step1Output = ctx.getOutput<{ data: number }>('step1');
          const step2Output = ctx.getOutput<{ data: number }>('step2');
          await ctx.set('result', step1Output!.data + step2Output!.data);
          return { total: step1Output!.data + step2Output!.data };
        },
      },
      context,
    });

    const run = await workflow.start({ value: 0 });
    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.result).toBe(300); // 100 + 200
  });
});
