---
name: streamline
version: "1.0.0"
description: |
  @classytic/streamline — MongoDB-native durable workflow orchestration engine for Node.js/TypeScript.
  Like Temporal.io but simpler — uses MongoDB for persistence instead of a separate server.
  Use when building durable workflows, approval flows, payment pipelines, scheduled tasks,
  human-in-the-loop processes, multi-step background jobs, or any long-running process that
  must survive crashes and restarts.
  Triggers: workflow, durable execution, sleep, wait, resume, retry, parallel execution,
  human-in-the-loop, approval flow, payment gateway, scheduled task, orchestration, streamline,
  createWorkflow, workflow engine, background job, crash recovery, step context.
tags:
  - workflow
  - orchestration
  - mongodb
  - durable-execution
  - typescript
metadata:
  author: Classytic
  repository: https://github.com/classytic/streamline
progressive_disclosure:
  entry_point:
    summary: "Durable workflow engine on MongoDB — sleep, wait, retry, parallel, human-in-the-loop"
    when_to_use: "When building multi-step processes that must survive crashes"
    quick_start: "1. npm i @classytic/streamline 2. createWorkflow('id', { steps, context }) 3. workflow.start(input)"
  context_limit: 700
---

# @classytic/streamline

MongoDB-native durable workflow orchestration engine. Simpler alternative to Temporal.io.
Requires: `mongoose ^9.0.0`, `@classytic/mongokit ^3.2.3`. Optional: `@opentelemetry/api >=1.0.0`.

## Installation

```bash
npm install @classytic/streamline mongoose @classytic/mongokit
```

## Quick Start

```typescript
import { createWorkflow } from '@classytic/streamline';

const onboarding = createWorkflow('user-onboarding', {
  context: (input: { email: string; name: string }) => ({
    email: input.email,
    name: input.name,
    verified: false,
  }),
  steps: {
    sendEmail: async (ctx) => {
      await sendVerificationEmail(ctx.context.email);
      return { sent: true };
    },
    waitForVerification: async (ctx) => {
      return ctx.wait('Waiting for email verification');
      // Workflow pauses here — survives restarts
    },
    activate: async (ctx) => {
      await ctx.set('verified', true);
      return { activated: true };
    },
  },
});

// Start a workflow
const run = await onboarding.start({ email: 'user@example.com', name: 'Alice' });

// Later — resume when user clicks verification link
await onboarding.resume(run._id, { verified: true });
```

## State Machine

```
draft → running → waiting ↔ running → done
           ↓                    ↓
        failed            cancelled
```

Statuses: `draft`, `running`, `waiting`, `done`, `failed`, `cancelled`.
Step statuses: `pending`, `running`, `waiting`, `done`, `failed`, `skipped`.

## Core API

### `createWorkflow(id, config)`

Creates a workflow definition and returns a `Workflow` instance.

```typescript
import { createWorkflow } from '@classytic/streamline';

const workflow = createWorkflow('payment-flow', {
  steps: {
    charge: async (ctx) => { /* ... */ },
    notify: async (ctx) => { /* ... */ },
  },
  context: (input: PaymentInput) => ({ amount: input.amount, status: 'pending' }),
  version: '1.0.0',
  defaults: { retries: 3, timeout: 30_000 },
  autoExecute: true,   // Auto-run after start (default: true)
  container: myContainer, // Optional DI container
});
```

### Workflow Instance Methods

```typescript
const run = await workflow.start(input, meta?);        // Start new run
const run = await workflow.get(runId);                  // Get run by ID
const run = await workflow.execute(runId);              // Execute pending run
const run = await workflow.resume(runId, payload?);     // Resume waiting run
const run = await workflow.cancel(runId);               // Cancel running/waiting run
const run = await workflow.pause(runId);                // Pause running run
const run = await workflow.rewindTo(runId, stepId);     // Rewind to re-run from a step
const run = await workflow.waitFor(runId, options?);    // Poll until done/failed
workflow.shutdown();                                     // Stop scheduler
```

