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

Peer deps: `@classytic/mongokit >=3.13`, `@classytic/primitives >=0.1`, `mongoose >=9.4.1`. Optional: `@opentelemetry/api >=1.0`. (3.13 ships `Repository.claim()` + `MongoOperatorUpdate` — both load-bearing in streamline ≥2.3.)

## Design philosophy — what streamline is *not*

Streamline is a **state-machine durable workflow engine**, not a deterministic-replay one. Each step's input/output is checkpointed to MongoDB; on crash or restart the scheduler resumes from the last completed step. The orchestrator code is **not** re-executed from an event log to reconstruct state (the model used by Inngest, Temporal, and Vercel Workflow SDK).

What you get from this choice:

- **No compiler magic.** Plain `async` functions. No SWC plugins, no sandboxed VM, no `"use workflow"` pragmas, no two-bundle splits.
- **No determinism constraints.** `Date.now()`, `Math.random()`, `crypto.randomUUID()`, closures over mutable state — all fine inside step handlers. Replay engines forbid these or require `step.run` wrappers around them.
- **Smaller mental model.** A run is a Mongo document; steps are entries in `run.steps[]`. You can read it, query it, index it, dump it.
- **Zero new infrastructure.** Reuses your existing Mongo connection. No Redis, no Postgres, no separate server process.

What you give up:

- **No free time-travel debugging from an event log** (the run document is the audit trail; `stepLogs` is the per-step log).
- **Long-running orchestrators with branchy logic** are less memory-efficient than a replay engine — streamline keeps step outputs in the run doc rather than re-deriving them.
- **Cross-step transactional rollback** isn't free — you write compensation steps yourself.

If your workload is "background jobs and multi-step workflows on a Mongo-backed app," this is the right trade. If you need deterministic replay across language boundaries or month-long orchestrators, reach for Temporal/Inngest.

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

### Throttle (best-effort start-rate smoothing — *not* a strict rate limiter)

```typescript
createWorkflow('send-receipt', {
  steps: { /* ... */ },
  concurrency: {
    key: (input) => input.userId,
    throttle: { limit: 10, windowMs: 60_000 }, // smooth starts toward 10/user/min
  },
});
// First `limit` starts in any rolling window fire immediately. Excess starts
// queue as scheduled drafts and are spread by `windowMs / limit` (1 every 6 s
// in this example) so a burst of 100 doesn't all land on a single future slot.
// The scheduler picks them up — no dropped calls.
```

**Honest contract.** This is best-effort smoothing, not a distributed strict rate limiter:

- **Sequential safety:** ✅ Within one process, sequential `start()` calls produce strictly-staggered queued slots — `tail.executionTime + windowMs / limit`. Bursts smooth correctly.
- **Parallel races:** ⚠️ Two concurrent `start()` calls can read the same tail before either persists, so they reserve the same future slot. Burst correctness is bounded by parallelism, not by `limit`.
- **What you get:** "starts will be smoothed *toward* `limit / windowMs` under typical load."
- **What you don't get:** "at most `limit` starts will *ever* fire in any `windowMs` window."

If you need a strict distributed rate limit (payment captures, partner API quotas), wrap `start()` in your own atomic counter / Redis token-bucket / semaphore — streamline's throttle is for "don't overload the embedding API," not "exactly N or fail."

### Debounce (collapse rapid bursts)

```typescript
createWorkflow('rebuild-search-index', {
  steps: { /* ... */ },
  concurrency: {
    key: (input) => input.tenantId,
    debounce: { windowMs: 30_000 }, // fire once 30s after the last start call
  },
});
// Trailing-edge: each start atomically pushes the timer forward and overwrites
// `input` / `context` with the latest values. Lodash semantics. The single run
// that eventually fires sees the most recent input. Use a global key
// (`key: () => 'global'`) for workflow-wide debounce.
```

`throttle` and `debounce` are mutually exclusive — debounce already collapses bursts to one fire per quiet window. Both require `key`. `key: () => 'global'` gives you a workflow-wide bucket.

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

## Race semantics — what's closed, what isn't

Distributed primitives have specific guarantees. Honest summary:

