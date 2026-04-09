# Delivery Semantics & Distributed Operation

## What Streamline Guarantees

### Step Execution: At-Least-Once

Steps may re-execute after a crash. If a process dies mid-step, the stale recovery
mechanism detects the orphaned workflow (via heartbeat timeout) and re-executes the
current step from the beginning. **Handlers must be idempotent.**

### State Transitions: Exactly-Once via MongoDB Atomic Ops

Workflow state transitions (pending → running → done) use MongoDB `updateOne` with
conditional filters (`status: { $ne: 'cancelled' }`). Only one worker can claim a step.
If two workers race, exactly one succeeds (modifiedCount === 1).

### Event Delivery: At-Most-Once (in-memory)

The default `WorkflowEventBus` is process-local. Events are lost if the process crashes
between emitting and handling. For durable event delivery, plug in a `SignalStore`
adapter (Redis, Kafka, etc.) — this upgrades to at-least-once.

### Hook Resume: At-Least-Once via DB Fallback

`resumeHook()` first tries the in-memory `hookRegistry` (fast path). If the engine isn't
in this process (e.g., after restart), it falls back to direct MongoDB operations. The
DB fallback uses atomic claims to prevent double-resume.

### Checkpoint: Durable on Write

`ctx.checkpoint(value)` writes to MongoDB synchronously (awaited). If the process crashes
after a checkpoint, recovery reads the last value. Checkpoints are idempotent — writing
the same value twice is safe.

## Deployment Modes

### Single-Node (Default)

One process, one engine per workflow. MongoDB is the only external dependency.
All features work out of the box. No distributed concerns.

### Multi-Worker (Supported)

Multiple processes running the same workflow definition against the same MongoDB.
Works because:
- Step claiming is atomic (MongoDB conditional updates)
- Heartbeat-based stale detection recovers orphaned workflows
- `resumeHook()` DB fallback works cross-process

**Requirements:**
- All workers must run the same code version (or use compatible step sets)
- Clocks should be roughly synchronized (within stale threshold: 5 min)
- MongoDB must be a replica set for `w: majority` write concern

### Distributed / Multi-Region (Not Built For This)

Streamline does not provide:
- Cross-region coordination
- Worker lease management
- Scheduler sharding / leader election
- Delivery guarantees beyond MongoDB's consistency model
- Built-in outbox pattern for external side effects

If you need these, use Temporal, Inngest, or a managed workflow service.

## Handler Idempotency Guide

Since steps execute at-least-once, handlers that produce external side effects
need idempotency. Common patterns:

```typescript
// Pattern 1: Idempotency key from workflow context
const paymentStep = async (ctx) => {
  const idempotencyKey = `${ctx.runId}:${ctx.stepId}:${ctx.attempt}`;
  const result = await stripe.charges.create({
    amount: ctx.context.amount,
    idempotency_key: idempotencyKey,
  });
  return result;
};

// Pattern 2: Check-then-act with external state
const sendEmailStep = async (ctx) => {
  const sent = await db.emails.findOne({ runId: ctx.runId, stepId: ctx.stepId });
  if (sent) return sent; // Already sent on previous attempt
  const result = await sendEmail(ctx.context.to, ctx.context.body);
  await db.emails.insertOne({ runId: ctx.runId, stepId: ctx.stepId, ...result });
  return result;
};

// Pattern 3: Checkpoint for batch progress
const batchStep = async (ctx) => {
  const lastProcessed = ctx.getCheckpoint<number>() ?? 0;
  for (let i = lastProcessed; i < items.length; i++) {
    await processItem(items[i]);
    await ctx.checkpoint(i + 1);
  }
};
```

## Comparison with Alternatives

| Feature | Streamline | Vercel Workflow | Temporal |
|---------|-----------|----------------|----------|
| Infra required | MongoDB only | Vercel platform | Temporal server + DB |
| Step execution | At-least-once | Exactly-once (replay) | Exactly-once (replay) |
| State store | MongoDB | Vercel backend | Cassandra/MySQL |
| Distributed scheduler | Claim-based polling | Managed | Worker task queues |
| Worker versioning | Not built-in | Not built-in | Task queue versioning |
| Lease model | Heartbeat-based | Managed | Sticky task queues |
| Cost | Self-hosted | Per-invocation | Self-hosted or Cloud |
| Setup complexity | `npm install` + MongoDB | `npm install` + deploy | Cluster setup |
