# Streamline Architecture

> Clean, unopinionated workflow engine for production systems

## Design Philosophy

**"Write less, achieve more. Every line of code should feel like a piece of art."**

Streamline is built for **banks, payment gateways, and critical systems** that need:
- ✅ Durable execution (workflows survive server restarts via heartbeat recovery)
- ✅ Race condition prevention (atomic operations)
- ✅ Unlimited sleep durations (1 year+ for scheduled payments)
- ✅ Multi-server deployment (horizontal scaling)
- ✅ Clean, readable code (not a tangled mess)

> **How Crash Recovery Works:** Steps update a `lastHeartbeat` timestamp during execution.
> If a server crashes mid-step, the SmartScheduler detects stale workflows (no heartbeat for 5 minutes)
> and automatically resumes them. The step re-executes from the beginning - ensure handlers are idempotent.

---

## Core Principles

### 1. **Unopinionated About Your Architecture**

We DON'T force:
- Multi-tenancy patterns (`tenantId`, `orgId`, etc.)
- Authentication/authorization
- API frameworks (works with Express, Fastify, NestJS, etc.)
- Workflow storage location (code vs database)

You choose what's right for YOUR app.

### 2. **Workflows as Code (Recommended)**

```typescript
import { createWorkflow } from '@classytic/streamline';

// Define workflow in code (type-safe, version-controlled)
const orderWorkflow = createWorkflow<OrderContext>('order-processing', {
  steps: {
    payment: { handler: async (ctx) => { /* ... */ }, retries: 3 },
    inventory: async (ctx) => { /* ... */ },
    shipping: async (ctx) => { /* ... */ },
  },
  context: (input) => ({ orderId: input.orderId }),
});
```

**Why code?**
- Type safety with TypeScript
- Version control with Git
- No database queries to load definitions
- Easier testing and debugging

### 3. **Optional Database Storage**

For advanced use cases (UI workflow builders, dynamic workflows), we provide:
```typescript
import { workflowDefinitionRepository } from '@classytic/streamline';

// Store workflow in MongoDB
await workflowDefinitionRepository.create({
  workflowId: 'order-processing',  // Not _id! Multiple versions share same workflowId
  name: 'Order Processing',
  version: '1.0.0',
  steps: [
    { id: 'payment', name: 'Process Payment' },
    { id: 'shipping', name: 'Arrange Shipping' }
  ]
});
```

Most apps should NOT use this. Use code instead.

---

## Multi-Tenancy Pattern

**Problem:** Every app has different multi-tenancy needs:
- SaaS A: `tenantId` at workflow level
- SaaS B: `orgId` + `workspaceId`
- Enterprise C: No multi-tenancy

**Solution:** Don't build it into the engine. Let YOU handle it.

### Approach 1: Use Metadata

```typescript
// Start workflow with tenant context
const run = await engine.start(
  { orderId: 'ORD-123' },
  { tenantId: 'tenant-456', orgId: 'org-789' } // metadata
);

// Add custom index for tenant queries
WorkflowRunModel.collection.createIndex({ 'meta.tenantId': 1, status: 1 });

// Query by tenant in your app
const runs = await WorkflowRunModel.find({
  'meta.tenantId': 'tenant-456',
  status: 'waiting'
});
```

### Approach 2: Extend the Schema

```typescript
import { WorkflowRunModel } from '@classytic/streamline';

// Add tenantId field (do this BEFORE any workflows run)
WorkflowRunModel.schema.add({
  tenantId: { type: String, required: true, index: true }
});

// Add compound index
WorkflowRunModel.schema.index({ tenantId: 1, status: 1 });

// Modify engine.start() to include tenantId in your app layer
```

### Approach 3: Separate Collections Per Tenant

```typescript
// High-scale SaaS pattern
function getTenantWorkflowModel(tenantId: string) {
  return mongoose.model(`workflows_${tenantId}`, WorkflowRunSchema);
}
```