| Primitive | Guarantee | Mechanism |
|---|---|---|
| `idempotencyKey` | **Race-safe.** Concurrent starts with the same key produce exactly one active run. | Partial unique index on `idempotencyKey` (filtered to non-terminal statuses) + E11000 catch in `repository.create()`. The losing insert returns the winning run instead of throwing. |
| Scheduler claim (waiting → running, draft → running) | **Race-safe.** A given run is claimed by exactly one worker. | Atomic `findOneAndUpdate` with status guard in the filter. Plugin hooks fire on the claim. |
| `concurrency.limit` | **Best-effort, advisory.** Steady-state correct; under bursts of concurrent starts/promotions the limit can briefly oversubscribe. | Count-then-create (and count-then-promote on slot release). Not wrapped in a transaction or counter doc. |
| `concurrency.throttle` | **Best-effort smoothing, not a strict distributed rate limiter.** Sequential bursts get strictly-staggered slots (`tail + windowMs/limit`). Parallel concurrent starts can reserve the same slot — bounded by parallelism, not by `limit`. Use an external token-bucket / counter for strict guarantees. |
| `concurrency.debounce` | **Race-safe for the bump path.** Each start is a single atomic `findOneAndUpdate` against `(workflowId, concurrencyKey)`; the timer push is serialized by Mongo. The fall-through "no draft existed yet → create one" can race two creates if the first start in a quiet window arrives twice within the same millisecond — bounded to two drafts max, both at the same `executionTime`. |

If your workload is concurrency-sensitive in the strict sense — payment captures, ticket reservations, license-seat allocation — wrap the start call in your own gate (Redis lock, partial-unique resource index per [PACKAGE_RULES §32](https://github.com/classytic/specs)) instead of relying on `concurrency.limit`. The streamline gate is fine for "don't overload the embedding API" but not for "exactly N seats."

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

Works with the MongoKit plugin surface (cache, audit, observability, field-filter, etc.). Every read and write — including atomic claims like the scheduler's `findOneAndUpdate` race — routes through inherited `Repository<TDoc>` methods, so plugin hooks fire on engine writes, not just user writes. Tenant scope applies to `updateMany` / `deleteMany` and to the atomic-claim path; `bypassTenant: true` is the explicit opt-out for `_id`-scoped admin operations.

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

// In a step — MUST pass `hookToken` to ctx.wait so resumeHook can validate it.
// Without it, resumeHook fails closed (no token in the run = no resume).
const hook = createHook(ctx, 'awaiting-approval');
console.log(hook.path); // /hooks/<token>
await ctx.wait('Awaiting approval', { hookToken: hook.token });

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

`WorkflowError` (and every subclass) implements [`HttpError`](https://github.com/classytic/repo-core) from `@classytic/repo-core/errors`. Three equivalent ways to identify an error — pick whichever matches your codebase:

```typescript
import { WorkflowError, ErrorCode, ErrorCodeHierarchical } from '@classytic/streamline';

try { await workflow.resume(runId, payload); }
catch (err) {
  if (!(err instanceof WorkflowError)) throw err;

  // (A) Cleanest in HTTP layers — the status is right on the error.
  return res.status(err.status).json({ code: err.code, message: err.message, meta: err.meta });

  // (B) Hierarchical (HttpError-canonical) code — switch on `'workflow.X'` ids.
  switch (err.code) {
    case ErrorCodeHierarchical.WORKFLOW_NOT_FOUND: return res.status(404).end();
    case ErrorCodeHierarchical.INVALID_STATE:      return res.status(400).end();
    case ErrorCodeHierarchical.STEP_TIMEOUT:       return res.status(408).end();
    default: throw err;
  }

  // (C) Legacy SCREAMING_SNAKE — kept for backwards compat. New code should
  // prefer (A) or (B). The legacy value lives on `legacyCode` post-migration.
  switch (err.legacyCode) {
    case ErrorCode.WORKFLOW_NOT_FOUND: return res.status(404).end();
    // ...
  }
}
```

Status mapping (also exported as `ERROR_STATUS_MAP`):

| Code | Status | Hierarchical id |
|---|---|---|
| `WORKFLOW_NOT_FOUND` | 404 | `workflow.not_found` |
| `STEP_NOT_FOUND` | 404 | `workflow.step.not_found` |
| `STEP_TIMEOUT` | 408 | `workflow.step.timeout` |
| `WORKFLOW_CANCELLED` / `WORKFLOW_ALREADY_COMPLETED` / `EXECUTION_ABORTED` | 409 | `workflow.cancelled` / `…` |
| `INVALID_STATE` / `INVALID_TRANSITION` / `VALIDATION_ERROR` | 400 | `workflow.invalid_state` / `…` |
| `DATA_CORRUPTION` / `STEP_FAILED` / `MAX_RETRIES_EXCEEDED` | 500 | `workflow.data_corruption` / `…` |

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
