/**
 * Multi-Tenant Example (Recommended Pattern)
 *
 * Use metadata field for tenant isolation
 * - No schema changes required
 * - Flexible (works with any tenant structure)
 * - Add custom indexes for your queries
 */

import mongoose from 'mongoose';
import { createWorkflow, WorkflowRunModel } from '../src/index.js';

// Connect to MongoDB
await mongoose.connect('mongodb://localhost:27017/saas-app');

// 1. Add custom index for tenant queries (do this ONCE on app startup)
await WorkflowRunModel.collection.createIndex({
  'meta.tenantId': 1,
  status: 1,
  createdAt: -1,
});

// 2. Define workflow with inline handlers (shared across all tenants)
interface InvoiceContext {
  invoiceId: string;
  amount: number;
  sent?: boolean;
}

interface InvoiceInput {
  invoiceId: string;
  amount: number;
}

const invoiceWorkflow = createWorkflow<InvoiceContext, InvoiceInput>('invoice-processing', {
  steps: {
    generate: async (ctx) => {
      // Access tenant context from meta (passed at start)
      ctx.log(`Generating invoice ${ctx.context.invoiceId}`);
      return { pdfUrl: `https://cdn.example.com/invoice.pdf` };
    },

    send: async (ctx) => {
      ctx.log(`Sending invoice email`);
      await ctx.set('sent', true);
      return { emailSent: true };
    },

    track: async (ctx) => {
      ctx.log(`Tracking payment for invoice ${ctx.context.invoiceId}`);
      return { tracked: true };
    },
  },
  context: (input) => ({
    invoiceId: input.invoiceId,
    amount: input.amount,
  }),
  version: '1.0.0',
});

// 3. Start workflows for different tenants
// IMPORTANT: Pass tenantId in meta field
const tenant1Run = await invoiceWorkflow.start(
  {
    invoiceId: 'INV-001',
    amount: 500,
  },
  {
    tenantId: 'tenant-123',
    orgName: 'Acme Corp',
  }
);

const tenant2Run = await invoiceWorkflow.start(
  {
    invoiceId: 'INV-002',
    amount: 1000,
  },
  {
    tenantId: 'tenant-456',
    orgName: 'Beta Inc',
  }
);

console.log('Started workflows for 2 tenants');

// 4. Query workflows by tenant (efficient with index)
const tenant1Workflows = await WorkflowRunModel.find({
  'meta.tenantId': 'tenant-123',
  status: { $in: ['running', 'waiting'] },
})
  .sort({ createdAt: -1 })
  .limit(10)
  .lean();

console.log(`Tenant 1 has ${tenant1Workflows.length} active workflows`);

// Wait for completion
await new Promise((resolve) => setTimeout(resolve, 500));

// Get results (tenant-isolated)
const result1 = await invoiceWorkflow.get(tenant1Run._id);
const result2 = await invoiceWorkflow.get(tenant2Run._id);

console.log('Tenant 1 result:', result1?.output);
console.log('Tenant 2 result:', result2?.output);

invoiceWorkflow.shutdown();
await mongoose.disconnect();
