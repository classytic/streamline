import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, teardownTestDB } from '../../utils/setup.js';
import { createWorkflow } from '../../../src/index.js';

interface SimpleContext {
  value: number;
  result?: number;
}

describe('Simple Workflow Test', () => {
  beforeAll(setupTestDB);

  it('should complete simple 2-step workflow', async () => {
    const workflow = createWorkflow<SimpleContext>('simple-2-step', {
      steps: {
        step1: async (ctx) => {
          console.log('[step1] Executing step1, value:', ctx.context.value);
          await ctx.set('result', ctx.context.value * 2);
          console.log('[step1] Set result to:', ctx.context.value * 2);
          return { step1Done: true };
        },
        step2: async (ctx) => {
          console.log('[step2] Executing step2, result:', ctx.context.result);
          return { step2Done: true };
        },
      },
      context: (input: any) => ({ value: input.value }),
      autoExecute: false,
    });

    console.log('Starting workflow...');
    const run = await workflow.start({ value: 10 });
    console.log('Workflow started, status:', run.status, 'id:', run._id);

    console.log('Executing workflow...');
    const result = await workflow.execute(run._id);
    console.log('Workflow executed, status:', result.status);
    console.log('Steps:', result.steps.map((s) => `${s.stepId}: ${s.status}`));

    expect(result.status).toBe('done');
    expect(result.context.result).toBe(20);

    workflow.shutdown();
  });
});
