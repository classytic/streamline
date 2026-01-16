/**
 * Type Inference Examples
 *
 * Shows how to use TypeScript for type-safe workflows with createWorkflow.
 */

import { createWorkflow, type StepContext } from '@classytic/streamline';

// ============ Example 1: Basic Type Inference ============

interface OrderContext {
  orderId: string;
  userId: string;
  total: number;
  status: 'pending' | 'processing' | 'completed';
  paymentId?: string;
  shippingId?: string;
}

// With createWorkflow, context type flows through automatically
export const orderWorkflow = createWorkflow<OrderContext>('order-processing', {
  steps: {
    validate: async (ctx) => {
      // ctx.context is automatically typed as OrderContext
      const { orderId, total } = ctx.context;

      if (total <= 0) {
        throw new Error('Invalid order total');
      }

      await ctx.set('status', 'processing');
      return { valid: true };
    },

    payment: async (ctx) => {
      // Type-safe context access
      await ctx.set('paymentId', 'pay_123');
      await ctx.set('status', 'processing'); // ✓ Valid value

      // This would error at compile time:
      // await ctx.set('status', 'invalid'); // ❌ Type error

      return { success: true, paymentId: 'pay_123' };
    },

    shipping: async (ctx) => {
      const paymentId = ctx.context.paymentId; // string | undefined

      if (!paymentId) {
        throw new Error('Payment not completed');
      }

      await ctx.set('shippingId', 'ship_456');
      return { trackingNumber: 'TRACK123' };
    },

    notify: async (ctx) => {
      const { userId, orderId, shippingId } = ctx.context;

      console.log(`Sending notification to user ${userId}`);

      await ctx.set('status', 'completed');
      return { sent: true };
    },
  },
  context: (input: any) => ({
    orderId: input.orderId,
    userId: input.userId,
    total: input.total,
    status: 'pending' as const,
  }),
});

// ============ Example 2: Reusable Context Types ============

interface BaseWorkflowContext {
  workflowId: string;
  createdBy: string;
  createdAt: Date;
}

interface DataPipelineContext extends BaseWorkflowContext {
  sourceUrl: string;
  records: any[];
  processedCount: number;
}

export const dataPipeline = createWorkflow<DataPipelineContext>('data-pipeline', {
  steps: {
    fetch: async (ctx) => {
      // Access base context fields
      console.log(`Created by: ${ctx.context.createdBy}`);

      // Access pipeline-specific fields
      const data = await fetch(ctx.context.sourceUrl);
      const records = await data.json();

      await ctx.set('records', records);
      return { count: records.length };
    },

    transform: async (ctx) => {
      const records = ctx.context.records;
      const transformed = records.map((r: any) => ({ ...r, processed: true }));

      await ctx.set('records', transformed);
      await ctx.set('processedCount', transformed.length);

      return { count: transformed.length };
    },

    load: async (ctx) => {
      // Load to database...
      return { loaded: ctx.context.processedCount };
    },
  },
  context: (input: any) => ({
    workflowId: 'pipeline-1',
    createdBy: input.userId,
    createdAt: new Date(),
    sourceUrl: input.url,
    records: [],
    processedCount: 0,
  }),
});

// ============ Example 3: Conditional Step Typing ============

type ApprovalContext = {
  amount: number;
  requiresApproval: boolean;
  approvedBy?: string;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
};

export const approvalWorkflow = createWorkflow<ApprovalContext>('approval-flow', {
  steps: {
    check: async (ctx) => {
      const requiresApproval = ctx.context.amount > 1000;
      await ctx.set('requiresApproval', requiresApproval);

      if (requiresApproval) {
        await ctx.set('approvalStatus', 'pending');
      }

      return { requiresApproval };
    },

    approve: async (ctx) => {
      if (!ctx.context.requiresApproval) {
        return { skipped: true };
      }

      await ctx.wait('Approval required', {
        amount: ctx.context.amount,
      });

      return { approved: true };
    },

    execute: async (ctx) => {
      if (ctx.context.requiresApproval && !ctx.context.approvedBy) {
        throw new Error('Approval required but not provided');
      }

      return { executed: true };
    },
  },
  context: (input: any) => ({
    amount: input.amount,
    requiresApproval: input.amount > 1000,
  }),
});

// ============ Example 4: Output Type Inference ============

type ValidateOutput = { valid: boolean; errors?: string[] };
type PaymentOutput = { success: boolean; transactionId: string };

export const typedWorkflow = createWorkflow<OrderContext>('typed-order', {
  steps: {
    validate: async (ctx): Promise<ValidateOutput> => {
      return { valid: true }; // Return type enforced
    },

    payment: async (ctx): Promise<PaymentOutput> => {
      return {
        success: true,
        transactionId: 'txn_123',
      };
    },

    shipping: async (ctx) => {
      // Get output from previous step with type
      const paymentResult = ctx.getOutput<PaymentOutput>('payment');

      if (paymentResult?.success) {
        console.log(`Payment ID: ${paymentResult.transactionId}`);
      }

      return { trackingNumber: 'TRACK123' };
    },

    notify: async (ctx) => {
      return { sent: true };
    },
  },
  context: (input: any) => ({
    orderId: input.orderId,
    userId: input.userId,
    total: input.total,
    status: 'pending' as const,
  }),
});

// ============ Example 5: Helper Functions ============

/**
 * Validate context keys at compile time using keyof
 */
function validateContext<TContext extends Record<string, unknown>>(
  ctx: StepContext<TContext>,
  requiredKeys: (keyof TContext)[]
): void {
  for (const key of requiredKeys) {
    if (ctx.context[key] === undefined) {
      throw new Error(`Missing required context field: ${String(key)}`);
    }
  }
}

export const safeWorkflow = createWorkflow<OrderContext>('safe-order', {
  steps: {
    validate: async (ctx) => {
      // Compile-time checked - only valid keys allowed
      validateContext(ctx, ['orderId', 'userId', 'total']);
      // validateContext(ctx, ['invalidKey']); // ❌ Type error

      return { valid: true };
    },
    process: async (ctx) => {
      return { processed: true };
    },
  },
  context: (input: any) => ({
    orderId: input.orderId,
    userId: input.userId,
    total: input.total,
    status: 'pending' as const,
  }),
});

export type { OrderContext, DataPipelineContext, ApprovalContext };
