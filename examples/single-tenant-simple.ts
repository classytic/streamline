/**
 * Single-Tenant Example
 *
 * Simplest setup - one organization, no tenant isolation needed
 * Perfect for small businesses, internal tools, MVPs
 */

import mongoose from 'mongoose';
import { createWorkflow } from '../src/index.js';

// Connect to MongoDB
await mongoose.connect('mongodb://localhost:27017/my-app');

// 1. Define workflow with inline handlers (type-safe, git-versioned)
interface OrderContext {
  orderId: string;
  amount: number;
  status?: string;
}

interface OrderInput {
  orderId: string;
  amount: number;
}

const orderWorkflow = createWorkflow<OrderContext, OrderInput>('order-processing', {
  steps: {
    validate: async (ctx) => {
      console.log(`[${ctx.context.orderId}] Validating order`);
      if (ctx.context.amount <= 0) {
        throw new Error('Invalid amount');
      }
      return { valid: true };
    },

    payment: async (ctx) => {
      console.log(`[${ctx.context.orderId}] Processing payment: $${ctx.context.amount}`);
      // Simulate payment API call
      await new Promise((resolve) => setTimeout(resolve, 100));
      await ctx.set('status', 'paid');
      return { paymentId: `PAY-${Date.now()}` };
    },

    fulfill: async (ctx) => {
      console.log(`[${ctx.context.orderId}] Fulfilling order`);
      await ctx.set('status', 'fulfilled');
      return { shipped: true };
    },
  },
  context: (input) => ({
    orderId: input.orderId,
    amount: input.amount,
  }),
  version: '1.0.0',
  defaults: { retries: 3 },
});

// 2. Start workflow
const run = await orderWorkflow.start({
  orderId: 'ORD-123',
  amount: 100,
});

console.log('Workflow started:', run._id);

// Wait for completion
await new Promise((resolve) => setTimeout(resolve, 500));

const result = await orderWorkflow.get(run._id);
console.log('Workflow status:', result?.status);
console.log('Final output:', result?.output);

orderWorkflow.shutdown();
await mongoose.disconnect();
