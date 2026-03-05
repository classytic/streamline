# Advanced Features

## Scheduling (Timezone-Aware)

Schedule workflows to run at specific times with full DST/timezone support.

```typescript
import { SchedulingService } from '@classytic/streamline';

const scheduler = new SchedulingService(workflow, handlers, {
  // SchedulingServiceConfig options
});

// Schedule a workflow
const run = await scheduler.schedule({
  scheduledFor: '2025-03-15T09:00:00',
  timezone: 'America/New_York',
  input: { task: 'daily-report' },
});

// Reschedule
await scheduler.reschedule(run._id, {
  scheduledFor: '2025-03-16T09:00:00',
  timezone: 'America/New_York',
});

// Cancel scheduled workflow
await scheduler.cancel(run._id);

// List scheduled workflows
const { items, total } = await scheduler.getScheduledWorkflows({
  page: 1,
  limit: 20,
});
```

### Timezone Handler

```typescript
import { TimezoneHandler, timezoneHandler } from '@classytic/streamline';

const result = TimezoneHandler.calculate('2025-03-15T09:00:00', 'America/New_York');
// Returns: { utcDate, localDate, offset, isDST, ... }
```

Uses `luxon` under the hood for reliable DST transitions.

## Multi-Tenancy

### Tenant Filter Plugin

Automatically scopes all queries to a tenant.

```typescript
import { tenantFilterPlugin, singleTenantPlugin } from '@classytic/streamline';

// Dynamic tenant (from request context)
const plugin = tenantFilterPlugin({
  tenantField: 'context.tenantId',  // Default field path
  strict: true,                      // Require tenantId on all operations
});

// Static single tenant
const plugin = singleTenantPlugin('tenant-abc');
```

### Multi-Tenant Container Setup

```typescript
import { createContainer } from '@classytic/streamline';

const container = createContainer({
  repository: {
    multiTenant: {
      tenantField: 'context.tenantId',
      strict: true,
    },
  },
});

const workflow = createWorkflow('tenant-task', {
  steps: { /* ... */ },
  context: (input) => ({
    tenantId: input.tenantId, // Must include tenant ID
    // ...
  }),
  container,
});
```

### TenantFilterOptions

```typescript
interface TenantFilterOptions {
  tenantField?: string;      // Default: 'context.tenantId'
  staticTenantId?: string;   // For single-tenant mode
  strict?: boolean;          // Require tenantId if not static (default: false)
}
```

## OpenTelemetry Integration

Distributed tracing for workflow execution.

```typescript
import { enableTelemetry, disableTelemetry, isTelemetryEnabled } from '@classytic/streamline/telemetry';
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-app');

enableTelemetry({
  tracer,
  eventBus: globalEventBus, // Optional — uses global by default
});

// Now all workflow/step events create OpenTelemetry spans
// Spans include: workflowId, runId, stepId, status, duration, error details

// Disable when shutting down
disableTelemetry();
```

Requires peer dependency: `@opentelemetry/api >=1.0.0` (optional).

## Fastify Plugin

```typescript
import workflowPlugin from '@classytic/streamline/fastify';
import Fastify from 'fastify';

const app = Fastify();

await app.register(workflowPlugin, {
  // Plugin options
});
```

Import path: `@classytic/streamline/fastify`.

## Multi-Worker Deployment

Streamline supports multiple workers processing workflows concurrently:

- **Atomic state transitions** — MongoDB atomic operations prevent double-execution
- **Stale workflow detection** — Workers detect and recover workflows stuck by crashed workers (threshold: 5 min)
- **Heartbeat mechanism** — Long-running steps send heartbeats to prevent stale detection
- **Smart Scheduler** — Adaptive polling with circuit breaker, adjusts interval based on load

### SmartScheduler Behavior

- **Base poll interval:** 60s
- **Min poll interval:** 10s (under load)
- **Max poll interval:** 300s (idle)
- **Circuit breaker:** Opens after consecutive errors, auto-recovers
- Emits `scheduler:error` and `scheduler:circuit-open` events

### Heartbeat for Long-Running Steps

```typescript
const steps = {
  processLargeDataset: async (ctx) => {
    for (const batch of batches) {
      await processBatch(batch);
      await ctx.heartbeat(); // Prevents stale detection (every 30s)
    }
    return { processed: batches.length };
  },
};
```

## Cancellation & Rewind

### Cancellation with AbortSignal

```typescript
const steps = {
  longTask: async (ctx) => {
    for (const item of items) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      await processItem(item);
    }
    return { done: true };
  },
};

// Cancel from outside
await workflow.cancel(runId);
```

### Rewind to Re-Run Steps

```typescript
import { canRewindTo } from '@classytic/streamline';

// Check if rewind is possible
if (canRewindTo(run, 'processPayment')) {
  // Rewind — resets this step and all subsequent steps to 'pending'
  await workflow.rewindTo(runId, 'processPayment');
  // Then re-execute
  await workflow.execute(runId);
}
```

## Workflow Versioning

```typescript
const workflow = createWorkflow('payment-flow', {
  steps: { /* ... */ },
  version: '2.0.0', // Semver
});
```

Workflow definitions are stored in `WorkflowDefinitionModel`. Use `semver` for version comparison. Existing runs continue on their original version.

## Repository Direct Access

For advanced queries beyond the query builder:

```typescript
const repo = container.repository;

// Specialized queries
const active = await repo.getActiveRuns();
const waiting = await repo.getWaitingRuns();
const running = await repo.getRunningRuns();
const stale = await repo.getStaleRunningWorkflows(300_000); // 5 min threshold
const readyToResume = await repo.getReadyToResume(new Date());
const readyForRetry = await repo.getReadyForRetry(new Date());
const scheduled = await repo.getScheduledWorkflowsReadyToExecute(new Date(), {
  page: 1,
  limit: 100,
  tenantId: 'tenant-1',
});

// Access underlying mongokit repository
const base = repo.base;
```

## Cache Health Monitoring

```typescript
import { type CacheHealthStatus, COMPUTED } from '@classytic/streamline';

// Cache health thresholds
COMPUTED.CACHE_WARNING_THRESHOLD;   // Warning utilization %
COMPUTED.CACHE_CRITICAL_THRESHOLD;  // Critical utilization %

// CacheHealthStatus shape
type CacheHealthStatus = {
  size: number;
  maxSize: number;       // 10,000
  utilization: number;   // 0-1
  state: 'healthy' | 'warning' | 'critical';
};
```
