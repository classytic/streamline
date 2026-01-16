/**
 * Fastify Order Processing Example
 *
 * Real-world e-commerce order workflow with:
 * - Payment processing
 * - Inventory reservation
 * - Human approval for large orders
 * - Email notifications
 * - Automatic retry on failures
 */

import fastify from 'fastify';
import mongoose from 'mongoose';
import { createWorkflow } from '../src/index.js';
import type { StepContext } from '../src/index.js';

// ============ Domain Types ============

interface OrderContext {
  orderId: string;
  customerId: string;
  amount: number;
  items: Array<{ sku: string; quantity: number }>;
  paymentIntentId?: string;
  inventoryReserved?: boolean;
  approved?: boolean;
  emailSent?: boolean;
}

interface OrderInput {
  orderId: string;
  customerId: string;
  amount: number;
  items: Array<{ sku: string; quantity: number }>;
}

// ============ Workflow Definition ============

const orderWorkflow = createWorkflow<OrderContext, OrderInput>('order-processing', {
  steps: {
    validate: async (ctx: StepContext<OrderContext>) => {
      ctx.log(`Validating order ${ctx.context.orderId}...`);

      // Validate items exist
      if (!ctx.context.items || ctx.context.items.length === 0) {
        throw new Error('Order must have items');
      }

      // Validate amount
      if (ctx.context.amount <= 0) {
        throw new Error('Order amount must be positive');
      }

      return { valid: true };
    },

    payment: async (ctx: StepContext<OrderContext>) => {
      ctx.log(`Processing payment of $${ctx.context.amount}...`);

      // Simulate Stripe payment
      const paymentIntentId = `pi_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // In real app: await stripe.paymentIntents.create(...)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await ctx.set('paymentIntentId', paymentIntentId);

      return { paymentIntentId, status: 'succeeded' };
    },

    inventory: async (ctx: StepContext<OrderContext>) => {
      ctx.log(`Reserving inventory...`);

      // Simulate inventory system
      for (const item of ctx.context.items) {
        ctx.log(`  - Reserving ${item.quantity}x ${item.sku}`);
        // In real app: await inventoryService.reserve(item.sku, item.quantity)
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await ctx.set('inventoryReserved', true);

      return { reserved: true, items: ctx.context.items };
    },

    approval: async (ctx: StepContext<OrderContext>) => {
      // Large orders need human approval
      if (ctx.context.amount > 1000) {
        ctx.log(`Large order - waiting for approval...`);

        await ctx.wait('Large order requires manager approval', {
          orderId: ctx.context.orderId,
          amount: ctx.context.amount,
          customer: ctx.context.customerId,
          paymentId: ctx.context.paymentIntentId,
        });

        // Execution pauses here until resume() is called
      }

      return { approved: true };
    },

    fulfill: async (ctx: StepContext<OrderContext>) => {
      ctx.log(`Fulfilling order...`);

      // Simulate warehouse fulfillment
      // In real app: await warehouseService.createShipment(...)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      return {
        trackingNumber: `TRACK${Date.now()}`,
        estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
    },

    notify: async (ctx: StepContext<OrderContext>) => {
      ctx.log(`Sending confirmation email...`);

      const fulfillment = ctx.getOutput<{ trackingNumber: string }>('fulfill');

      // Simulate email service
      // In real app: await sendgrid.send(...)
      await new Promise((resolve) => setTimeout(resolve, 500));

      await ctx.set('emailSent', true);

      return {
        emailSent: true,
        trackingNumber: fulfillment?.trackingNumber,
      };
    },
  },
  context: (input) => ({
    orderId: input.orderId,
    customerId: input.customerId,
    amount: input.amount,
    items: input.items,
  }),
  version: '1.0.0',
  defaults: { retries: 2, timeout: 60000 },
});

// ============ Fastify Server ============

async function main() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orders');

  // Create Fastify app
  const app = fastify({ logger: true });

  // ============ Routes ============

  // Create order
  app.post<{ Body: { customerId: string; amount: number; items: OrderInput['items'] } }>(
    '/orders',
    async (request, reply) => {
      const { customerId, amount, items } = request.body;

      const orderId = `ORD-${Date.now()}`;

      try {
        const run = await orderWorkflow.start({
          orderId,
          customerId,
          amount,
          items,
        });

        return {
          orderId,
          workflowRunId: run._id,
          status: run.status,
          message: 'Order processing started',
        };
      } catch (error: unknown) {
        reply.code(500);
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { error: message };
      }
    }
  );

  // Get order status
  app.get<{ Params: { runId: string } }>('/orders/:runId', async (request, reply) => {
    const { runId } = request.params;

    const run = await orderWorkflow.get(runId);

    if (!run) {
      reply.code(404);
      return { error: 'Order not found' };
    }

    return {
      orderId: run.context.orderId,
      status: run.status,
      currentStep: run.currentStepId,
      steps: run.steps.map((s) => ({
        step: s.stepId,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        output: s.output,
      })),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  });

  // Approve order (for large orders)
  app.post<{ Params: { runId: string }; Body: { approved: boolean; approvedBy: string } }>(
    '/orders/:runId/approve',
    async (request, reply) => {
      const { runId } = request.params;
      const { approved, approvedBy } = request.body;

      try {
        if (!approved) {
          // Cancel workflow if rejected
          await orderWorkflow.cancel(runId);
          return { message: 'Order cancelled', approved: false };
        }

        // Resume workflow with approval
        await orderWorkflow.resume(runId, { approved: true, approvedBy, approvedAt: new Date() });

        return { message: 'Order approved and resumed', approved: true };
      } catch (error: unknown) {
        reply.code(500);
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { error: message };
      }
    }
  );

  // Health check
  app.get('/health', async () => {
    const schedulerStats = orderWorkflow.engine.getSchedulerStats();

    return {
      status: 'healthy',
      scheduler: {
        isPolling: schedulerStats.isPolling,
        totalPolls: schedulerStats.totalPolls,
        activeWorkflows: schedulerStats.activeWorkflows,
        healthy: orderWorkflow.engine.isSchedulerHealthy(),
      },
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    };
  });

  // Scheduler stats
  app.get('/stats', async () => {
    return orderWorkflow.engine.getSchedulerStats();
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000', 10);

  await app.listen({ port, host: '0.0.0.0' });

  console.log(`\nServer running on http://localhost:${port}`);
  console.log(`\nExample requests:`);
  console.log(`  POST http://localhost:${port}/orders`);
  console.log(`  GET  http://localhost:${port}/orders/:runId`);
  console.log(`  POST http://localhost:${port}/orders/:runId/approve`);
  console.log(`  GET  http://localhost:${port}/health`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    orderWorkflow.shutdown();
    await app.close();
    await mongoose.connection.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export { orderWorkflow };