### Step Context (available inside step handlers)

```typescript
const steps = {
  process: async (ctx) => {
    // Properties
    ctx.runId;        // Current run ID
    ctx.stepId;       // Current step ID
    ctx.context;      // Workflow context (typed)
    ctx.input;        // Workflow input
    ctx.attempt;      // Current retry attempt (1-based)
    ctx.signal;       // AbortSignal for cancellation

    // Update context
    await ctx.set('status', 'processing');

    // Read output from a previous step
    const prev = ctx.getOutput<{ sent: boolean }>('sendEmail');

    // Durable sleep (persisted — survives restarts)
    await ctx.sleep(60_000); // 1 minute

    // Wait for external event (human-in-the-loop)
    return ctx.wait('Approval needed', { orderId: '123' });

    // Wait for named event
    const event = await ctx.waitFor('payment.confirmed');

    // Heartbeat for long-running steps
    await ctx.heartbeat();

    // Emit event
    ctx.emit('step.custom', { data: 'value' });

    // Log
    ctx.log('Processing order', { orderId: '123' });

    return { result: 'done' }; // Step output
  },
};
```

## Hooks (Human-in-the-Loop)

External resume via tokens — perfect for webhooks, email links, approval UIs.

```typescript
import { createHook, resumeHook, hookToken } from '@classytic/streamline';

const steps = {
  requestApproval: async (ctx) => {
    const hook = createHook(ctx, 'waiting-for-manager-approval', {
      token: hookToken('approval', ctx.context.orderId),
    });
    // Send hook.token to external system (email, Slack, webhook)
    return ctx.wait('Manager approval', { token: hook.token, path: hook.path });
  },
};

// External system calls this when approval happens
const { runId, run } = await resumeHook(token, { approved: true, approver: 'manager@co.com' });
```

## Parallel Execution

```typescript
import { executeParallel } from '@classytic/streamline';

const steps = {
  fetchAll: async (ctx) => {
    const results = await executeParallel([
      () => fetchUserProfile(ctx.context.userId),
      () => fetchOrderHistory(ctx.context.userId),
      () => fetchRecommendations(ctx.context.userId),
    ], {
      mode: 'all',           // 'all' | 'race' | 'any' | 'allSettled'
      concurrency: 3,        // Max concurrent tasks
      timeout: 10_000,       // Per-task timeout
    });
    return { profile: results[0], orders: results[1], recs: results[2] };
  },
};
```

## Conditional Steps

```typescript
import { conditions } from '@classytic/streamline';

const workflow = createWorkflow('order-processing', {
  steps: {
    validate: async (ctx) => { /* always runs */ },
    applyDiscount: {
      handler: async (ctx) => { /* ... */ },
      runIf: conditions.greaterThan('amount', 100),
    },
    ship: {
      handler: async (ctx) => { /* ... */ },
      skipIf: conditions.equals('type', 'digital'),
    },
  },
  context: (input) => ({ amount: input.amount, type: input.type }),
});
```

**Built-in conditions:**

```typescript
conditions.hasValue('key')           // context.key is truthy
conditions.equals('key', value)      // context.key === value
conditions.notEquals('key', value)
conditions.greaterThan('key', n)
conditions.lessThan('key', n)
conditions.in('key', [v1, v2])
conditions.and(cond1, cond2)         // Combine
conditions.or(cond1, cond2)
conditions.not(cond)
conditions.custom((ctx) => boolean)
```

## Container (Dependency Injection)

Share repository, event bus, and cache across workflows.

```typescript
import { createContainer } from '@classytic/streamline';

const container = createContainer({
  repository: { /* WorkflowRepositoryConfig */ },
  eventBus: 'global',   // or new WorkflowEventBus()
  cache: new WorkflowCache(),
});

const wf1 = createWorkflow('wf1', { steps: { ... }, container });
const wf2 = createWorkflow('wf2', { steps: { ... }, container });
```

## Events

