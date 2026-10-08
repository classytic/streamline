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
| **long** | selected slow integration files, `test/e2e/`, `test/regression/`, `test/pagination/`, `test/core/`, `test/review/` | full workflow scenarios, real timing, scheduler polls | **120 s** | nightly, on-demand |

\* `test/core/` intentionally lives in the long tier today — it exercises
the engine end-to-end.

**Invariant:** unit + integration must run with **no network, no API keys,
no live MongoDB**. If a test needs any of those, it belongs in the long tier.

## Scripts

```bash
pnpm test               # unit + integration (fast CI path, ~20 s)
pnpm test:unit          # unit only, ~5 s
pnpm test:integration   # integration only, ~20 s
pnpm test:long          # slow integration + e2e/regression scenarios
pnpm test:e2e           # alias for test:long
pnpm test:all           # everything
pnpm test:watch         # unit + integration in watch mode
pnpm test:coverage      # unit + integration with coverage report
```

**Rules:**
- `pnpm test` (no args) never runs e2e. Keep it under 30 s on a dev laptop
  — if it crosses that, the next thing developers do is stop running tests
  locally.
- CI runs `pnpm test` on PRs. `pnpm test:long` runs nightly.
- `pnpm prepublishOnly` runs `test:all` (unit + integration + long + build)
  so releases see the full suite.

## Config

One [vitest.config.ts](./vitest.config.ts) with `projects: [unit, integration, long]`.
Tier-specific timeouts live on each project; global options (coverage,
`setupFiles`) are inherited via `extends: true`.

```typescript
// vitest.config.ts (excerpt)
projects: [
  { extends: true, test: { name: 'unit', testTimeout: 10_000, ... } },
  { extends: true, test: { name: 'integration', testTimeout: 30_000, ... } },
  { extends: true, test: { name: 'long', testTimeout: 120_000, ... } },
]
```

## The harness — `@classytic/streamline/testkit`

Streamline ships its test harness (`src/testkit/`) and **its own suite runs on
it** — every engine test exercises the same harness hosts use. In this repo,
`useStreamlineEnv()` (test/helpers/env.ts) wires it into vitest:

```typescript
import { useStreamlineEnv } from '../helpers';

const env = useStreamlineEnv(); // one isolated DB per file, emptied after each test

it('approves', async () => {
  const wf = env.workflow('approval', {          // unique id, env container, autoExecute:false
    steps: { gate: async (ctx) => ctx.waitFor('approved'), ship: async () => 'ok' },
  });
  const run = await wf.start({});
  await wf.execute(run._id);
  await wf.signal(run._id, 'approved', { by: 'ops' });
  expect((await env.until(run._id, 'done')).output).toBe('ok');
});
```

| Need | Use | Never |
|---|---|---|
| A workflow | `env.workflow(name, config)` | `createWorkflow('fixed-id', …)`, a local `uid()` |
| A crash / stale / due / waiting / mid-saga run | `env.runs.staleRunning(wf)` · `retryDue` · `timerDue` · `waitingFor(wf, event)` · `scheduledDue` · `failedAwaitingCompensation` · `staleCompensating` · `insert(wf, fields)` | hand-built `WorkflowRunModel.create({ steps: [...] })` |
| Wait for an outcome | `await env.until(runId, 'done' \| predicate)` | `await new Promise((r) => setTimeout(r, 2000))` |
| Run the scheduler once | `await env.tick(wf)` (poll + wait for what it dispatched) | `scheduler['poll']()`, `new SmartScheduler(...)` |
| Wait on something that is not a run (counter, side effect, stats) | `await env.eventually(() => expect(…))` | `vi.waitFor`, a local `waitForX()` |
| Wait for runs you have no id for | `await env.untilCount(filter, n)` | a local polling loop |
| A second process of the same workflow | `env.worker(wf, config)` (own container) | `createContainer({ connection })` + `createWorkflow(sameId, …)` + manual dispose |
| A new version / same-process restart | `env.redefine(wf, config)` (same container) | `createWorkflow(wf.engine.definition.id, { container: env.container })` |
| An extra bus / cache | `env.createContainer()` (disposed by `clear()`) | `createContainer({ connection: env.connection })` + manual dispose |
| Edit a stored run | `env.runs.update(id, update)` (drops the engine cache) | `env.runModel.updateOne(...)` then a stale cached read |
| Skip a real retry / timer delay | `env.runs.makeDue(id)` then `env.tick(wf)` | moving `retryAfter` by hand, or waiting it out |
| Strict-concurrency counter | `await env.counter(wf, key)` | a local `counterOf()` |
| Read the stored run | `env.runs.get(id)` / `env.runModel` | the global `WorkflowRunModel` |
| Cost of a code path | `await env.trace(fn)` → `writes`, `reads`, `updatesTo(runId)`, `readsOf(runId)` | `vi.spyOn(container.repository, 'updateOne')`, parsing raw commands |

