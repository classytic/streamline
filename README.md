# @classytic/streamline

> MongoDB-native durable workflow engine. Sleep / wait / retry / parallel / human-in-the-loop / event triggers / idempotency / concurrency / crash recovery — zero infrastructure beyond MongoDB.

```
draft → running → waiting ↔ running → done
                     ↓         ↓
                  failed   cancelled
```

## Install

```bash
npm install @classytic/streamline @classytic/mongokit @classytic/primitives mongoose
```

Peer deps: `@classytic/mongokit >=3.11`, `@classytic/primitives >=0.1`, `mongoose >=9.4.1`. Optional: `@opentelemetry/api >=1.0`.

## Quick start

```typescript
import mongoose from 'mongoose';
import { createWorkflow } from '@classytic/streamline';

await mongoose.connect('mongodb://localhost/myapp'); // reuse your existing connection

const scraper = createWorkflow('web-scraper', {
  steps: {
    fetch: async (ctx) => ({ html: await fetch(ctx.context.url).then(r => r.text()) }),
    parse: async (ctx) => ({ data: parseHTML(ctx.getOutput('fetch').html) }),
    save:  async (ctx) => ({ saved: await db.save(ctx.getOutput('parse').data) }),
  },
  context: (input: { url: string }) => ({ url: input.url }),
  version: '1.0.0',
});

const run = await scraper.start({ url: 'https://example.com' });
// Auto-executes. Use `await scraper.waitFor(run._id)` to block until done.
```

## Step features

### Retries, timeouts, conditions

```typescript
createWorkflow('ci', {
  steps: {
    clone: async (ctx) => ({ repo: 'cloned' }),                 // plain handler
    build: {
      handler: async (ctx) => ({ artifact: 'build.tar.gz' }),
      timeout: 120_000,
      retries: 5,
      retryDelay: 1_000,
      retryBackoff: 'exponential',                               // or 'linear' | multiplier number
    },
    deploy: {
      handler: async (ctx) => ({ deployed: true }),
      skipIf: (ctx) => !ctx.shouldDeploy,                        // typed as your TContext
    },
  },
  context: (input: { deploy: boolean }) => ({ shouldDeploy: input.deploy }),
  defaults: { retries: 3, timeout: 30_000 },
});
```

### Human-in-the-loop

```typescript
steps: {
  wait: async (ctx) => { await ctx.wait('Please approve', { request: ctx.context.data }); },
  run:  async (ctx) => { const approval = ctx.getOutput('wait'); /* ... */ },
}
// later: await workflow.resume(runId, { approved: true, by: 'admin' });
```

### Sleep (durable timer)

```typescript
await ctx.sleep(3_600_000); // survives process restart; scheduler re-picks it up
```

### Wait for event

```typescript
const data = await ctx.waitFor('user-action');
// Resumes on: globalEventBus.emit('user-action', { runId, data }),
// container.eventBus.emit(...), or a cross-process signal store.
```

### Parallel / scatter

```typescript
import { executeParallel } from '@classytic/streamline';

await executeParallel([
  () => fetch('https://api1'),
  () => fetch('https://api2'),
], { mode: 'all' }); // 'all' | 'race' | 'any' | 'allSettled'

// Checkpointed scatter — resumes from where it crashed:
await ctx.scatter({ a: () => fetchA(), b: () => fetchB() }, { concurrency: 4 });
```

### Goto & rewind

```typescript
await ctx.goto('retry-step');                    // jump inside a step handler
await workflow.rewindTo(runId, 'some-earlier');  // external rewind
```

### Long-running steps

Heartbeats fire automatically every 30 s. Use `ctx.heartbeat()` inside tight loops to push a beat between batches. After `TIMING.HEARTBEAT_FAILURE_ABORT_THRESHOLD` (default 5) consecutive heartbeat-write failures, the executor aborts the step so the stale-detector can't cause a double execution.

### Non-retriable failures

```typescript
import { NonRetriableError } from '@classytic/streamline';
if (!valid(ctx.input)) throw new NonRetriableError('Bad input — no retry');
```

## Distributed primitives

### Idempotent start

```typescript
// Only one active run per key. Reusable after completion/failure.
await workflow.start(input, { idempotencyKey: `order:${id}` });
```

### Concurrency limit

```typescript
createWorkflow('charge', {
  steps: { /* ... */ },
  concurrency: { limit: 5, key: (input) => input.userId },
  // Excess queued as draft; auto-promoted when a slot frees (no scheduler wait).
});
```

### Event triggers & auto-cancel

```typescript
createWorkflow('onboard', {
  steps: { /* ... */ },
  trigger:  { event: 'user.created' },         // auto-start
  cancelOn: [{ event: 'user.cancelled' }],     // auto-cancel
});
```

