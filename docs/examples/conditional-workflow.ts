import { createWorkflow } from '@classytic/streamline';

interface OrderContext {
  orderType: 'standard' | 'express' | 'international';
  amount: number;
  country: string;
  validated?: boolean;
  shippingCost?: number;
  customsFee?: number;
}

export const orderWorkflow = createWorkflow<OrderContext>('order-processing', {
  steps: {
    validate: async (ctx) => {
      const valid = ctx.context.amount > 0;
      await ctx.set('validated', valid);

      if (!valid) {
        throw new Error('Invalid order amount');
      }

      ctx.log('Order validated');
      return { valid: true };
    },
    expedite: async (ctx) => {
      if (ctx.context.orderType !== 'express') {
        ctx.log('Skipping expedite - not express order');
        return { skipped: true };
      }

      ctx.log('Expediting order');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { expedited: true };
    },
    customs: async (ctx) => {
      if (ctx.context.orderType !== 'international') {
        ctx.log('Skipping customs - domestic order');
        return { skipped: true };
      }

      const customsFee = ctx.context.amount * 0.15;
      await ctx.set('customsFee', customsFee);
      ctx.log('Customs calculated', { fee: customsFee });
      return { customsFee };
    },
    shipping: async (ctx) => {
      let baseRate = 10;

      if (ctx.context.orderType === 'express') baseRate = 25;
      if (ctx.context.orderType === 'international') baseRate = 50;

      const shippingCost = baseRate + ctx.context.amount * 0.01;
      await ctx.set('shippingCost', shippingCost);

      ctx.log('Shipping calculated', { cost: shippingCost });
      return { shippingCost };
    },
    finalize: async (ctx) => {
      const total =
        ctx.context.amount +
        (ctx.context.shippingCost || 0) +
        (ctx.context.customsFee || 0);

      ctx.log('Order finalized', { total });
      return { total, status: 'completed' };
    },
  },
  context: (input: any) => ({
    orderType: input.orderType,
    amount: input.amount,
    country: input.country,
  }),
});
