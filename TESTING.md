# Streamline Testing Guide

Testing conventions for `@classytic/streamline`. Aligned with the monorepo
[testing-infrastructure.md](../testing-infrastructure.md).

## Tiers

Every test lives in **exactly one** tier. Pick based on what the test
needs, not where the source file lives.

| Tier | Directory | May use | Timeout | Runs |
|---|---|---|---|---|
| **unit** | `test/unit/`, plus `test/core/`\* | pure functions, mocks, in-memory stores | **10 s** | every commit, watch |
| **integration** | `test/integration/`, `test/plugins/`, `test/scheduling/`, `test/security/`, `test/telemetry/` | `mongodb-memory-server`, scripted MongoKit repos | **30 s** | every commit, pre-push |
| **e2e** | `test/e2e/`, `test/regression/`, `test/pagination/`, `test/review/` | full workflow scenarios, real timing, scheduler polls | **120 s** | nightly, on-demand |

\* `test/core/` intentionally lives in the e2e tier today — it exercises
the engine end-to-end.

**Invariant:** unit + integration must run with **no network, no API keys,
no live MongoDB**. If a test needs any of those, it belongs in e2e.

## Scripts

```bash
pnpm test               # unit + integration (fast CI path, ~20 s)
pnpm test:unit          # unit only, ~5 s
pnpm test:integration   # integration only, ~20 s
pnpm test:e2e           # e2e only, ~2-3 min (mongodb-memory-server)
pnpm test:all           # everything
pnpm test:watch         # unit + integration in watch mode
pnpm test:coverage      # unit + integration with coverage report
```

**Rules:**
- `pnpm test` (no args) never runs e2e. Keep it under 30 s on a dev laptop
  — if it crosses that, the next thing developers do is stop running tests
  locally.
- CI runs `pnpm test` on PRs. `pnpm test:e2e` runs nightly.
- `pnpm prepublishOnly` runs `test:all` (unit + integration + e2e + build)
  so releases see the full suite.

## Config

One [vitest.config.ts](./vitest.config.ts) with `projects: [unit, integration, e2e]`.
Tier-specific timeouts live on each project; global options (coverage,
`setupFiles`) are inherited via `extends: true`.

```typescript
// vitest.config.ts (excerpt)
projects: [
  { extends: true, test: { name: 'unit', testTimeout: 10_000, ... } },
  { extends: true, test: { name: 'integration', testTimeout: 30_000, ... } },
  { extends: true, test: { name: 'e2e', testTimeout: 120_000, ... } },
]
```

## Helpers

`test/helpers/` is the single source of truth for shared test code. Import
from the barrel — **do not write parallel helpers in individual test files**.

```typescript
import {
  // lifecycle
  useTestDb,         // beforeAll(setup) + afterEach(clean) + afterAll(teardown)
  useTestDbPersistent,
  // fixtures
  makeWorkflowRun,   // in-memory WorkflowRun builder (overrides merge shallowly)
  makeStepState,
  uniqueWorkflowId,  // collision-free id for parallel tests
  uniqueTenantId,
  // assertions
  expectRunStatus,   // rich failure messages with full run context
  expectStepStatus,
  expectStepSequence,
  expectDone,
  // mocks
  mockResolved,
  mockFlaky,         // fails `failCount` times then succeeds — for retry tests
} from '../helpers';
```

**Rules for helpers** (from testing-infrastructure.md §3):
1. Helpers never call `describe` / `it`. They return values or register hooks.
2. Every fixture builder takes `Partial<T>` overrides — never hardcode ids.
3. Mocks used inside `vi.mock(...)` factories must be loaded via async
   dynamic import — see the warning at the top of
   [test/helpers/mocks.ts](./test/helpers/mocks.ts).

## Writing a test — canonical shape

```typescript
import { describe, it, expect } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { useTestDb, expectDone, uniqueWorkflowId } from '../helpers';

describe('my feature', () => {
  useTestDb(); // one line; sets up DB, clears between tests, tears down at end

  it('does the thing', async () => {
    const wfId = uniqueWorkflowId('my-feature');
    const workflow = createWorkflow(wfId, { steps: { /* ... */ } });

    const run = await workflow.start({ value: 10 });
    const result = await workflow.execute(run._id);

    expectDone(result, { value: 10 });
  });
});
```

## MongoDB setup

`test/utils/setup.ts` uses [`mongodb-memory-server`](https://github.com/typegoose/mongodb-memory-server)
— no external MongoDB required. The server is:

- **Shared across test files in the same worker** (via `singleFork: true`
  in the integration + e2e projects).
- **Started lazily** by `setupTestDB()`, which is idempotent.
- **Torn down once** per worker via the global `afterAll` in
  [test/vitest-setup.ts](./test/vitest-setup.ts) — individual test files
  should **not** call `teardownTestDB()` directly (mixing per-file
  teardowns with worker-shared state triggers "different connection
  strings" races).
- **First run** downloads the Mongo binary — that's why `hookTimeout` on
  integration/e2e is 60 s. CI caches after the first build.

## Test coverage expectations

From testing-infrastructure.md §10, before a PR:

- [ ] `pnpm test` green in < 30 s.
- [ ] At least one **scenario** test in e2e exercising the feature's main
      primitive end-to-end (not a unit test in disguise).
- [ ] No `.skip` without a `TODO(issue#N)` comment.
- [ ] No `any` in test files — `unknown` + narrowing, or explicit
      test-only type aliases.

## Common anti-patterns (don't)

| Anti-pattern | Why | Fix |
|---|---|---|
| `mongoose.connect('mongodb://localhost:27017/streamline-test')` at top of a test file | Won't run in CI; leaks state across files | `useTestDb()` from helpers |
| Hardcoded workflow id `'my-workflow'` across tests | Collisions under parallel execution | `uniqueWorkflowId('prefix')` |
| `afterAll(teardownTestDB)` in a test file | The global worker teardown handles it. Per-file teardowns race | Delete the `afterAll` |
| `await new Promise(r => setTimeout(r, 1000))` to "wait for scheduler" | Race condition in disguise | `waitUntil(cond, timeout)` from `test/utils/setup.ts` |
| `expect(result.status).toBe('done')` | Failure message has no context | `expectDone(result, { ... })` from helpers |
| Snapshot tests for workflow output | Non-deterministic timestamps | Assert on structure + regex |
| Live API calls in unit/integration | Breaks CI, masks real regressions | Move to e2e with env gate |

## Targeted commands

```bash
# Single file
pnpm vitest run --project integration test/integration/smoke.test.ts

# By pattern
pnpm vitest run --project e2e -t "idempotency"
pnpm vitest run --project e2e test/e2e/distributed-*

# Watch a single tier during development
pnpm vitest --project unit
pnpm vitest --project integration

# Performance profiling
pnpm vitest run --reporter=verbose       # per-test durations
pnpm vitest run --bail=1                 # stop on first failure
```

## Troubleshooting

**"different connection strings" error.** You're running a test file that
calls `mongoose.connect()` or `teardownTestDB()` directly in its own
lifecycle. Remove those and use `useTestDb()` — the global setup handles
both the start and the stop.

**Test timeouts on first run.** mongodb-memory-server is downloading the
binary (~250 MB). `hookTimeout: 60_000` covers it. Subsequent runs use the
cached binary.

**Hook timeouts mid-suite.** Usually means a previous test file's workflow
didn't shut down. Call `workflow.shutdown()` in `afterEach` / `afterAll` —
the scheduler keeps a timer alive until then.

---

**Last reviewed:** 2026-04-23.