### Priority

```typescript
await workflow.start(input, { priority: 10 }); // higher = picked up first
```

### Child workflows

```typescript
await ctx.startChildWorkflow('billing', { orderId });
// Parent waits for child. Child's output becomes the step's output.
```

## Multi-tenant

```typescript
import { createContainer, createWorkflow } from '@classytic/streamline';

const container = createContainer({
  repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
});

const wf = createWorkflow('my-flow', { steps: { /* ... */ }, container });
// Every read/write/updateMany/deleteMany is tenant-scoped automatically.
// `bypassTenant: true` for admin ops; `staticTenantId` for single-tenant deployments.
```

Works with the full MongoKit plugin surface (cache, audit, observability, field-filter, etc.). Tenant scope applies to `updateMany` / `deleteMany` too — 3.11 class primitives, hooked since streamline v2.2.

## Indexing

```typescript
import { WorkflowRunModel } from '@classytic/streamline';

await WorkflowRunModel.collection.createIndexes([
  { key: { 'context.tenantId': 1, status: 1 } },
  { key: { 'context.url': 1, workflowId: 1 } },
  // TTL: auto-delete finished runs after 30 days
  { key: { updatedAt: 1 }, expireAfterSeconds: 30 * 86400,
    partialFilterExpression: { status: { $in: ['done', 'failed', 'cancelled'] } } },
]);
```

## Query & cleanup

```typescript
// Query directly via the Mongoose model:
await WorkflowRunModel.find({ workflowId: 'web-scraper', status: 'running' })
  .sort({ createdAt: -1 }).limit(50).lean();

// Or via the repository (v2.2 class primitives, tenant-scoped):
import { workflowRunRepository as repo } from '@classytic/streamline';
await repo.deleteMany({ status: { $in: ['done', 'failed'] },
                       updatedAt: { $lt: cutoff } });
await repo.updateMany({ status: 'waiting' }, { $set: { status: 'cancelled' } });
```

## Webhooks

```typescript
import { createHook, resumeHook } from '@classytic/streamline';

// In a step:
const hook = createHook(ctx, 'awaiting-approval');
console.log(hook.path); // /hooks/<token>
await ctx.wait('Awaiting approval');

// In your HTTP handler:
app.post('/hooks/:token', async (req, res) => {
  const { runId, run } = await resumeHook(req.params.token, req.body);
  res.json({ runId, status: run.status });
});
```

## Observability

### Legacy event bus (in-process)

```typescript
import { globalEventBus } from '@classytic/streamline';

globalEventBus.on('workflow:started',   ({ runId }) => metrics.inc('wf.start', { runId }));
globalEventBus.on('workflow:completed', ({ runId }) => metrics.inc('wf.done', { runId }));
globalEventBus.on('workflow:failed',    ({ runId, data }) => alert({ runId, error: data.error }));
globalEventBus.on('engine:error',       ({ runId, error, context }) => log.error({ runId, context, error }));
```

Events: `workflow:started|completed|failed|waiting|resumed|cancelled|recovered|retry|compensating`, `step:started|completed|failed|waiting|skipped|retry-scheduled|compensated`, `engine:error`, `scheduler:error|circuit-open`.

### Arc-compatible transport (cross-process)

```typescript
import { createContainer, createWorkflow } from '@classytic/streamline';
import { RedisEventTransport } from '@classytic/arc/events';

const container = createContainer({
  eventTransport: new RedisEventTransport({ url: process.env.REDIS_URL }),
});

await container.eventTransport.subscribe('streamline:workflow.*', async (event) => {
  // { type: 'streamline:workflow.completed', payload: { runId }, meta: { id, timestamp, resourceId, userId, ... } }
  await auditLog.write(event);
});

const wf = createWorkflow('order', { steps: { /* ... */ }, container });
```

Canonical names: `streamline:<resource>.<verb>`. Without `eventTransport`, streamline uses an in-process `InProcessStreamlineBus` (same `matchEventPattern` as arc). The legacy `globalEventBus` keeps working unchanged — the transport is an additive bridge.

### OpenTelemetry

Import from `@classytic/streamline/telemetry`; see package exports.

### Logger

```typescript
import { configureStreamlineLogger } from '@classytic/streamline';
configureStreamlineLogger({ enabled: false });          // silence
configureStreamlineLogger({ level: 'debug' });          // verbose
configureStreamlineLogger({ transport: pinoAdapter });  // pino/winston/etc.
```

## Scheduler

Adaptive polling (10 s–5 min by load), circuit breaker, stale-running recovery, priority-ordered pickup, timezone-aware scheduling with DST handling (luxon).

