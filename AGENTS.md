# Agent Instructions

**CRITICAL RULES:**

- All changes require tests for new functionality

**Releases:** see [RELEASING.md](RELEASING.md) — canonical commit/push/publish for every `@classytic/*` package.

## Overview

`@classytic/streamline` is a MongoDB-native durable workflow orchestration engine for TypeScript. It provides Temporal/Inngest-like capabilities (sleep, wait, retry, parallel execution, human-in-the-loop, crash recovery, idempotency, concurrency control, event triggers) with simpler ergonomics and zero infrastructure beyond MongoDB.

## Architecture

### Core Components

- **src/core/types.ts**: Core type definitions (Step, StepState, WorkflowRun, StepContext)
- **src/core/events.ts**: Typed event bus with 19 lifecycle events and external event sink (see `EventPayloadMap`)
- **src/core/container.ts**: DI container (SignalStore, EventBus, Cache, Repository)
- **src/core/status.ts**: State machine validation and transitions
- **src/execution/engine.ts**: WorkflowEngine — lifecycle management, idempotency, cancelOn, concurrency
- **src/execution/executor.ts**: StepExecutor — atomic step execution, timeouts, retries, abort
- **src/execution/context.ts**: StepContextImpl — handler API (wait, sleep, scatter, checkpoint, log)
- **src/execution/smart-scheduler.ts**: Adaptive polling, circuit breaker, stale recovery, priority
- **src/storage/run.model.ts**: Mongoose schema with indexes (idempotencyKey, concurrencyKey, priority)
- **src/storage/run.repository.ts**: `WorkflowRunRepository extends Repository<WorkflowRun>` — tenant-scoped atomic `updateOne` (with `normalizeUpdate` guardrail), bounded existence probes (`countRunning`, `hasWaitingWorkflows`, `hasConcurrencyDrafts`), and scheduler-claim queries
- **src/storage/update-builders.ts**: Mongo update-doc builders used across the engine (`MongoUpdate`, `normalizeUpdate`, `runSet`, `runSetUnset`, `buildStepUpdateOps`, `applyStepUpdates`, `toPlainRun`). Raw operators by design — streamline is Mongo-only, so the repo-core Update IR's portability value is zero here.
- **src/events/**: Arc-compatible event layer. `DomainEvent` / `EventTransport` / `EventHandler` re-exported from `@classytic/primitives/events`; `EventContext` extends primitives' `OperationContext`; `InProcessStreamlineBus` wraps primitives' `matchEventPattern`; bridge from the legacy `WorkflowEventBus` onto any arc transport
- **src/workflow/define.ts**: `createWorkflow()` — main public API (trigger, cancelOn, concurrency)
- **src/features/hooks.ts**: Durable webhooks/resumeHook with DB fallback
- **src/features/parallel.ts**: In-memory parallel execution (all/race/any/allSettled)
- **src/scheduling/**: Timezone-aware scheduling with DST handling via luxon
- **src/utils/errors.ts**: Error hierarchy + NonRetriableError + toError utility
- **src/utils/helpers.ts**: calculateRetryDelay, resolveBackoffMultiplier
- **src/utils/logger.ts**: Centralized logger (configureStreamlineLogger)
- **src/integrations/fastify.ts**: Fastify integration (separate entry point)
- **src/telemetry/**: Optional OpenTelemetry integration (separate entry point)

## Development Commands

```bash
# Build
npm run build

# Type-check
npm run typecheck

# Lint with Biome
npm run lint

# Format with Biome
npm run format
```

### Testing Commands

Tests live in three tiers (unit / integration / e2e) configured via
`projects: [...]` in [vitest.config.ts](./vitest.config.ts). `npm test`
runs unit + integration only — **never** e2e by default.

**During development:**

```bash
npm run test:unit          # Pure functions, no DB (~5s)
npm run test:integration   # mongodb-memory-server, mocks (~20s)
npm run test:e2e           # Full scenarios, slow (~2-3 min)
npm run test:watch         # Watch mode, unit + integration
```

**Before publishing:**

```bash
npm test                   # unit + integration (fast CI path)
npm run test:all           # every tier
npm run test:coverage      # unit + integration with coverage
npm run prepublishOnly     # lint + typecheck + test:all + build
```

**Targeted testing:**

```bash
npx vitest run --project unit test/unit/helpers.test.ts   # Single file
npx vitest run --project e2e -t "idempotency"              # By test name
npx vitest run --project e2e test/e2e/distributed-*        # By glob
npx vitest --project unit --project integration            # Watch
```

## Test Organization

```
test/
├── unit/                    ← Pure functions, NO DB (fastest, run first)
│   ├── helpers.test.ts      calculateRetryDelay, resolveBackoffMultiplier
│   ├── validation.test.ts   validateId, validateRetryConfig
│   ├── errors.test.ts       toError, NonRetriableError, error classes
│   ├── logger.test.ts       levels, enable/disable, custom transport
│   ├── status.test.ts       deriveRunStatus, state transitions, type guards
│   ├── cache.test.ts        LRU eviction, MRU promotion, health
│   ├── event-transport.test.ts  arc-shape bus, glob matcher, createEvent
│   └── package-exports.test.ts  public API surface
├── integration/             ← mongodb-memory-server, real-world pipelines
│   └── smoke.test.ts        Order processing, content approval, cancel+abort
├── security/                ← Injection, validation, tenant isolation
├── plugins/                 ← Multi-tenant plugin tests
├── scheduling/              ← Timezone-aware scheduling
├── telemetry/               ← OpenTelemetry integration
├── e2e/                     ← Feature-level, end-to-end (slow tier)
│   ├── distributed-primitives.e2e.test.ts  idempotency, cancelOn, concurrency, trigger, priority
│   ├── v2.1-enhancements.e2e.test.ts       stepLogs, retry config, checkpoint, metrics, events
│   ├── agentic-workflows.e2e.test.ts       AI pipeline, tool orchestration, approval flows
│   ├── durability-recovery.e2e.test.ts     checkpoint, heartbeat, atomic ops, data integrity
│   ├── concurrency-races.e2e.test.ts       double-resume, isolation, parallel safety
│   ├── boundary-edge-cases.e2e.test.ts     large payloads, error edges, timeouts, conditions
│   ├── observability-events.e2e.test.ts    event sink, logs, metrics, progress
│   ├── workflow-lifecycle.e2e.test.ts      cancel, rewind, hooks, pause, heartbeat
│   ├── advanced-features.e2e.test.ts       goto, child workflows
│   ├── durable-features.e2e.test.ts        checkpoint recovery, DB fallback resume
│   ├── durable-signals.e2e.test.ts         signal store, cross-process resume
│   ├── fault-tolerance.e2e.test.ts         concurrent resume, type exports
│   ├── scatter-child.e2e.test.ts           scatter/gather, child orchestration
│   ├── smart-scheduler.e2e.test.ts         resume timing, multi-instance
│   ├── version-saga.e2e.test.ts            version mismatch detection
│   └── legacy/                             relocated from test/ root (hello-world, engine, parallel, etc.)
├── regression/              ← Bug-specific regression tests (e2e tier)
├── pagination/              ← Repository/scheduler pagination (e2e tier)
├── core/                    ← Engine / scheduler core behaviour (e2e tier)
├── review/                  ← Architecture review tests (e2e tier)
├── helpers/                 ← Shared test helpers (fixtures, lifecycle, assertions, mocks)
│   ├── index.ts             barrel — always import from here
│   ├── fixtures.ts          makeWorkflowRun, makeStepState, uniqueWorkflowId
│   ├── lifecycle.ts         useTestDb() — one-line hook setup
│   ├── assertions.ts        expectDone, expectStepSequence, expectRunStatus
│   └── mocks.ts             mockResolved, mockFlaky, mockLoggerTransport
└── utils/                   ← Low-level DB setup primitives
    └── setup.ts             setupTestDB, cleanupTestDB, teardownTestDB (idempotent)
```

### Test Conventions

- **DB tests**: prefer `useTestDb()` from `test/helpers/lifecycle.ts`.
  Raw `setupTestDB`/`cleanupTestDB`/`teardownTestDB` primitives live in
  `test/utils/setup.ts` for advanced lifecycle.
- **One mongodb-memory-server per worker** (`singleFork: true` on
  integration + e2e projects). The global `afterAll` in
  `test/vitest-setup.ts` handles teardown — do **not** add per-file
  `afterAll(teardownTestDB)`.
- **Per-tier timeouts**: unit 10 s, integration 30 s, e2e 120 s. If a
  test needs longer, it's in the wrong tier.
- **`autoExecute: false`**: use in tests for deterministic execution (call
  `execute()` explicitly).
- **Suppress logs**: global `configureLogger(false)` is set in
  `test/vitest-setup.ts`; no need per-file.
- **Unique ids**: use `uniqueWorkflowId(prefix)` from helpers — hardcoded
  ids collide under parallel execution.

## Code Style

- Uses Biome for formatting and linting (see `biome.json`)
- 2-space indentation, single quotes, trailing commas (all), semicolons always
- Import type enforcement (`useImportType: error`)
- `noExplicitAny: off` (framework compat), `noNonNullAssertion: warn`
- Line width: 100 characters

## Dependencies

- **Peer**: `@classytic/mongokit >=3.11.0`, `@classytic/primitives >=0.1.0`, `mongoose >=9.4.1`
- **Optional peer**: `@opentelemetry/api >=1.0.0`
- **Runtime**: `luxon ^3.0.0` (timezone), `semver ^7.0.0` (versioning)
- **Build**: tsdown (ESM, no bundling of deps via `neverBundle`)

### Why `@classytic/primitives`?

Shared source of truth for cross-package shapes that have to stay
bit-for-bit identical across arc, mongokit, streamline, and domain
packages:

- `DomainEvent`, `EventTransport`, `EventHandler`, `EventMeta` — lets any
  arc transport plug into `createContainer({ eventTransport })` with zero
  adapter code.
- `matchEventPattern` — the single glob matcher every package uses for
  `subscribe('namespace:*', ...)`.
- `OperationContext` — the ambient request-context shape
  (`actorId` / `organizationId` / `correlationId` / `session`) that flows
  through domain verbs. `createEvent`'s input context extends it.

Ship-shape rule: **never re-declare these under a streamline-local alias**.
Import from primitives and re-export unchanged.

## Key Patterns

### Basic workflow

```typescript
const wf = createWorkflow("order", {
  steps: {
    validate: async (ctx) => {
      /* ... */
    },
    charge: {
      handler: async (ctx) => {
        /* ... */
      },
      retries: 5,
      retryDelay: 5000,
    },
  },
  context: (input) => ({ orderId: input.id }),
});
```

### Distributed primitives

```typescript
const wf = createWorkflow('payment', {
  steps: { ... },
  trigger: { event: 'payment.requested' },          // Auto-start on event
  cancelOn: [{ event: 'payment.cancelled' }],        // Auto-cancel on event
  concurrency: { limit: 10, key: (i) => i.userId },  // Per-user limit
});

await wf.start(input, {
  idempotencyKey: `payment:${input.orderId}`,  // Dedup
  priority: 10,                                 // Higher = first
});
```

### Non-retriable errors

```typescript
import { NonRetriableError } from "@classytic/streamline";

async (ctx) => {
  if (!valid(ctx.input)) throw new NonRetriableError("Bad input");
};
```

### Logger control

```typescript
import { configureStreamlineLogger } from "@classytic/streamline";
configureStreamlineLogger({ enabled: false }); // Silence
configureStreamlineLogger({ level: "debug" }); // Verbose
configureStreamlineLogger({ transport: pinoAdapter }); // Custom
```
