import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, teardownTestDB } from '../../utils/setup.js';
import {
  createWorkflow,
  isConditionalStep,
  shouldSkipStep,
  conditions,
  createCondition,
} from '../../../src/index.js';
import type { ConditionalStep, WorkflowRun } from '../../../src/index.js';

interface OrderContext {
  orderId: string;
  amount: number;
  country: string;
  priority: string;
  validated?: boolean;
  shipped?: boolean;
  notified?: boolean;
}

describe('Conditional Workflow', () => {
  beforeAll(setupTestDB);

  it('should skip steps based on condition', async () => {
    const workflow = createWorkflow<OrderContext>('conditional-order-test', {
      steps: {
        validate: async (ctx) => {
          const { amount, country } = ctx.context;
          const valid = amount > 0 && country.length > 0;
          await ctx.set('validated', valid);
          ctx.log('Order validated', { valid });
          return { valid };
        },
        express: async (ctx) => {
          if (ctx.context.priority !== 'express') {
            return { skipped: true };
          }
          ctx.log('Processing express shipping');
          await ctx.set('shipped', true);
          return { method: 'express', estimatedDays: 1 };
        },
        standard: async (ctx) => {
          if (ctx.context.priority !== 'standard') {
            return { skipped: true };
          }
          ctx.log('Processing standard shipping');
          await ctx.set('shipped', true);
          return { method: 'standard', estimatedDays: 5 };
        },
        notify: async (ctx) => {
          ctx.log('Sending notification');
          await ctx.set('notified', true);
          return { sent: true };
        },
      },
      context: (input: any) => ({
        orderId: input.orderId,
        amount: input.amount,
        country: input.country,
        priority: input.priority,
      }),
      autoExecute: false,
    });

    // Test express order
    const expressRun = await workflow.start({
      orderId: 'ORD-001',
      amount: 100,
      country: 'US',
      priority: 'express',
    });

    const expressResult = await workflow.execute(expressRun._id);

    expect(expressResult.status).toBe('done');
    expect(expressResult.steps.find((s) => s.stepId === 'express')?.output).toHaveProperty('method', 'express');
    expect(expressResult.steps.find((s) => s.stepId === 'standard')?.output).toHaveProperty('skipped', true);

    // Test standard order
    const standardRun = await workflow.start({
      orderId: 'ORD-002',
      amount: 50,
      country: 'CA',
      priority: 'standard',
    });

    const standardResult = await workflow.execute(standardRun._id);

    expect(standardResult.status).toBe('done');
    expect(standardResult.steps.find((s) => s.stepId === 'express')?.output).toHaveProperty('skipped', true);
    expect(standardResult.steps.find((s) => s.stepId === 'standard')?.output).toHaveProperty('method', 'standard');

    workflow.shutdown();
  });

  it('should validate isConditionalStep type guard', () => {
    const conditionalStep: ConditionalStep = {
      id: 'cond-1',
      name: 'Conditional Step',
      condition: (ctx: any) => ctx.value > 10,
    };

    const regularStep = {
      id: 'regular-1',
      name: 'Regular Step',
    };

    expect(isConditionalStep(conditionalStep)).toBe(true);
    expect(isConditionalStep(regularStep)).toBe(false);
  });

  it('should test built-in condition helpers', () => {
    interface TestContext {
      value: number;
      status: string;
      data?: string;
    }

    const ctx: TestContext = {
      value: 15,
      status: 'active',
      data: 'test',
    };

    // hasValue
    expect(conditions.hasValue<TestContext>('data')(ctx)).toBe(true);
    expect(conditions.hasValue<TestContext>('data')({ ...ctx, data: undefined })).toBe(false);

    // equals
    expect(conditions.equals<TestContext>('status', 'active')(ctx)).toBe(true);
    expect(conditions.equals<TestContext>('status', 'inactive')(ctx)).toBe(false);

    // greaterThan
    expect(conditions.greaterThan<TestContext>('value', 10)(ctx)).toBe(true);
    expect(conditions.greaterThan<TestContext>('value', 20)(ctx)).toBe(false);

    // lessThan
    expect(conditions.lessThan<TestContext>('value', 20)(ctx)).toBe(true);
    expect(conditions.lessThan<TestContext>('value', 10)(ctx)).toBe(false);

    // and
    expect(
      conditions.and<TestContext>(
        conditions.hasValue('data'),
        conditions.greaterThan('value', 10)
      )(ctx)
    ).toBe(true);

    // or
    expect(
      conditions.or<TestContext>(
        conditions.equals('status', 'inactive'),
        conditions.hasValue('data')
      )(ctx)
    ).toBe(true);

    // not
    expect(conditions.not<TestContext>(conditions.equals('status', 'inactive'))(ctx)).toBe(true);
  });

  it('should test skipIf and runIf conditions', async () => {
    const mockRun: WorkflowRun<OrderContext> = {
      _id: 'test-run',
      workflowId: 'test-workflow',
      status: 'running',
      context: {
        orderId: 'ORD-001',
        amount: 50,
        country: 'US',
        priority: 'standard',
      },
      steps: [],
      currentStepId: null,
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Test skipIf
    const skipIfStep: ConditionalStep = {
      id: 'step1',
      name: 'Step 1',
      skipIf: (ctx: OrderContext) => ctx.amount < 100,
    };

    const shouldSkip = await shouldSkipStep(skipIfStep, mockRun.context, mockRun);
    expect(shouldSkip).toBe(true);

    // Test runIf
    const runIfStep: ConditionalStep = {
      id: 'step2',
      name: 'Step 2',
      runIf: (ctx: OrderContext) => ctx.amount >= 100,
    };

    const shouldSkipRunIf = await shouldSkipStep(runIfStep, mockRun.context, mockRun);
    expect(shouldSkipRunIf).toBe(true); // Should skip because amount < 100
  });

  it('should create custom conditions', () => {
    interface CustomContext {
      email: string;
      age: number;
    }

    const isAdult = createCondition<CustomContext>((ctx) => ctx.age >= 18);
    const hasValidEmail = createCondition<CustomContext>((ctx) =>
      ctx.email.includes('@') && ctx.email.includes('.')
    );

    const validAdult: CustomContext = { email: 'user@example.com', age: 25 };
    const validMinor: CustomContext = { email: 'kid@example.com', age: 15 };
    const invalidEmail: CustomContext = { email: 'invalid', age: 25 };

    expect(isAdult(validAdult)).toBe(true);
    expect(isAdult(validMinor)).toBe(false);
    expect(hasValidEmail(validAdult)).toBe(true);
    expect(hasValidEmail(invalidEmail)).toBe(false);
  });
});
