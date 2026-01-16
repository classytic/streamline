# Cancellation & Rewind Guide

## Overview

Streamline provides two mechanisms for controlling workflow execution flow:

1. **Cancellation** - Terminally stop a workflow (no further execution)
2. **Rewind** - Roll back to a previous step and re-execute from there

Both operations are **strictly enforced at the database level** to ensure consistency in multi-worker deployments.

---

## Cancellation

### Basic Usage

```typescript
import { createWorkflow } from '@classytic/streamline';

const workflow = createWorkflow('order-process', {
  steps: {
    validate: async (ctx) => { /* ... */ },
    charge: async (ctx) => { /* ... */ },
    fulfill: async (ctx) => { /* ... */ },
  },
  context: (input) => input,
});

// Start workflow
const run = await workflow.start({ orderId: '123' });

// Cancel it
const cancelled = await workflow.cancel(run._id);
console.log(cancelled.status); // 'cancelled'
```

### Cancellation Semantics

Cancellation in Streamline is **strictly terminal**:

| Property | Behavior |
|----------|----------|
| State | `status = 'cancelled'` (immutable) |
| DB Guard | All updates include `{ status: { $ne: 'cancelled' } }` filter |
| In-Flight | Currently executing handlers are aborted via `AbortController` |
| Retries | No retry scheduling after cancellation |
| Resume | Cannot resume a cancelled workflow |
| Rewind | Cannot rewind a cancelled workflow |

### Handling Cancellation in Handlers

Use `ctx.signal` to detect cancellation:

```typescript
const longRunningStep = async (ctx) => {
  // Option 1: Check signal periodically
  for (let i = 0; i < 1000; i++) {
    if (ctx.signal?.aborted) {
      console.log('Cancelled, cleaning up...');
      await cleanup();
      throw ctx.signal.reason; // Re-throw to stop execution
    }
    await processItem(i);
  }

  // Option 2: Pass signal to fetch/external calls
  const response = await fetch(url, { signal: ctx.signal });

  return { processed: true };
};
```

### Cleanup After Cancellation

Since cancellation aborts in-flight handlers, implement cleanup logic:

```typescript
const chargeCard = async (ctx) => {
  let paymentIntent = null;

  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: ctx.context.amount,
      idempotencyKey: `${ctx.run._id}:${ctx.currentStep.stepId}`,
    });

    // Check if cancelled before confirmation
    if (ctx.signal?.aborted) {
      await stripe.paymentIntents.cancel(paymentIntent.id);
      throw ctx.signal.reason;
    }

    await stripe.paymentIntents.confirm(paymentIntent.id);
    return { paymentId: paymentIntent.id };
  } catch (error) {
    // Clean up on any error (including cancellation)
    if (paymentIntent && error.name !== 'AbortError') {
      await stripe.paymentIntents.cancel(paymentIntent.id).catch(() => {});
    }
    throw error;
  }
};
```

### Cancellation Events

Listen for cancellation events via the event bus:

```typescript
import { eventBus } from '@classytic/streamline';

eventBus.on('workflow:cancelled', ({ runId, workflowId }) => {
  console.log(`Workflow ${runId} was cancelled`);
  // Notify user, release resources, etc.
});
```

---

## Rewind

Rewind allows you to "go back in time" and re-execute from a previous step.

### Basic Usage

```typescript
// Workflow completed but fulfillment failed
const run = await workflow.get(runId);
// run.status = 'done', steps = [validate: done, charge: done, fulfill: failed]

// Rewind to re-try fulfillment
const rewound = await workflow.rewindTo(runId, 'fulfill');
// rewound.status = 'running', fulfill step reset to 'pending'

// Execute from the rewound point
const completed = await workflow.execute(runId);
```

### Rewind Behavior

| Property | Behavior |
|----------|----------|
| Target Step | Reset to `status: 'pending'`, output cleared |
| Subsequent Steps | Reset to `status: 'pending'`, outputs cleared |
| Previous Steps | Preserved (outputs remain available) |
| Context | Preserved (not modified) |
| Workflow Status | Set to `'running'` |

### Valid Rewind Targets

You can only rewind to steps that have been executed:

```typescript
// Valid: rewind to a completed step
await workflow.rewindTo(runId, 'charge'); // OK if charge was 'done'

// Valid: rewind to a failed step
await workflow.rewindTo(runId, 'fulfill'); // OK if fulfill was 'failed'

// Invalid: rewind to a pending step
await workflow.rewindTo(runId, 'notify'); // Error if notify is still 'pending'

// Invalid: step doesn't exist
await workflow.rewindTo(runId, 'nonexistent'); // StepNotFoundError
```

### Rewind with Idempotency

When rewinding, ensure handlers are idempotent:

