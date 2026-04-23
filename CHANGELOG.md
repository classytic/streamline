# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-04-22 — PACKAGE_RULES alignment + `@classytic/primitives` integration + mongokit 3.11 / repo-core 0.2.0 compat + durability/observability hardening

### 🛠 Additional hardening landed in the v2.2 cycle

- **`ctx.waitFor(eventName)` now resumes from `globalEventBus`.** Previously
  the default container built an isolated event bus, so
  `globalEventBus.emit('user-action', { runId })` never reached the
  workflow — the documented API silently hung. `handleEventWait()` now
  subscribes on *three* channels: the container bus, `globalEventBus` (when
  distinct), and the `SignalStore` (cross-process). Cleanup is symmetric:
  `engine.shutdown()` and post-resume teardown both detach every channel.
  The previously-quarantined `test/e2e/legacy/event-wait.e2e.test.ts` is
  un-skipped and passes.
- **Bulk-op tenant isolation.** `multiTenantPlugin` promoted `updateMany` and
  `deleteMany` to class primitives in 3.11 — which meant streamline's
  `tenantFilterPlugin` (which only hooked `before:update` / `before:delete`)
  was silently bypassing tenant scope on bulk ops. The plugin now hooks
  `before:updateMany` and `before:deleteMany`; a new integration suite
  proves a tenant-scoped `updateMany({ status: 'running' }, ...)` touches
  only that tenant's runs and that strict mode rejects bulk ops without a
  tenant. (**Security-relevant.** Any consumer bumping past 2.2 should
  verify their tenant scope is not relying on the old plugin contract.)
- **`normalizeUpdate()` guardrail on `WorkflowRunRepository.updateOne()`.**
  Update docs that mix operators and raw fields
  (e.g. `{ $set: {...}, status: 'foo' }`) used to let Mongo silently drop
  the non-operator keys. `updateOne` now runs the input through
  `normalizeUpdate` and throws a loud error naming both the offending
  operators and field keys. Plain field-shape objects still auto-wrap in
  `$set`; well-formed operator docs pass through untouched.
- **New update-doc builders** at [`src/storage/update-builders.ts`](src/storage/update-builders.ts):
  `MongoUpdate`, `normalizeUpdate`, `runSet`, `runSetUnset`, plus the
  step-level helpers moved over from the old `step-updater.ts`
  (`buildStepUpdateOps`, `applyStepUpdates`, `toPlainRun`). `runSet()` auto-
  stamps `updatedAt`, eliminating a bug class where only some write paths
  set it. Engine and executor migrated to the builders at 8 call sites.
- **`hasConcurrencyDrafts()` bounded query.** Single-roundtrip `exists`
  probe — the scheduler's `hasActiveWorkflows()` now uses it instead of
  `countConcurrencyDrafts()` when the answer is just "is there any work?".
- **Heartbeat backpressure.** After
  `TIMING.HEARTBEAT_FAILURE_ABORT_THRESHOLD` (default 5) consecutive
  heartbeat-write failures, the executor now aborts the step's
  `AbortController` so the handler exits before the stale-detector flips
  the run to crashed and re-claims it on another worker. Escalation
  surfaces through `engine:error` context values
  `heartbeat-warning` → `heartbeat-critical` → `heartbeat-abort`.
- **No more swallowed draft-promotion errors.** `promoteConcurrencyDrafts`
  now emits `engine:error` with context `'promote-concurrency-draft-failure'`
  on each per-draft failure instead of `catch {}`. Operators can see stuck
  promotions; the scheduler still retries on its next poll.
- **Exhaustive `LEGACY_TO_CANONICAL` map.** Retyped as
  `Record<WorkflowEventName, StreamlineEventName>` — adding a new event to
  `EventPayloadMap` without mapping it in `event-constants.ts` is now a
  compile error, so the bridge physically cannot silently drop events. A
  runtime sanity test guards against accidental widening.
- **`skipStep` helper.** Extracted the conditional-skip "mark-skipped-and-
  advance" shape (`status: 'skipped'`, `completedAt/endedAt`, `durationMs: 0`,
  emit `step:skipped`) into a single method. Future pre-execution skip
  reasons (feature-flag, circuit-breaker) land here.
