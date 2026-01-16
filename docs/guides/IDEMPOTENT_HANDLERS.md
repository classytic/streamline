# Idempotent Handler Best Practices

## Overview

In multi-worker deployments, **idempotency is critical**. When multiple workers poll for scheduled/stale workflows, MongoDB atomic operations prevent duplicate execution - but your handlers must also be idempotent to handle edge cases like:

- Network timeouts after successful execution
- Worker crash between DB update and acknowledgment
- Retry after partial completion

**Idempotent** means: executing the same operation multiple times produces the same result as executing it once.

---

## Why Idempotency Matters

### The Problem

```typescript
// NON-IDEMPOTENT - DANGEROUS
const chargeCard = async (ctx) => {
  await stripe.charges.create({ amount: 100, customer: ctx.context.customerId });
  return { charged: true };
};
```

If this step executes twice (network timeout, retry, crash recovery), the customer gets charged twice.

### The Solution

```typescript
// IDEMPOTENT - SAFE
const chargeCard = async (ctx) => {
  const idempotencyKey = `charge_${ctx.run._id}_${ctx.currentStep.stepId}`;

  await stripe.charges.create(
    { amount: 100, customer: ctx.context.customerId },
    { idempotencyKey }
  );
  return { charged: true };
};
```

Stripe ignores duplicate requests with the same idempotency key.

---

## Patterns for Idempotent Handlers

### 1. Use Idempotency Keys (External APIs)

Most payment/API providers support idempotency keys:

```typescript
const processPayment = async (ctx) => {
  // Combine runId + stepId for unique, deterministic key
  const idempotencyKey = `${ctx.run._id}:${ctx.currentStep.stepId}`;

  // Stripe
  const charge = await stripe.charges.create(
    { amount: ctx.context.amount },
    { idempotencyKey }
  );

  return { chargeId: charge.id };
};

const sendEmail = async (ctx) => {
  const messageId = `${ctx.run._id}:${ctx.currentStep.stepId}`;

  // SendGrid (uses custom headers for deduplication)
  await sendgrid.send({
    to: ctx.context.email,
    customArgs: { messageId },
  });

  return { sent: true };
};
```

### 2. Check-Then-Act (Database Operations)

For database writes, check if the operation already succeeded:

```typescript
const createUser = async (ctx) => {
  // Check if user already exists (from previous attempt)
  const existing = await User.findOne({
    workflowRunId: ctx.run._id,
    email: ctx.context.email
  });

  if (existing) {
    // Already created - return existing data
    return { userId: existing._id, alreadyExisted: true };
  }

  // Create new user
  const user = await User.create({
    email: ctx.context.email,
    workflowRunId: ctx.run._id, // Track which workflow created this
  });

  return { userId: user._id };
};
```

### 3. Upsert Pattern (Atomic Check + Create)

Use MongoDB upsert for atomic idempotency:

```typescript
const createOrder = async (ctx) => {
  const orderId = `order_${ctx.run._id}`;

  // Atomic upsert - creates if not exists, returns existing if it does
  const order = await Order.findOneAndUpdate(
    { orderId }, // Query
    {
      $setOnInsert: {
        orderId,
        items: ctx.context.items,
        total: ctx.context.total,
        createdAt: new Date(),
      }
    },
    { upsert: true, new: true }
  );

  return { orderId: order.orderId };
};
```

### 4. Status-Based Idempotency

Track operation status for multi-step processes:

```typescript
const fulfillOrder = async (ctx) => {
  const order = await Order.findById(ctx.context.orderId);

  // Check current status
  switch (order.fulfillmentStatus) {
    case 'fulfilled':
      // Already done - return cached result
      return { trackingNumber: order.trackingNumber, skipped: true };

    case 'shipping':
      // In progress - wait and check
      return await pollForCompletion(order._id);

    case 'pending':
    default:
      // Start fulfillment
      const tracking = await shipOrder(order);
      await Order.updateOne(
        { _id: order._id },
        { fulfillmentStatus: 'fulfilled', trackingNumber: tracking }
      );
      return { trackingNumber: tracking };
  }
};
```

### 5. Output-Based Idempotency

Streamline stores step outputs - use them to detect re-execution:

```typescript
const expensiveComputation = async (ctx) => {
  // Check if we already have output from a previous attempt
  const existingOutput = ctx.currentStep.output;
  if (existingOutput?.computed) {
    return existingOutput; // Return cached result
  }

  // Perform expensive computation
  const result = await performHeavyCalculation(ctx.context.data);

  return { computed: true, result };
};
```

---

## Common Pitfalls

### 1. Non-Deterministic IDs

```typescript
// BAD - generates different ID each execution
const createResource = async (ctx) => {
  const id = crypto.randomUUID(); // Different each time!
  await Resource.create({ id, data: ctx.context.data });
  return { resourceId: id };
};

// GOOD - deterministic ID based on workflow
const createResource = async (ctx) => {
  const id = `resource_${ctx.run._id}_${ctx.currentStep.stepId}`;
  await Resource.findOneAndUpdate(
    { id },
    { $setOnInsert: { id, data: ctx.context.data } },
    { upsert: true }
  );
  return { resourceId: id };
};
```