```typescript
const chargeCard = async (ctx) => {
  const idempotencyKey = `${ctx.run._id}:charge:${ctx.run.steps.length}`;
  // Include step count in key so rewind gets fresh execution

  // OR: Use a rewind-aware key
  const rewindCount = ctx.currentStep.retryCount || 0;
  const idempotencyKey = `${ctx.run._id}:charge:v${rewindCount}`;
};
```

### Rewind Use Cases

**1. Retry Failed Steps After Manual Fix**

```typescript
// API was down, now it's back
const failed = await workflow.get(runId);
if (failed.steps.find(s => s.stepId === 'callApi')?.status === 'failed') {
  await workflow.rewindTo(runId, 'callApi');
  await workflow.execute(runId);
}
```

**2. Re-process with Updated Context**

```typescript
// Update context before rewind
const run = await WorkflowRun.findByIdAndUpdate(
  runId,
  { $set: { 'context.newData': updatedData } },
  { new: true }
);

// Rewind and re-execute
await workflow.rewindTo(runId, 'processData');
await workflow.execute(runId);
```

**3. Approval Workflow Rejection**

```typescript
const approvalWorkflow = createWorkflow('document-approval', {
  steps: {
    submit: async (ctx) => { /* ... */ },
    review: async (ctx) => {
      // Wait for human review
      return ctx.wait('Awaiting review');
    },
    process: async (ctx) => {
      const review = ctx.getOutput('review');
      if (!review.approved) {
        // Will be rewound if rejected
        throw new Error('Rejected');
      }
      return { processed: true };
    },
  },
});

// Reviewer rejects - rewind to allow resubmission
await approvalWorkflow.rewindTo(runId, 'review');
```

---

## API Reference

### `workflow.cancel(runId: string)`

Cancels a workflow run.

```typescript
const cancelled = await workflow.cancel(runId);
// Returns: WorkflowRun with status: 'cancelled'
```

**Throws:**
- `WorkflowNotFoundError` - If run doesn't exist
- No error if already cancelled (idempotent)

### `workflow.rewindTo(runId: string, stepId: string)`

Rewinds workflow to a specific step.

```typescript
const rewound = await workflow.rewindTo(runId, 'targetStep');
// Returns: WorkflowRun with targetStep and subsequent steps reset
```

**Throws:**
- `WorkflowNotFoundError` - If run doesn't exist
- `StepNotFoundError` - If step doesn't exist
- `InvalidStateError` - If workflow is cancelled or step not yet executed

---

## State Diagram

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌──────┐  start  ┌─────────┐  execute  ┌──────┐          │
│draft │ ──────► │ running │ ────────► │ done │          │
└──────┘         └────┬────┘           └──────┘          │
                      │                    │              │
                      │ wait()             │ rewindTo()   │
                      ▼                    │              │
                 ┌─────────┐               │              │
                 │ waiting │◄──────────────┘              │
                 └────┬────┘                              │
                      │                                   │
                      │ resume()                          │
                      │                                   │
                      └───────────────────────────────────┘

                      │
        cancel()      │     (from any non-cancelled state)
                      ▼
               ┌───────────┐
               │ cancelled │  (TERMINAL - no transitions out)
               └───────────┘
```

---

## Best Practices

### 1. Always Handle Cancellation Signal

```typescript
// GOOD
const handler = async (ctx) => {
  if (ctx.signal?.aborted) throw ctx.signal.reason;
  // ... work
};

// BETTER - for long operations
const handler = async (ctx) => {
  await someAsyncWork({ signal: ctx.signal });
};
```

### 2. Design for Rewind

```typescript
// GOOD - idempotent with rewind-awareness
const handler = async (ctx) => {
  const key = `${ctx.run._id}:${ctx.currentStep.stepId}:${ctx.currentStep.retryCount}`;
  // Each rewind gets fresh execution
};
```

### 3. Don't Depend on Cancelled State Internally

```typescript
// BAD - checking status in handler
const handler = async (ctx) => {
  if (ctx.run.status === 'cancelled') return; // Won't work - status checked at DB level
};

// GOOD - use signal
const handler = async (ctx) => {
  if (ctx.signal?.aborted) throw ctx.signal.reason;
};
```

### 4. Clean Up External Resources

```typescript
const handler = async (ctx) => {
  const resource = await acquireResource();
  try {
    await processWithResource(resource, { signal: ctx.signal });
    return { success: true };
  } catch (error) {
    await releaseResource(resource);
    throw error;
  }
};
```

---

## See Also

- [Idempotent Handlers](./IDEMPOTENT_HANDLERS.md) - Making handlers safe for rewind/retry
- [Multi-Worker Deployment](./MULTI_WORKER_DEPLOYMENT.md) - Cancellation in distributed environments
- [Step Features](../STEP_FEATURES.md) - Retry and timeout configuration