```typescript
import { globalEventBus } from '@classytic/streamline';

globalEventBus.on('workflow:completed', ({ runId, workflowId, context }) => {
  console.log(`Workflow ${workflowId} run ${runId} completed`);
});

globalEventBus.on('step:failed', ({ runId, stepId, error }) => {
  alertOps(`Step ${stepId} failed: ${error.message}`);
});
```

**Event names:** `workflow:started`, `workflow:completed`, `workflow:failed`, `workflow:waiting`, `workflow:resumed`, `workflow:cancelled`, `workflow:recovered`, `workflow:retry`, `step:started`, `step:completed`, `step:failed`, `step:waiting`, `step:skipped`, `step:retry-scheduled`, `engine:error`, `scheduler:error`, `scheduler:circuit-open`.

## Visualization Helpers

```typescript
import {
  getStepTimeline,
  getWorkflowProgress,
  getStepUIStates,
  getWaitingInfo,
  canRewindTo,
  getExecutionPath,
} from '@classytic/streamline';

const progress = getWorkflowProgress(run);   // { completed, total, percentage }
const timeline = getStepTimeline(run);       // Step-by-step timeline
const uiStates = getStepUIStates(run);       // UI-friendly step states
const waiting = getWaitingInfo(run);          // What the workflow is waiting for
const canRewind = canRewindTo(run, 'step2'); // Can we rewind to this step?
const path = getExecutionPath(run);          // Ordered step IDs executed
```

## Error Handling

```typescript
import { WorkflowError, ErrorCode } from '@classytic/streamline';

try {
  await workflow.resume(runId);
} catch (err) {
  if (err instanceof WorkflowError) {
    switch (err.code) {
      case ErrorCode.WORKFLOW_NOT_FOUND:
      case ErrorCode.WORKFLOW_ALREADY_COMPLETED:
      case ErrorCode.WORKFLOW_CANCELLED:
      case ErrorCode.INVALID_STATE:
      case ErrorCode.INVALID_TRANSITION:
      case ErrorCode.STEP_NOT_FOUND:
      case ErrorCode.STEP_TIMEOUT:
      case ErrorCode.STEP_FAILED:
      case ErrorCode.MAX_RETRIES_EXCEEDED:
      case ErrorCode.DATA_CORRUPTION:
      case ErrorCode.VALIDATION_ERROR:
      case ErrorCode.EXECUTION_ABORTED:
        break;
    }
  }
}
```

**Error classes:** `WorkflowError`, `WorkflowNotFoundError`, `StepNotFoundError`, `InvalidStateError`, `StepTimeoutError`, `DataCorruptionError`, `MaxRetriesExceededError`.

## Query Builder

```typescript
import { WorkflowQueryBuilder } from '@classytic/streamline';

const query = WorkflowQueryBuilder.create()
  .withStatus('running')
  .withWorkflowId('payment-flow')
  .withUserId('user-123')
  .withTags(['priority', 'vip'])
  .notPaused();
```

## Subpath Imports

| Path | Contents |
|------|----------|
| `@classytic/streamline` | Core API: `createWorkflow`, `createContainer`, hooks, parallel, conditions, events, errors, visualization, query builder |
| `@classytic/streamline/fastify` | Fastify plugin |
| `@classytic/streamline/telemetry` | `enableTelemetry`, `disableTelemetry`, OpenTelemetry integration |

## Key Defaults

| Setting | Default |
|---------|---------|
| Retries | 3 attempts |
| Retry delay | Exponential: 1s → 2s → 4s → 8s (max 60s) |
| Step timeout | None (max: 30 min) |
| Heartbeat interval | 30s |
| Stale threshold | 5 min |
| Cache max size | 10,000 entries |
| Max steps/workflow | 1,000 |

## References (Progressive Disclosure)

- **[advanced](references/advanced.md)** — Scheduling, multi-tenancy, telemetry, Fastify plugin, multi-worker deployment
- **[api](references/api.md)** — Complete type signatures, WorkflowRun schema, constants, repository interface
- **[examples](references/examples.md)** — Real-world examples: payment flows, newsletters, AI pipelines, approval workflows
