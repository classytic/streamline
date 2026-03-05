# Real-World Examples

## Payment Processing

Multi-step payment with retry, wait for webhook, and notification.

```typescript
import { createWorkflow, createHook, resumeHook, hookToken } from '@classytic/streamline';

interface PaymentContext {
  orderId: string;
  amount: number;
  currency: string;
  chargeId: string | null;
  status: 'pending' | 'charged' | 'confirmed' | 'notified';
}

const paymentFlow = createWorkflow('payment-processing', {
  context: (input: { orderId: string; amount: number; currency: string }) => ({
    orderId: input.orderId,
    amount: input.amount,
    currency: input.currency,
    chargeId: null,
    status: 'pending' as const,
  }),
  defaults: { retries: 3, timeout: 30_000 },
  steps: {
    createCharge: async (ctx) => {
      const charge = await stripe.charges.create({
        amount: ctx.context.amount,
        currency: ctx.context.currency,
      });
      await ctx.set('chargeId', charge.id);
      await ctx.set('status', 'charged');
      return { chargeId: charge.id };
    },

    waitForConfirmation: async (ctx) => {
      const hook = createHook(ctx, 'waiting-for-stripe-webhook', {
        token: hookToken('payment', ctx.context.orderId),
      });
      // Stripe webhook will call resumeHook with this token
      return ctx.wait('Waiting for payment confirmation', {
        token: hook.token,
        webhookUrl: `/webhooks/payment/${hook.token}`,
      });
    },

    sendReceipt: async (ctx) => {
      await ctx.set('status', 'confirmed');
      await emailService.sendReceipt(ctx.context.orderId, ctx.context.amount);
      await ctx.set('status', 'notified');
      return { notified: true };
    },
  },
});

// Start payment
const run = await paymentFlow.start({
  orderId: 'order-123',
  amount: 9900,
  currency: 'usd',
});

// Webhook handler (e.g., in Express/Fastify route)
app.post('/webhooks/payment/:token', async (req, res) => {
  const { runId } = await resumeHook(req.params.token, {
    confirmed: true,
    stripeEventId: req.body.id,
  });
  res.json({ ok: true, runId });
});
```

## Approval Workflow

Manager approval with timeout escalation.

```typescript
import { createWorkflow, executeParallel } from '@classytic/streamline';

interface ApprovalContext {
  requestId: string;
  requestedBy: string;
  amount: number;
  approver: string | null;
  approved: boolean;
}

const approvalFlow = createWorkflow('expense-approval', {
  context: (input: { requestId: string; requestedBy: string; amount: number }) => ({
    requestId: input.requestId,
    requestedBy: input.requestedBy,
    amount: input.amount,
    approver: null,
    approved: false,
  }),
  steps: {
    notifyManager: async (ctx) => {
      await slack.sendMessage('#approvals', {
        text: `Expense request $${ctx.context.amount} from ${ctx.context.requestedBy}`,
        actions: [
          { text: 'Approve', value: 'approve' },
          { text: 'Reject', value: 'reject' },
        ],
      });
      return { notified: true };
    },

    waitForDecision: async (ctx) => {
      return ctx.wait('Waiting for manager approval', {
        requestId: ctx.context.requestId,
      });
      // Resume with: workflow.resume(runId, { approved: true, approver: 'manager@co.com' })
    },

    processDecision: async (ctx) => {
      // The resume payload is available as step input
      const decision = ctx.input as { approved: boolean; approver: string };
      await ctx.set('approved', decision.approved);
      await ctx.set('approver', decision.approver);

      if (decision.approved) {
        await accountingService.processExpense(ctx.context.requestId);
      }

      return { approved: decision.approved };
    },

    notifyResult: async (ctx) => {
      const status = ctx.context.approved ? 'approved' : 'rejected';
      await executeParallel([
        () => email.send(ctx.context.requestedBy, `Your expense was ${status}`),
        () => slack.sendMessage('#approvals', `Expense ${ctx.context.requestId}: ${status}`),
      ]);
      return { notified: true };
    },
  },
});
```

## Newsletter Automation

Scheduled newsletter with recipient batching.