- **New tests** — 34 new assertions across:
  - [`test/unit/update-builders.test.ts`](test/unit/update-builders.test.ts)
    (19 cases, normalize guardrail + builders + `applyStepUpdates`)
  - [`test/unit/event-transport.test.ts`](test/unit/event-transport.test.ts)
    — added exhaustiveness sanity for `LEGACY_TO_CANONICAL`
  - [`test/integration/repository-primitives.test.ts`](test/integration/repository-primitives.test.ts)
    (12 cases, `updateMany` / `deleteMany` with and without tenant scope,
    `hasConcurrencyDrafts`, the mixed-update guardrail)
  - [`test/integration/heartbeat-backpressure.test.ts`](test/integration/heartbeat-backpressure.test.ts)
    (2 cases, abort threshold + transient-failure tolerance)

### ⚠️ Security note — bulk-op tenant scope

If any consumer was relying on pre-v2.2 streamline behavior where the
tenant filter plugin did NOT hook bulk ops, their call sites will now be
tenant-scoped. This is the correct behavior; the previous bypass was a
bug. Non-multi-tenant deployments are unaffected.



This release aligns streamline with the monorepo's PACKAGE_RULES and
testing-infrastructure standards, and adopts `@classytic/primitives` as the
shared source of truth for event shapes and operation context. **The public
workflow API (`createWorkflow`, `ctx.*`, events on `globalEventBus`) is
unchanged** — every workflow written against v2.1 continues to work. The
breaking changes are confined to the low-level `WorkflowRunRepository`
surface (most consumers never touch this directly).

### ✨ Added

- **`@classytic/primitives` integration.** `DomainEvent`, `EventTransport`,
  `EventHandler`, and `EventMeta` are re-exported from
  `@classytic/primitives/events` — the same shapes arc and every other
  Classytic package consume. `EventContext` now extends primitives'
  `OperationContext`, and `createEvent` wraps primitives' canonical
  `createEvent` helper. Glob-pattern matching is delegated to primitives'
  `matchEventPattern` (exact / `*` / `prefix.*` / `prefix:*`) so streamline,
  arc, and any other package stay in lock-step on pattern semantics.
  A host using arc can now pass any arc transport (Memory / Redis / Kafka /
  BullMQ) straight into streamline with **zero adapter code**:
  ```ts
  import { RedisEventTransport } from '@classytic/arc/events';
  const container = createContainer({
    eventTransport: new RedisEventTransport({ url }),
  });
  container.eventTransport.subscribe('streamline:workflow.*', handler);
  ```
  Every internal `WorkflowEventBus` emission is bridged onto the transport
  under its canonical `streamline:<resource>.<verb>` name. The default
  fallback is a ~50-line `InProcessStreamlineBus` that reuses primitives'
  matcher. See §11–§14 of PACKAGE_RULES.
- **New public exports** (all additive): `DomainEvent`, `EventTransport`,
  `EventHandler` (re-exported from primitives), `InProcessStreamlineBus`,
  `STREAMLINE_EVENTS`, `StreamlineEventName`, `createEvent`, `EventContext`,
  `LEGACY_TO_CANONICAL`, `bridgeBusToTransport`.
- **Repository count probes.** `countRunning()` and `hasWaitingWorkflows()`
  — single-roundtrip existence checks. Previously the scheduler fetched up
  to 1000 docs just to read `.length`; these are bounded.
- **Tiered test layout** (`test/unit/`, `test/integration/`, `test/e2e/`
  with per-tier timeouts 10s / 30s / 120s). `pnpm test` now runs
  unit + integration only; `pnpm test:e2e` is explicit and slower. Aligns
  with docs/testing-infrastructure.md §2.
- **Canonical `test/helpers/`** — `fixtures.ts`, `lifecycle.ts`
  (`useTestDb()`), `assertions.ts`, `mocks.ts`. Barrel import at
  `test/helpers/index.ts`.