**We stay clean. You choose the pattern that fits YOUR architecture.**

---

## Step Types & Control Flow

### Supported Features

| Feature | Location | Description |
|---------|----------|-------------|
| **Conditional** | `src/features/conditional.ts` | Skip steps based on conditions |
| **Parallel** | `src/features/parallel.ts` | Execute multiple steps simultaneously |
| **Subworkflow** | `src/features/subworkflow.ts` | Call workflows from workflows |
| **Retry Logic** | Built-in | Exponential backoff with configurable retries |
| **Timeout** | Built-in | Step-level timeouts |
| **Wait/Resume** | Built-in | Human-in-the-loop, webhooks |
| **Sleep** | Built-in | Durable timers (unlimited duration) |

### Conditional Steps

```typescript
import { createWorkflow, conditions } from '@classytic/streamline';

const workflow = createWorkflow<{ notificationsEnabled: boolean }>('notify', {
  steps: {
    sendNotification: {
      handler: async (ctx) => { /* send notification */ },
      condition: conditions.equals('notificationsEnabled', true),
    },
  },
  context: (input) => ({ notificationsEnabled: input.notificationsEnabled }),
});
```

### Parallel Execution

```typescript
import { executeParallel } from '@classytic/streamline';

// Execute 3 API calls simultaneously within a step handler
const results = await executeParallel([
  () => callAPI1(),
  () => callAPI2(),
  () => callAPI3()
], { mode: 'all' }); // Wait for all

// Or race mode (first to complete wins)
const fastest = await executeParallel([...], { mode: 'race' });
```

### Loops (Pattern)

**We intentionally DON'T provide built-in loops** because:
- Loops can cause infinite execution (resource exhaustion)
- Most workflows don't need them
- When needed, use subworkflows or retry logic

**Pattern for repetition:**
```typescript
// Option 1: Retry logic (built-in)
const poll = createWorkflow<{}>('poll', {
  steps: {
    pollApi: { handler: async (ctx) => { /* check */ }, retries: 10 },
  },
  context: () => ({}),
});

// Option 2: Array processing in handler
const batch = createWorkflow<{ items: string[] }>('batch', {
  steps: {
    processItems: async (ctx) => {
      for (const item of ctx.context.items) {
        await processItem(item);
      }
      return { processed: ctx.context.items.length };
    },
  },
  context: (input) => ({ items: input.items }),
});
```

---

## Scheduler Architecture (Critical)

### Design Goals
1. **Zero wasted polling** - Only poll when workflows exist
2. **Race-free resumption** - Multiple servers don't duplicate work
3. **Unlimited sleep** - Support 1 year+ delays (bypasses setTimeout limit)
4. **Adaptive performance** - Faster polling under load

### Implementation

```
┌──────────────────────────────────────────────────────┐
│              SmartScheduler                          │
│  • Lazy start (polls only when workflows exist)     │
│  • Auto-stop after 2-min idle                        │
│  • Adaptive intervals (10s → 5min based on load)    │
└──────────────────┬───────────────────────────────────┘
                   │
                   ↓
┌──────────────────────────────────────────────────────┐
│         Dual Timer Mechanism                         │
│  • setTimeout for delays < 24.8 days (fast)         │
│  • MongoDB polling for delays ≥ 24.8 days (durable) │
└──────────────────┬───────────────────────────────────┘
                   │
                   ↓
┌──────────────────────────────────────────────────────┐
│         MongoDB Query (Optimized)                    │
│  find({ status: 'waiting',                          │
│         steps: { $elemMatch: {                       │
│           'waitingFor.resumeAt': { $lte: now }      │
│         }}})                                         │
│  • Uses compound index (status + resumeAt)          │
│  • O(log n) performance                             │
└──────────────────┬───────────────────────────────────┘
                   │
                   ↓
┌──────────────────────────────────────────────────────┐
│         Atomic Resume (Race Prevention)              │
│  updateOne({ _id, status: 'waiting' },              │
│            { status: 'running' })                    │
│  • Only ONE server can claim                         │
│  • Returns modifiedCount = 1 if successful          │
└──────────────────────────────────────────────────────┘
```