```typescript
workflow.engine.configure({ scheduler: { maxConcurrentExecutions: 10 } });
// Cap concurrent runs. All slots full → scheduler skips the poll cycle.
```

## API summary

**Workflow** (from `createWorkflow`):
`start(input, opts?)` · `execute(runId)` · `resume(runId, payload?)` · `get(runId)` · `cancel(runId)` · `pause(runId)` · `rewindTo(runId, stepId)` · `waitFor(runId, opts?)` · `shutdown()`

**StepContext** (inside handlers):
`ctx.set` · `ctx.getOutput` · `ctx.wait` · `ctx.waitFor` · `ctx.sleep` · `ctx.heartbeat` · `ctx.emit` · `ctx.log` · `ctx.checkpoint` · `ctx.getCheckpoint` · `ctx.scatter` · `ctx.goto` · `ctx.startChildWorkflow` · `ctx.signal` (AbortSignal)

**Public exports** (main entry):
`createWorkflow`, `WorkflowEngine`, `createContainer`, `createWorkflowRepository`, `WorkflowRunModel`, `WorkflowRunRepository`, `CommonQueries`, `executeParallel`, `createHook` / `resumeHook`, `globalEventBus`, `WorkflowEventBus`, `createEventSink`, `tenantFilterPlugin` / `singleTenantPlugin`, `SchedulingService`, `TimezoneHandler`. Update-doc builders: `MongoUpdate`, `normalizeUpdate`, `runSet`, `runSetUnset`, `buildStepUpdateOps`. Arc-compatible events: `InProcessStreamlineBus`, `createEvent`, `bridgeBusToTransport`, `STREAMLINE_EVENTS`, `LEGACY_TO_CANONICAL`, `DomainEvent`, `EventTransport`, `EventHandler`. Errors: `WorkflowError`, `WorkflowNotFoundError`, `StepNotFoundError`, `StepTimeoutError`, `InvalidStateError`, `DataCorruptionError`, `MaxRetriesExceededError`, `NonRetriableError`, `ErrorCode`.

**Subpath entries**: `@classytic/streamline/fastify`, `@classytic/streamline/telemetry`.

## Error handling

```typescript
import { ErrorCode } from '@classytic/streamline';

try { await workflow.resume(runId, payload); }
catch (err) {
  switch (err.code) {
    case ErrorCode.WORKFLOW_NOT_FOUND: return res.status(404).end();
    case ErrorCode.INVALID_STATE:      return res.status(400).end();
    case ErrorCode.STEP_TIMEOUT:       return res.status(408).end();
    default: throw err;
  }
}
```

Codes: `WORKFLOW_NOT_FOUND`, `WORKFLOW_CANCELLED`, `STEP_NOT_FOUND`, `STEP_TIMEOUT`, `INVALID_STATE`, `DATA_CORRUPTION`, `MAX_RETRIES_EXCEEDED`.

## Type-safe exports

```typescript
import type {
  Workflow, WorkflowConfig, StepConfig, WaitForOptions,
  WorkflowRun, WorkflowEventName, EventPayloadMap,
} from '@classytic/streamline';

export const myWorkflow: Workflow<MyCtx, MyInput> = createWorkflow('my', { /* ... */ });
```

## Examples

See [docs/examples/](./docs/examples): hello-world, wait, sleep, parallel, conditional, newsletter automation, AI pipeline.

## Testing your workflows

```bash
npm test                # unit + integration (fast)
npm run test:e2e        # full scenarios (slow)
npm run test:all        # everything
```

See [TESTING.md](./TESTING.md) for tier conventions + helpers.

## What's new in 2.2

- **Arc-compatible event transport** — drop any arc transport (Memory / Redis / Kafka / BullMQ) into `createContainer({ eventTransport })` and subscribe glob-style.
- **mongokit 3.11 / repo-core 0.2 surface** — `updateMany` / `deleteMany` as class primitives, portable Update IR, `UpdatePatch<TDoc>` rename.
- **`ctx.waitFor()` resumes from `globalEventBus`** (was broken in 2.1).
- **Tenant scope on bulk ops** — `tenantFilterPlugin` now hooks `updateMany` / `deleteMany`. Security-relevant if you were on 2.1 with bulk writes.
- **Heartbeat backpressure** — aborts a step after N consecutive heartbeat failures to prevent double execution via stale re-claim.
- **`updateOne()` guardrail** — rejects mixed `{ $set, rawField }` updates instead of letting Mongo silently drop keys.
- Exhaustive `LEGACY_TO_CANONICAL` map — adding a new event without mapping it is a compile error.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## License

MIT · Issues + PRs welcome at [github.com/classytic/streamline](https://github.com/classytic/streamline)