- **Inherited mongokit 3.11.0 / repo-core 0.2.0 surface** — no streamline
  code change required, but consumers pick these up the moment they bump:
  - `WorkflowRunRepository.updateMany(filter, update, opts?)` and
    `.deleteMany(filter, opts?)` are inherited from `Repository<TDoc>` as
    class primitives — `batchOperationsPlugin` no longer needed for those
    two methods (still needed for `bulkWrite`).
  - `findOneAndUpdate` and `updateMany` accept the portable
    `@classytic/repo-core/update` IR (`update({ set, unset, inc,
    setOnInsert })`, `setFields`, `incFields`, `unsetFields`,
    `setOnInsertFields`, `combineUpdates`). Existing raw `$set`/`$inc`
    records continue to flow through unchanged.
  - `UpdatePatch<TDoc>` is the canonical name for the single-doc patch
    shape mongokit's `repo.update(id, data)` accepts. The legacy
    `UpdateInput<TDoc>` import from mongokit still works as a deprecated
    alias (removed in mongokit 3.12).
  - `multiTenantPlugin`'s `allowDataInjection: true` default now honors
    payload-stamped tenants. **Streamline still ships its own
    `tenantFilterPlugin`** because of three streamline-specific
    requirements (nested-field injection on `context.tenantId`,
    `bypassTenant` flag for cross-tenant scheduler sweeps, `staticTenantId`
    for single-tenant deployments) — see the JSDoc on
    [`tenant-filter.plugin.ts`](src/plugins/tenant-filter.plugin.ts) for
    the full design rationale.

### ♻️ Changed

- **Repository now extends mongokit.** `WorkflowRunRepository` is a
  concrete class extending `Repository<WorkflowRun>` rather than a
  hand-rolled wrapper with an interface façade. Callers gain the full
  mongokit CRUD / pagination / aggregate / populate / hook / transaction
  surface for free (§1 of PACKAGE_RULES). `.getById()` keeps the prior
  `throwOnNotFound: false` default.