```typescript
import { createWorkflow, executeParallel } from '@classytic/streamline';

interface NewsletterContext {
  campaignId: string;
  subject: string;
  htmlContent: string;
  recipients: string[];
  batchSize: number;
  sentCount: number;
}

const newsletterFlow = createWorkflow('newsletter-send', {
  context: (input: { campaignId: string; subject: string; html: string; recipients: string[] }) => ({
    campaignId: input.campaignId,
    subject: input.subject,
    htmlContent: input.html,
    recipients: input.recipients,
    batchSize: 100,
    sentCount: 0,
  }),
  steps: {
    validateContent: async (ctx) => {
      if (!ctx.context.subject) throw new Error('Subject is required');
      if (!ctx.context.recipients.length) throw new Error('No recipients');
      ctx.log(`Sending to ${ctx.context.recipients.length} recipients`);
      return { valid: true, totalRecipients: ctx.context.recipients.length };
    },

    sendBatches: async (ctx) => {
      const { recipients, batchSize, subject, htmlContent } = ctx.context;
      const batches = [];

      for (let i = 0; i < recipients.length; i += batchSize) {
        batches.push(recipients.slice(i, i + batchSize));
      }

      let sent = 0;
      for (const batch of batches) {
        await executeParallel(
          batch.map((email) => () =>
            ses.sendEmail({ to: email, subject, html: htmlContent })
          ),
          { concurrency: 10 }
        );
        sent += batch.length;
        await ctx.set('sentCount', sent);
        await ctx.heartbeat(); // Keep alive during long sends
        ctx.log(`Sent ${sent}/${recipients.length}`);
      }

      return { totalSent: sent };
    },

    recordAnalytics: async (ctx) => {
      await analytics.record({
        campaignId: ctx.context.campaignId,
        sent: ctx.context.sentCount,
        timestamp: new Date(),
      });
      return { recorded: true };
    },
  },
});
```

## AI Pipeline

Multi-step LLM processing with structured output.

```typescript
import { createWorkflow } from '@classytic/streamline';

interface AIContext {
  topic: string;
  research: string | null;
  outline: string | null;
  draft: string | null;
  finalArticle: string | null;
}

const articlePipeline = createWorkflow('ai-article-pipeline', {
  context: (input: { topic: string }) => ({
    topic: input.topic,
    research: null,
    outline: null,
    draft: null,
    finalArticle: null,
  }),
  defaults: { retries: 2, timeout: 120_000 }, // LLM calls can be slow
  steps: {
    research: async (ctx) => {
      const result = await llm.complete({
        prompt: `Research the topic: ${ctx.context.topic}. Provide key facts, statistics, and sources.`,
      });
      await ctx.set('research', result.text);
      return { research: result.text };
    },

    outline: async (ctx) => {
      const result = await llm.complete({
        prompt: `Create an article outline about "${ctx.context.topic}" using this research:\n${ctx.context.research}`,
      });
      await ctx.set('outline', result.text);
      return { outline: result.text };
    },

    draft: async (ctx) => {
      const result = await llm.complete({
        prompt: `Write a full article following this outline:\n${ctx.context.outline}\n\nUsing this research:\n${ctx.context.research}`,
      });
      await ctx.set('draft', result.text);
      return { draft: result.text };
    },

    review: async (ctx) => {
      // Human review step
      return ctx.wait('Article ready for review', {
        draft: ctx.context.draft,
        topic: ctx.context.topic,
      });
    },

    finalize: async (ctx) => {
      const feedback = ctx.input as { feedback?: string; approved: boolean };
      if (!feedback.approved) {
        throw new Error(`Article rejected: ${feedback.feedback}`);
      }

      const final = feedback.feedback
        ? await llm.complete({
            prompt: `Revise this article based on feedback: "${feedback.feedback}"\n\n${ctx.context.draft}`,
          })
        : { text: ctx.context.draft };

      await ctx.set('finalArticle', final.text);
      return { article: final.text };
    },
  },
});
```

## Conditional Order Processing

Different paths based on order type.