Every env is its own database on ONE MongoDB the run starts in
[test/global-setup.ts](./test/global-setup.ts) (`STREAMLINE_TEST_MONGODB_URI`;
set it to point the suite at a real replica set). Files never see each
other's runs, and nothing touches the default mongoose connection — so a
code path that silently falls back to the global models fails loudly.

Test the default-connection API itself (the free `resumeHook` /
`getHookByToken` fallbacks, the exported singletons) in files dedicated to
that — everything else uses the env.

## Other helpers

`test/helpers/` is the single source of truth for shared test code. Import
from the barrel — **do not write parallel helpers in individual test files**.

```typescript
import {
  useStreamlineEnv,  // the harness (above) — the default for every DB test
  // assertions
  expectRunStatus,   // rich failure messages with full run context
  expectStepStatus,
  expectStepSequence,
  expectDone,
  // pure fixtures (no DB)
  makeWorkflowRun,   // in-memory WorkflowRun builder (overrides merge shallowly)
  makeStepState,
  // mocks
  mockResolved,
  mockFlaky,         // fails `failCount` times then succeeds — for retry tests
} from '../helpers';
```

`useTestDb()` / `setupTestDB()` (global connection) remain only for files not
yet migrated — new tests use `useStreamlineEnv()`.

**Rules for helpers** (from testing-infrastructure.md §3):
1. Helpers never call `describe` / `it`. They return values or register hooks.
2. Every fixture builder takes `Partial<T>` overrides — never hardcode ids.
3. Mocks used inside `vi.mock(...)` factories must be loaded via async
   dynamic import — see the warning at the top of
   [test/helpers/mocks.ts](./test/helpers/mocks.ts).

## Writing a test — canonical shape

```typescript
import { describe, it } from 'vitest';
import { expectDone, useStreamlineEnv } from '../helpers';

const env = useStreamlineEnv();

describe('my feature', () => {
  it('does the thing', async () => {
    const workflow = env.workflow('my-feature', { steps: { /* ... */ } });

    const run = await workflow.start({ value: 10 });
    const result = await workflow.execute(run._id);

    expectDone(result, { value: 10 });
  });

  it('recovers after a crash', async () => {
    const workflow = env.workflow('my-feature', { steps: { /* ... */ } });
    const run = await env.runs.staleRunning(workflow); // the shape a dead worker leaves

    await env.tick(workflow);                          // one scheduler poll, deterministically
    await env.until(run._id, 'done');
  });
});
```

## MongoDB setup (legacy `useTestDb` files)

Migrated files use the harness (one server per run, one database per env — see
above). Files still on `test/utils/setup.ts` use
[`mongodb-memory-server`](https://github.com/typegoose/mongodb-memory-server) on
the global connection. That server is:

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
- [ ] At least one **scenario** test in the long tier exercising the feature's main
      primitive end-to-end (not a unit test in disguise).
- [ ] No `.skip` without a `TODO(issue#N)` comment.
- [ ] No `any` in test files — `unknown` + narrowing, or explicit
      test-only type aliases.

## Common anti-patterns (don't)

| Anti-pattern | Why | Fix |
|---|---|---|
| `mongoose.connect('mongodb://localhost:27017/streamline-test')` at top of a test file | Won't run in CI; leaks state across files | `useStreamlineEnv()` |
| Hardcoded workflow id `'my-workflow'`, or a local `uid()` | Collisions; duplicated helper | `env.workflow('name', …)` |
| Hand-built run docs (`WorkflowRunModel.create({ steps: [...] })`) | Drifts from the real shape; duplicated in 20+ files | `env.runs.*` fixtures |
| `await new Promise(r => setTimeout(r, 1000))` to "wait for scheduler" | Race condition in disguise — the flakes under load | `env.until(runId, status)` / `env.tick(wf)` |
| `scheduler['poll']()` / `new SmartScheduler(...)` | Private API; diverges from engine wiring | `env.tick(wf)` |
| `expect(result.status).toBe('done')` | Failure message has no context | `expectDone(result, { ... })` from helpers |
| Snapshot tests for workflow output | Non-deterministic timestamps | Assert on structure + regex |
| Live API calls in unit/integration | Breaks CI, masks real regressions | Move to e2e with env gate |

## Targeted commands

```bash
# Single file
pnpm vitest run --project integration test/integration/smoke.test.ts

# By pattern
pnpm vitest run --project long -t "idempotency"
pnpm vitest run --project long test/e2e/distributed-*

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

**Last reviewed:** 2026-10-02.