- **Peer deps:** `@classytic/mongokit` bumped to `>=3.11.0` (matches the
  current monorepo PACKAGE_RULES floor — gives us `updateMany`/`deleteMany`
  as `Repository<TDoc>` class primitives, the `UpdatePatch` rename, and
  `multiTenantPlugin`'s `allowDataInjection` default) and
  `@classytic/primitives >=0.1.0` added as a new required peer dep.
  `@classytic/repo-core` is a transitive dep of mongokit — streamline does
  not import from it directly, so it is intentionally NOT listed as a peer
  dep (per PACKAGE_RULES guidance).
- **`EventContext.actorId` replaces `userId`.** `createEvent` input context
  now extends `OperationContext` — the actor field is named `actorId`
  (primitives' canonical name) and is mapped onto `meta.userId` on the
  wire, so the emitted `DomainEvent` shape is unchanged. Legacy event-bus
  payloads that carry `userId` still flow through the bridge.
- Legacy loose test files (`test/*.test.ts` at root) moved under
  `test/e2e/legacy/`, `test/unit/`, or `test/regression/` depending on
  tier. Hardcoded `mongodb://localhost:27017` URIs replaced with
  mongodb-memory-server via `setupTestDB()`. `setupTestDB` is now
  idempotent so multiple test files share one server per worker.

### ⚠️ Breaking changes (low-level repository API only)

These changes affect only code that imports the repository directly from
`@classytic/streamline`. If your code uses `createWorkflow`, `ctx.*`, or
subscribes on `globalEventBus` / `engine.container.eventBus`, **nothing
breaks.**

1. **Pure proxy methods removed from `WorkflowRunRepository`.** These were
   one-line wrappers around `Repository.getAll({ filters })`:
   - `repo.getActiveRuns()` → `repo.getAll({ filters: CommonQueries.active() }, { lean: true })`
   - `repo.getRunningRuns()` → use `repo.countRunning()` for counts, or
     `repo.getAll({ filters: { status: 'running' } }, { lean: true })` for docs
   - `repo.getWaitingRuns()` → use `repo.hasWaitingWorkflows()` for
     existence, or `repo.getAll({ filters: { status: 'waiting', paused: { $ne: true } } }, { lean: true })` for docs
   - `repo.getRunsByWorkflow(workflowId)` → `repo.getAll({ filters: { workflowId } }, { lean: true })`

2. **`.base` and `._hooks` accessors removed.** They leaked the wrapped
   mongokit repo; since the repository now *extends* `Repository`, the
   methods are directly available — `repo.findOne(...)`, `repo.on('after:update', ...)` etc.

3. **`.update(id, data, { bypassTenant: true })` split.** The legacy custom
   `bypassTenant` option lived on an override that shadowed mongokit's
   `update`. It now lives on a dedicated method:
   ```ts
   // before
   await repo.update(runId, data, { bypassTenant: true });

   // after
   await repo.updateById(runId, data, { bypassTenant: true });
   ```
   Plain `repo.update(runId, data)` (no `bypassTenant`) keeps the mongokit
   signature unchanged — no migration needed.

4. **`WorkflowRunRepository` is now a class, not an interface.** Code that
   imported it `as a type` (the documented form) continues to work —
   TypeScript accepts a class in type position. Code that did
   `class MyRepo implements WorkflowRunRepository { ... }` needs to switch
   to `class MyRepo extends WorkflowRunRepository { ... }` (and will
   inherit the mongokit surface instead of re-implementing it).

5. **`EventContext.userId` field renamed to `actorId`.** Only affects
   callers of the (internal, previously un-exported) `createEvent` helper:
   ```ts
   // before
   createEvent('my:event', payload, { userId: 'u1', ... });

   // after
   createEvent('my:event', payload, { actorId: 'u1', ... });
   ```
   The emitted `DomainEvent.meta.userId` field is **unchanged** — the
   rename is on the *input context* only, to stay consistent with
   primitives' `OperationContext`.

No migration is required for consumers using `createWorkflow` + `ctx.*` +
event bus subscription. Consumers who already use `@classytic/primitives`
or `@classytic/arc` get structural compatibility automatically.

## [0.1.0] - 2025-01-13

### 🎉 Initial Release - MongoDB-Native Workflow Engine

#### Core Features
- ✅ **Durable workflow execution** - Sequential step execution with state persistence
- ✅ **Wait/Resume** - Human-in-the-loop workflows with `ctx.wait()`
- ✅ **Sleep/Timers** - Time-based pausing with `ctx.sleep(ms)`
- ✅ **Parallel execution** - `Promise.all`, `Promise.race`, `Promise.any` modes
- ✅ **Conditional steps** - Skip steps based on context predicates
- ✅ **Retry logic** - Exponential backoff with configurable max retries
- ✅ **Step timeouts** - Per-step timeout configuration
- ✅ **Error handling** - Graceful failure handling with retry

#### Storage & Persistence
- ✅ **MongoDB persistence** - Native MongoDB storage via Mongoose
- ✅ **MongoKit integration** - Repository pattern with plugins
- ✅ **Cache-first architecture** - In-memory cache for active workflows
- ✅ **Atomic state updates** - Transactional updates for consistency

#### Developer Experience
- ✅ **Fluent builder API** - `defineWorkflow().step().build()`
- ✅ **TypeScript-first** - Full type safety and IntelliSense
- ✅ **Step context** - Rich context API with `set()`, `getOutput()`, `wait()`, `sleep()`
- ✅ **Event system** - Event-driven architecture for monitoring

#### Advanced Features
- ✅ **Concurrency control** - CPU-aware throttling with queue management
- ✅ **Memory management** - Automatic garbage collection and cache eviction
- ✅ **Workflow rewind** - Rewind to any step and re-execute
- ✅ **Auto-execute** - Workflows execute automatically after `start()`
- ✅ **Fastify integration** - Optional Fastify plugin

#### Documentation
- ✅ **Comprehensive README** - Multi-tenant indexing, cleanup strategies, UI integration examples
- ✅ **Example workflows** - 7 complete examples (hello-world, wait, sleep, parallel, conditional, newsletter, AI pipeline)
- ✅ **Testing guide** - Full testing documentation with examples
- ✅ **Vercel comparison** - Architectural analysis vs Vercel Workflow
- ✅ **Temporal comparison** - Honest comparison with Temporal.io
- ✅ **Enterprise readiness** - Assessment for enterprise applications