```typescript
import { createWorkflow, conditions } from '@classytic/streamline';

interface OrderContext {
  orderId: string;
  type: 'physical' | 'digital' | 'subscription';
  amount: number;
  requiresShipping: boolean;
  shippingAddress?: string;
}

const orderFlow = createWorkflow('order-fulfillment', {
  context: (input: { orderId: string; type: string; amount: number; address?: string }) => ({
    orderId: input.orderId,
    type: input.type as OrderContext['type'],
    amount: input.amount,
    requiresShipping: input.type === 'physical',
    shippingAddress: input.address,
  }),
  steps: {
    validateOrder: async (ctx) => {
      if (ctx.context.requiresShipping && !ctx.context.shippingAddress) {
        throw new Error('Shipping address required for physical orders');
      }
      return { valid: true };
    },

    processPayment: async (ctx) => {
      const charge = await paymentGateway.charge(ctx.context.amount);
      return { chargeId: charge.id };
    },

    // Only runs for physical products
    shipOrder: {
      handler: async (ctx) => {
        const tracking = await shipping.createLabel(ctx.context.shippingAddress!);
        return { trackingNumber: tracking.number };
      },
      runIf: conditions.equals('type', 'physical'),
    },

    // Only runs for digital products
    grantAccess: {
      handler: async (ctx) => {
        await licenses.grant(ctx.context.orderId);
        return { accessGranted: true };
      },
      runIf: conditions.in('type', ['digital', 'subscription']),
    },

    // Only for orders over $100
    notifyVIP: {
      handler: async (ctx) => {
        await vipService.notify(ctx.context.orderId);
        return { vipNotified: true };
      },
      runIf: conditions.greaterThan('amount', 100),
    },

    sendConfirmation: async (ctx) => {
      await email.sendOrderConfirmation(ctx.context.orderId);
      return { confirmed: true };
    },
  },
});
```

## Sleep/Timer Workflow

Scheduled follow-ups with durable timers.

```typescript
import { createWorkflow } from '@classytic/streamline';

const trialFlow = createWorkflow('trial-nurture', {
  context: (input: { userId: string; email: string; plan: string }) => ({
    userId: input.userId,
    email: input.email,
    plan: input.plan,
    converted: false,
  }),
  steps: {
    welcomeEmail: async (ctx) => {
      await email.send(ctx.context.email, 'Welcome to your trial!');
      return { sent: true };
    },

    waitDay3: async (ctx) => {
      await ctx.sleep(3 * 24 * 60 * 60 * 1000); // 3 days — durable, survives restarts
      return { waited: true };
    },

    day3Checkin: async (ctx) => {
      await email.send(ctx.context.email, 'How is your trial going?');
      return { sent: true };
    },

    waitDay7: async (ctx) => {
      await ctx.sleep(4 * 24 * 60 * 60 * 1000); // 4 more days (day 7 total)
      return { waited: true };
    },

    day7Offer: async (ctx) => {
      await email.send(ctx.context.email, 'Special offer: 20% off if you upgrade today!');
      return { sent: true };
    },

    waitDay14: async (ctx) => {
      await ctx.sleep(7 * 24 * 60 * 60 * 1000); // 7 more days (day 14 total)
      return { waited: true };
    },

    trialExpiry: async (ctx) => {
      const user = await db.users.findById(ctx.context.userId);
      if (user.subscribed) {
        await ctx.set('converted', true);
        return { converted: true };
      }
      await email.send(ctx.context.email, 'Your trial has expired');
      return { converted: false };
    },
  },
});
```

## Testing Workflows

Use container-based isolation for tests.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createWorkflow, createContainer } from '@classytic/streamline';
import { WorkflowEventBus } from '@classytic/streamline';

describe('payment workflow', () => {
  let container;

  beforeEach(async () => {
    // Each test gets its own container — isolated state
    container = createContainer({
      eventBus: new WorkflowEventBus(), // Fresh event bus per test
    });
  });

  it('should process payment end-to-end', async () => {
    const workflow = createWorkflow('test-payment', {
      steps: {
        charge: async (ctx) => {
          await ctx.set('charged', true);
          return { chargeId: 'ch_test' };
        },
        notify: async (ctx) => {
          return { notified: true };
        },
      },
      context: () => ({ charged: false }),
      container,
    });

    const run = await workflow.start({});
    expect(run.status).toBe('done');
    expect(run.context.charged).toBe(true);
    expect(run.steps[0].output).toEqual({ chargeId: 'ch_test' });
  });

  it('should handle wait and resume', async () => {
    const workflow = createWorkflow('test-approval', {
      steps: {
        request: async (ctx) => {
          return ctx.wait('Need approval');
        },
        process: async (ctx) => {
          return { processed: true };
        },
      },
      context: () => ({}),
      container,
    });

    const run = await workflow.start({});
    expect(run.status).toBe('waiting');

    const resumed = await workflow.resume(run._id, { approved: true });
    expect(resumed.status).toBe('done');
  });
});
```