### 2. Side Effects Without Guards

```typescript
// BAD - sends notification every retry
const notifyAdmin = async (ctx) => {
  await slack.postMessage({ text: 'Order completed!' });
  return { notified: true };
};

// GOOD - checks if already notified
const notifyAdmin = async (ctx) => {
  const notificationId = `notify_${ctx.run._id}_${ctx.currentStep.stepId}`;

  const existing = await NotificationLog.findOne({ notificationId });
  if (existing) return { notified: true, cached: true };

  await slack.postMessage({ text: 'Order completed!' });
  await NotificationLog.create({ notificationId, sentAt: new Date() });

  return { notified: true };
};
```

### 3. Partial Updates

```typescript
// BAD - partial failure leaves inconsistent state
const updateInventory = async (ctx) => {
  for (const item of ctx.context.items) {
    await Inventory.decrement(item.sku, item.quantity);
  }
  return { updated: true };
};

// GOOD - atomic transaction with rollback marker
const updateInventory = async (ctx) => {
  const transactionId = `inv_${ctx.run._id}`;

  // Check if already processed
  const existing = await InventoryTransaction.findOne({ transactionId });
  if (existing?.status === 'completed') {
    return { updated: true, cached: true };
  }

  // Use MongoDB transaction for atomicity
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of ctx.context.items) {
        await Inventory.updateOne(
          { sku: item.sku },
          { $inc: { quantity: -item.quantity } },
          { session }
        );
      }
      await InventoryTransaction.create([{
        transactionId,
        status: 'completed'
      }], { session });
    });
  } finally {
    await session.endSession();
  }

  return { updated: true };
};
```

---

## Testing Idempotency

Write tests that execute handlers multiple times:

```typescript
import { createWorkflow } from '@classytic/streamline';

describe('Idempotent Handlers', () => {
  it('should produce same result on retry', async () => {
    const workflow = createWorkflow('test-idempotency', {
      steps: {
        createOrder: async (ctx) => {
          const orderId = `order_${ctx.run._id}`;
          const order = await Order.findOneAndUpdate(
            { orderId },
            { $setOnInsert: { orderId, amount: ctx.context.amount } },
            { upsert: true, new: true }
          );
          return { orderId: order.orderId };
        },
      },
      context: (input) => ({ amount: input.amount }),
    });

    const run1 = await workflow.start({ amount: 100 });

    // Simulate retry by re-executing the same step
    const run2 = await workflow.execute(run1._id);

    // Should have same orderId
    expect(run2.steps[0].output.orderId).toBe(run1.steps[0].output.orderId);

    // Should only have one order in DB
    const orders = await Order.find({ orderId: { $regex: `^order_${run1._id}` } });
    expect(orders).toHaveLength(1);
  });

  it('should handle concurrent execution safely', async () => {
    const workflow = createWorkflow('concurrent-test', {
      steps: {
        incrementCounter: async (ctx) => {
          const result = await Counter.findOneAndUpdate(
            { key: `counter_${ctx.run._id}` },
            { $inc: { value: 1 }, $setOnInsert: { key: `counter_${ctx.run._id}` } },
            { upsert: true, new: true }
          );
          return { value: result.value };
        },
      },
      context: () => ({}),
    });

    const run = await workflow.start({});

    // Simulate concurrent executions
    const [result1, result2, result3] = await Promise.all([
      workflow.execute(run._id),
      workflow.execute(run._id),
      workflow.execute(run._id),
    ]);

    // Counter should only be incremented once (atomic claiming)
    const counter = await Counter.findOne({ key: `counter_${run._id}` });
    expect(counter.value).toBe(1);
  });
});
```

---

## Checklist

Before deploying to production with multiple workers, verify each handler:

- [ ] **External API calls** use idempotency keys (Stripe, SendGrid, etc.)
- [ ] **Database writes** use upsert or check-then-act pattern
- [ ] **IDs are deterministic** based on `runId` and `stepId`
- [ ] **Side effects** (emails, notifications) have deduplication guards
- [ ] **Multi-step operations** are atomic (transactions) or status-tracked
- [ ] **Tests exist** that execute handlers multiple times

---

## Quick Reference

| Operation | Idempotency Pattern |
|-----------|---------------------|
| Payment | Idempotency key (`runId:stepId`) |
| Email | Message ID deduplication |
| DB Create | Upsert with deterministic ID |
| DB Update | Status-based guard |
| File Upload | Check existence first |
| API Call | Idempotency header |
| Notification | Log-based deduplication |

---

## See Also

- [Multi-Worker Deployment](./MULTI_WORKER_DEPLOYMENT.md) - Scaling with multiple workers
- [Cancellation & Rewind](./CANCELLATION_REWIND.md) - Handling cancelled workflows
- [Step Features](../STEP_FEATURES.md) - Retry configuration and timeouts