### Critical Indexes

```typescript
// REQUIRED for production (prevents collection scans)
WorkflowRunSchema.index({
  status: 1,
  'steps.status': 1,
  'steps.waitingFor.resumeAt': 1
});
```

Without this index, polling queries scan the entire collection (O(n) instead of O(log n)).

---

## Testing Strategy

### In-Memory MongoDB

We use `mongodb-memory-server` for tests:
```typescript
import { setupTestDB, cleanupTestDB, teardownTestDB } from './test/utils/setup';

beforeAll(async () => {
  await setupTestDB(); // Start in-memory MongoDB
});

afterEach(async () => {
  await cleanupTestDB(); // Clean data between tests
});

afterAll(async () => {
  await teardownTestDB(); // Stop MongoDB
});
```

**Benefits:**
- ✅ Fast (no network latency)
- ✅ Isolated (each test gets clean state)
- ✅ No external dependencies (no need for Docker)
- ✅ CI/CD friendly (runs anywhere)

### Test Coverage

| Category | Files | Purpose |
|----------|-------|---------|
| **Core Engine** | `test/core/engine-core.test.ts` | Basic execution, retry, wait/resume |
| **Scheduler** | `test/core/scheduler-core.test.ts` | Timer-based resumption, atomic claims |
| **Edge Cases** | `test/core/edge-cases.test.ts` | Real-world scenarios (payment gateways, APIs) |

### Real-World Test Scenarios

We test scenarios that banks and payment gateways encounter:
```typescript
// API retry with smart backoff
test('should retry on 503, then 429, then succeed on 200');

// Risk-based branching
test('should auto-approve low-risk, require manual review for high-risk');

// 3D Secure payment flow
test('should handle initiate → check → authenticate → process → confirm');

// Race conditions
test('should prevent duplicate resume across 3 server instances');

// Long delays
test('should handle sleep > 24.8 days (setTimeout limit)');
```

---

## When to Use Each Model

### WorkflowRun (Always Used)
- **Every workflow execution** creates a WorkflowRun document
- Stores: context, step states, current position, timestamps
- Indexed for: status queries, scheduler polling, user lookups

### WorkflowDefinition (Optional)
Use ONLY if you need:
- ✅ UI workflow builder (drag-and-drop editor)
- ✅ Dynamic workflows (loaded from database)
- ✅ Collaboration (teams share workflow definitions)
- ✅ Audit trail (who created/modified workflows)

Otherwise: **Define workflows in code** (recommended 90% of the time)

---

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Start workflow | O(1) | Single MongoDB insert |
| Execute step | O(1) | Single MongoDB update |
| Resume workflow | O(log n) | Index-backed query |
| Scheduler poll | O(log n) | With compound index |
| Get workflow by ID | O(1) | Cache-first, then MongoDB |

### Scalability

- **Workflows/day**: Millions (tested with 50 concurrent)
- **Sleep duration**: Unlimited (1 year+)
- **Server instances**: Horizontal scaling with atomic claims
- **Database size**: Use TTL indexes to clean old workflows

```typescript
// Auto-delete completed workflows after 30 days
WorkflowRunSchema.index(
  { status: 1, endedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);
```

---

## Directory Structure

```
src/
├── core/               # Core types, status enums, events
├── execution/          # Engine, executor, scheduler, context
├── workflow/           # Builder, registry (workflow management)
├── storage/            # Models, repositories, cache
├── features/           # Advanced features (parallel, conditional, etc.)
├── integrations/       # Fastify plugin (more coming)
└── utils/              # Helper functions, visualization

test/
├── core/               # Engine, scheduler, edge cases
├── utils/              # Test setup, helpers
└── [legacy tests]      # Will be migrated to test/core/
```

