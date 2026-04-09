# Agent Instructions

**CRITICAL RULES:**

- All changes require tests for new functionality

## Overview

`@classytic/streamline` is a MongoDB-native durable workflow orchestration engine for TypeScript. It provides Temporal/Inngest-like capabilities (sleep, wait, retry, parallel execution, human-in-the-loop, crash recovery, idempotency, concurrency control, event triggers) with simpler ergonomics and zero infrastructure beyond MongoDB.

## Architecture

### Core Components

- **src/core/types.ts**: Core type definitions (Step, StepState, WorkflowRun, StepContext)
- **src/core/events.ts**: Typed event bus with 19 lifecycle events and external event sink
- **src/core/container.ts**: DI container (SignalStore, EventBus, Cache, Repository)
- **src/core/status.ts**: State machine validation and transitions
- **src/execution/engine.ts**: WorkflowEngine — lifecycle management, idempotency, cancelOn, concurrency
- **src/execution/executor.ts**: StepExecutor — atomic step execution, timeouts, retries, abort
- **src/execution/context.ts**: StepContextImpl — handler API (wait, sleep, scatter, checkpoint, log)
- **src/execution/smart-scheduler.ts**: Adaptive polling, circuit breaker, stale recovery, priority
- **src/storage/run.model.ts**: Mongoose schema with indexes (idempotencyKey, concurrencyKey, priority)
- **src/storage/run.repository.ts**: MongoKit-based repository with multi-tenant support
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

**During development — run per-suite for speed:**

```bash
npm run test:unit          # Pure functions, no DB (~1s)
npm run test:security      # Input validation, injection, isolation (~3s)
npm run test:e2e           # Feature-level with MongoDB (~30s)
npm run test:integration   # Real-world smoke tests (~5s)
npm run test:regression    # Bug regression tests (~15s)
```

**Before publishing — run full suite:**

```bash
npm test                   # All tests
npm run test:coverage      # With coverage report
npm run prepublishOnly     # lint + typecheck + test + build
```

**Targeted testing during feature work:**

```bash
npx vitest run test/unit/helpers.test.ts          # Single file
npx vitest run test/e2e/ -t "idempotency"         # By test name
npx vitest run test/e2e/distributed-primitives*   # By glob
npx vitest --watch test/unit/                      # Watch mode per suite
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
│   └── cache.test.ts        LRU eviction, MRU promotion, health
├── security/                ← Injection, validation, tenant isolation
│   └── input-validation.test.ts
├── integration/             ← Real-world smoke tests with full pipeline
│   └── smoke.test.ts        Order processing, content approval, cancel+abort
├── e2e/                     ← Feature-level integration (MongoDB memory server)
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
│   └── version-saga.e2e.test.ts            version mismatch detection
├── regression/              ← Bug-specific regression tests
├── plugins/                 ← Multi-tenant plugin tests
├── pagination/              ← Repository/scheduler pagination
├── scheduling/              ← Timezone-aware scheduling
├── telemetry/               ← OpenTelemetry integration
├── core/                    ← Legacy core tests (engine, scheduler, edge cases)
└── *.test.ts                ← Legacy root tests (use localhost MongoDB, not memory server)
```

### Test Conventions

- **DB tests**: Use `setupTestDB()` / `cleanupTestDB()` / `teardownTestDB()` from `test/utils/setup.ts`
- **Sequential**: `fileParallelism: false` in vitest.config.ts (prevents MongoDB conflicts)
- **Timeouts**: 30s per test, 60s for hooks
- **autoExecute: false**: Use in tests for deterministic execution (call `execute()` explicitly)
- **Suppress logs**: Call `configureStreamlineLogger({ enabled: false })` in beforeAll

## Code Style

- Uses Biome for formatting and linting (see `biome.json`)
- 2-space indentation, single quotes, trailing commas (all), semicolons always
- Import type enforcement (`useImportType: error`)
- `noExplicitAny: off` (framework compat), `noNonNullAssertion: warn`
- Line width: 100 characters

## Dependencies

- **Peer**: `@classytic/mongokit >=3.5.6`, `mongoose >=9.4.1`
- **Optional peer**: `@opentelemetry/api >=1.0.0`
- **Runtime**: `luxon ^3.0.0` (timezone), `semver ^7.0.0` (versioning)
- **Build**: tsdown (ESM, no bundling of deps via `neverBundle`)

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
