/**
 * Birthday Automation Example
 *
 * Use case: Send birthday messages to ALL customers
 * - Runs daily via cron
 * - Loops through birthday customers
 * - Sends WhatsApp messages in batches
 * - Handles rate limiting
 */

import cron from 'node-cron';
import mongoose from 'mongoose';
import { createWorkflow, executeParallel } from '../src/index.js';

// Connect to MongoDB
await mongoose.connect('mongodb://localhost:27017/crm-app');

// Mock database
interface Customer {
  id: string;
  name: string;
  phone: string;
  birthdate: Date;
}

async function getTodaysBirthdays(): Promise<Customer[]> {
  // Mock - in real app, query your database
  const today = new Date();
  const month = today.getMonth();
  const day = today.getDate();

  return [
    {
      id: '1',
      name: 'Alice',
      phone: '+1234567890',
      birthdate: new Date(1990, month, day),
    },
    {
      id: '2',
      name: 'Bob',
      phone: '+0987654321',
      birthdate: new Date(1985, month, day),
    },
    // ... more customers
  ];
}

async function sendWhatsAppMessage(phone: string, message: string): Promise<boolean> {
  // Mock - in real app, call WhatsApp Business API
  console.log(`[WhatsApp] Sending to ${phone}: ${message}`);
  await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate API call
  return true;
}

// 1. Define workflow with inline handlers
interface BirthdayContext {
  date: Date;
  customers?: Customer[];
  successCount?: number;
  failedCount?: number;
}

interface BirthdayInput {
  date: Date;
}

const birthdayWorkflow = createWorkflow<BirthdayContext, BirthdayInput>('birthday-automation', {
  steps: {
    'fetch-birthdays': async (ctx) => {
      const customers = await getTodaysBirthdays();
      await ctx.set('customers', customers);
      ctx.log(`Found ${customers.length} birthday customers`);
      return { count: customers.length };
    },

    'send-messages': async (ctx) => {
      const customers = ctx.context.customers || [];

      if (customers.length === 0) {
        return { success: 0, failed: 0 };
      }

      // Send in batches of 10 (parallel) to respect rate limits
      const batchSize = 10;
      let successCount = 0;
      let failedCount = 0;

      for (let i = 0; i < customers.length; i += batchSize) {
        const batch = customers.slice(i, i + batchSize);

        ctx.log(
          `Sending batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(customers.length / batchSize)}`
        );

        // Send batch in parallel
        const results = await executeParallel(
          batch.map((customer) => async () => {
            const message = `Happy Birthday ${customer.name}! Wishing you a wonderful day from our team!`;
            try {
              await sendWhatsAppMessage(customer.phone, message);
              return { success: true, customer: customer.name };
            } catch (error) {
              console.error(`Failed to send to ${customer.name}:`, error);
              return { success: false, customer: customer.name };
            }
          }),
          { mode: 'allSettled', concurrency: 10 }
        );

        // Count successes and failures
        results.forEach((result) => {
          if (result.success) successCount++;
          else failedCount++;
        });

        // Rate limiting: Wait 1 second between batches
        if (i + batchSize < customers.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      await ctx.set('successCount', successCount);
      await ctx.set('failedCount', failedCount);

      return { success: successCount, failed: failedCount };
    },

    'log-results': async (ctx) => {
      const { successCount = 0, failedCount = 0, customers = [] } = ctx.context;

      ctx.log(`
        ========================================
        Birthday Campaign Complete
        ========================================
        Date: ${ctx.context.date.toDateString()}
        Total Customers: ${customers.length}
        Successfully Sent: ${successCount}
        Failed: ${failedCount}
        ========================================
      `);

      return {
        summary: {
          date: ctx.context.date,
          total: customers.length,
          success: successCount,
          failed: failedCount,
        },
      };
    },
  },
  context: (input) => ({
    date: input.date,
  }),
  version: '1.0.0',
  defaults: { timeout: 300000 }, // 5 min timeout for send-messages step
});

// 2. Schedule with cron (runs every day at 9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('[CRON] Running birthday automation...');

  try {
    const run = await birthdayWorkflow.start({ date: new Date() });
    console.log(`[CRON] Workflow started: ${run._id}`);
  } catch (error) {
    console.error('[CRON] Failed to start workflow:', error);
  }
});

console.log('Birthday automation scheduled (9 AM daily)');

// 3. Manual trigger (for testing)
console.log('Running manual test...');
const testRun = await birthdayWorkflow.start({ date: new Date() });
console.log('Test workflow started:', testRun._id);

// Wait for completion
await new Promise((resolve) => setTimeout(resolve, 5000));

const result = await birthdayWorkflow.get(testRun._id);
console.log('Test workflow status:', result?.status);
console.log('Test workflow output:', result?.output);

// Keep process alive for cron
// process.stdin.resume();