---

## Extension Points

### Custom Context Factory

```typescript
const workflow = createWorkflow<{ user: User }>('with-context', {
  steps: { /* ... */ },
  context: async (input) => {
    // Load user data from database
    const user = await getUserById(input.userId);
    return { user };
  },
});
```

### Custom Event Listeners

```typescript
import { globalEventBus } from '@classytic/streamline';

globalEventBus.on('workflow:started', ({ runId }) => {
  analytics.track('workflow_started', { runId });
});

globalEventBus.on('step:failed', ({ runId, stepId, error }) => {
  logger.error('Step failed', { runId, stepId, error });
});

// Error events for monitoring
globalEventBus.on('engine:error', ({ error, context }) => {
  alerting.notify('Engine error', { error, context });
});
```

---

## Not Included (By Design)

We intentionally DON'T include:
- ❌ Multi-tenancy (you choose the pattern)
- ❌ Authentication/authorization (app layer)
- ❌ API rate limiting (use middleware)
- ❌ Built-in UI (you build it with our visualization helpers)
- ❌ Loops (use subworkflows or retry logic)
- ❌ Complex DAG visualization (export utils provided)

**Why?** These are app-level concerns. We focus on:
- ✅ Durable execution
- ✅ Race-free scheduling
- ✅ Clean APIs
- ✅ Horizontal scaling

---

## Common Patterns

### Payment Gateway Integration

```typescript
import { createWorkflow, createHook, resumeHook } from '@classytic/streamline';

const payment = createWorkflow<{ amount: number }>('payment', {
  steps: {
    initiate: { handler: async (ctx) => { /* ... */ }, timeout: 5000 },
    waitWebhook: async (ctx) => {
      const hook = createHook(ctx, 'payment-callback');
      return ctx.wait('Waiting for payment', { callbackUrl: hook.path });
    },
    processResult: async (ctx) => { /* ... */ },
  },
  context: (input) => ({ amount: input.amount }),
});

// In your webhook endpoint
app.post('/webhooks/payment/:token', async (req, res) => {
  const { run } = await resumeHook(req.params.token, req.body);
  res.json({ received: true, status: run.status });
});
```

### Loan Approval with Manual Review

```typescript
const loan = createWorkflow<{ autoApproved?: boolean }>('loan', {
  steps: {
    creditCheck: async (ctx) => { /* ... */ },
    autoDecision: async (ctx) => { /* ... */ },
    manualReview: {
      handler: async (ctx) => ctx.wait('Manual review required'),
      condition: (context) => !context.autoApproved,
    },
    finalize: async (ctx) => { /* ... */ },
  },
  context: (input) => ({}),
});
```

### Scheduled Payments

```typescript
const scheduled = createWorkflow<{ dueDate: string }>('scheduled-payment', {
  steps: {
    schedule: async (ctx) => {
      const dueDate = new Date(ctx.context.dueDate);
      const delay = dueDate.getTime() - Date.now();
      await ctx.sleep(delay); // Can be months in the future
    },
    processPayment: async (ctx) => { /* ... */ },
  },
  context: (input) => ({ dueDate: input.dueDate }),
});
```

---

## Summary

**Streamline is:**
- ✅ Clean and unopinionated
- ✅ Production-ready for critical systems
- ✅ Horizontally scalable
- ✅ Well-tested with real-world scenarios

**Streamline is NOT:**
- ❌ A full platform (like Temporal Cloud)
- ❌ Opinionated about your architecture
- ❌ Trying to solve every problem

**Use it when:**
- You need durable workflows
- You want control over your infrastructure
- You value clean, readable code
- You're building critical systems (banking, payments, etc.)

**Don't use it when:**
- You need a full managed platform
- You want built-in UI/dashboard
- You need enterprise support contracts
- Your workflows are simple CRON jobs (use node-cron instead)
