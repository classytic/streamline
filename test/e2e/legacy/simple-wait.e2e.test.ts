import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../../helpers/index.js';

const env = useStreamlineEnv();

interface SimpleContext {
  value: number;
}

describe('Simple Wait Test', () => {
  it('should pause at wait signal', async () => {
    const workflow = env.workflow<SimpleContext, { value: number }>('simple-wait', {
      steps: {
        before: async () => {
          console.log('[before] Executing before step');
          return { done: true };
        },
        wait: async (ctx) => {
          console.log('[wait] About to wait');
          await ctx.wait('Please approve', { value: ctx.context.value });
          console.log('[wait] This should not print');
        },
        after: async () => {
          console.log('[after] This should not execute yet');
          return { done: true };
        },
      },
      context: (input) => ({ value: input.value }),
    });

    console.log('Starting workflow...');
    const run = await workflow.start({ value: 42 });
    console.log('Started, status:', run.status);

    console.log('Executing...');
    const result = await workflow.execute(run._id);
    console.log('After execute, status:', result.status);
    console.log(
      'Steps:',
      result.steps.map((s) => `${s.stepId}: ${s.status}`),
    );
    console.log('Current step:', result.currentStepId);

    expect(result.status).toBe('waiting');
    expect(result.steps[0].status).toBe('done');
    expect(result.steps[1].status).toBe('waiting');
    expect(result.steps[2].status).toBe('pending');
  });
});
