# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [2.8.2] - 2026-07-19 — ESR-correct scheduler indexes, mongokit ≥3.24.0

### Changed — `WorkflowRunSchema` scheduler indexes corrected for ESR

Two indexes that violated MongoDB's ESR (Equality → Sort → Range) rule have
been replaced with one correct compound index:

**Removed:**
- `{ status: 1, paused: 1, workflowId: 1, updatedAt: 1, _id: 1 }` — `paused`
  is a `$ne` range predicate; placing it in the equality prefix stops the
  planner using `workflowId` or `updatedAt` for bounds, forcing a blocking
  sort on every scheduler poll tick.
- `{ status: 1, paused: 1, steps: 1, updatedAt: 1, _id: 1 }` — a bare
  `{ steps: 1 }` multikey index cannot serve `$elemMatch` on step subfields;
  it only bloated the index and slowed every step-state write.

**Added:**
- `{ status: 1, workflowId: 1, updatedAt: 1, _id: 1 }` — ESR-correct: both
  equality predicates (`status`, `workflowId`) lead, then the sort key
  (`updatedAt`), then the tiebreaker (`_id`). Range predicates (`paused: {$ne}`,
  `steps: {$elemMatch}`, `scheduling.executionTime: {$lte}`) are left as cheap
  residuals over the tiny per-(status, workflowId) working set — they must not
  appear in the prefix per ESR.

Requires `@classytic/mongokit ≥3.24.0` whose keyset warning detector is
ESR/range-aware (`classifyFilterFields`): it accepts the equality-lead index
and no longer demands range fields sit in the prefix.

### Changed — peer floor

- `@classytic/mongokit`: `>=3.14.0` → `>=3.24.0`

## [2.8.0] - 2026-07-08 — Human-in-the-loop primitives, checkpoint-slot guard, generic hooks

Additive, no behavior change for existing workflows. Two ergonomics/safety
fixes and one flagship feature — a typed, durable human-in-the-loop layer that
makes "pause the workflow, ask a human, resume" a first-class primitive instead
of a hand-rolled hook dance.

### Added — human-in-the-loop primitives (`features/approval.ts`)

A cohesive, fully-typed layer over the existing hook + wait-resolution
machinery — pure composition, so it inherits their durability (cross-restart,
multi-worker, fail-closed token validation) with no engine or storage changes.

- **Approval gate** — `requestApproval(ctx, { reason, metadata?, expiresAt?, onToken?, token? })`
  parks the run and hands the resume token to `onToken` (persist it for the
  approver UI). Resume side: `approve(token, data?)` / `reject(token, reason?)`.
  The next step calls `readApprovalDecision(output)` → a discriminated
  `ApprovalDecision` covering ALL FOUR real outcomes: `approved` (with data),
  `rejected` (with reason), `withdrawn` (`cancelHook`), `timed_out` (`expiresAt`
  sweep). Flow-tools like n8n collapse these into "resumed / not".
- **Ask/answer** — the generalization for arbitrary human INPUT mid-flow (an OTP
  typed into a background browser automation, a captcha, a chosen value):
  `ask(ctx, { question, … })` → `answer(token, value)` → `readAnswer<T>(output)`
  returns `{ status: 'answered', value } | 'withdrawn' | 'timed_out'`. Combine
  with `ctx.goto()` for a **durable interactive loop** — ask an OTP each turn,
  resume exactly where it paused across an unbounded number of turns, surviving
  restarts. See the module docstring for the browser-login example.
- New exports: `requestApproval`, `approve`, `reject`, `readApprovalDecision`,
  `ask`, `answer`, `readAnswer` + types `ApprovalDecision`, `AnswerResult`,
  `RequestApprovalOptions`, `AskOptions`, `ApprovalResumeOptions`.

### Added — checkpoint-slot guard (`ctx.scatter` / `ctx.loop` / `ctx.checkpoint`)

A step has ONE checkpoint slot (`output.__checkpoint`); `scatter()` and `loop()`
claim it for durable recovery. Previously, a `ctx.checkpoint()` — or a nested
`scatter()`/`loop()` — inside a scatter task silently clobbered that slot and
re-ran completed work. Now it throws a clear runtime error naming the owner
instead of corrupting recovery state. The slot is released in a `finally`, so a
failing scatter never wedges a subsequent checkpoint. Behavior change only for
code that was already misusing the slot (silent corruption → loud error).

### Changed — `createHook` is generic over the step context

`createHook<TContext, TOutputs>(ctx: StepContext<TContext, TOutputs>, …)` — it
only ever read `ctx.runId` / `ctx.stepId`, but the bare `StepContext` param
forced consumers with a typed context to write
`createHook(ctx as unknown as StepContext<Record<string, unknown>>, …)`. That
cast is gone. Backward-compatible — the default type parameters preserve every
existing call.

### Tests

`test/unit/approval.test.ts` (11), `test/unit/context-slot-guard.test.ts` (8),
`test/integration/approval-primitive.test.ts` (5, real-engine round-trip of
approve/reject/withdraw/timeout + ask/answer). Full suite 461 green.


## [2.7.0] - 2026-07-06 — Tenant-scope hardening + queryable progress, task guards, durable dedupe, operator pause/resume, run metrics

The next release after 2.6.0. Two bodies of work land together: an
audit-driven hardening pass (one HIGH tenant-isolation fix, four MEDIUM
correctness fixes, strictness + packaging + the mongokit 3.18 / repo-core
0.7 / primitives 0.9 dependency bump) AND six additive, generalized
features (queryable progress, task-guard middleware, durable dedupe,
operator pause/resume, run metrics, cancel-with-reason). Every new
`WorkflowEventName` is registered in the exhaustive event-sink registry +
`STREAMLINE_EVENTS` + `LEGACY_TO_CANONICAL` (the no-drift guard proves it).
All new fields are default-absent (no schema growth, no migration) and all
new hooks are opt-in — existing workflows are unaffected. Three deliberate
behavior changes are called out inline in the "Fixed" sections below (tenant
hook coverage, event-sink defaults, terminal-cancel idempotency).

## New features

### Added — queryable step/run progress (`ctx.reportProgress`, throttled persistence)

`ctx.stream()` frames are non-durable and invisible to a UI page-refresh or a
new client with no stream history. `ctx.reportProgress(p)` persists the LATEST
snapshot onto `StepState.lastProgress` (a bounded `StepProgress`:
`{ phase?, percent?, message?, estimatedSecondsRemaining?, at }`, all optional
but `at`). Persistence is **throttled** — at most one DB write per second per
step, coalescing rapid calls latest-wins in memory, with the final value ALWAYS
flushed on step completion. `message` is truncated if the serialized snapshot
would exceed ~1KB. Read it back with:

- `engine.getStepProgress(runId, stepId)` → `StepProgress | undefined`
- `engine.getRunProgress(runId)` → `{ status, steps: [{ stepId, status, lastProgress? }] }`

Both are plain, tenant-scoped reads off the run doc (through the repository, so
a fresh engine after a restart returns persisted progress). Also exposed on the
`Workflow` facade: `wf.getStepProgress` / `wf.getRunProgress`.

### Added — generalized per-step / per-scatter-task guard middleware (`taskMiddleware`)

A GENERAL seam — the engine bakes in **no** policy (no budget primitive).
`taskMiddleware: TaskMiddleware[]` on the workflow config:

```ts
interface TaskMiddleware {
  before?: (ctx: TaskHookContext) => Promise<TaskGuardResult> | TaskGuardResult;
  after?:  (ctx: TaskHookContext & { result?, error?, durationMs }) => Promise<void> | void;
}
type TaskHookContext = { runId; stepId; workflowId; taskKey?; attempt; tenantId? };
type TaskGuardResult = { allow: true } | { allow: false; reason? };
```

`before` fires before each STEP and before each SCATTER TASK (`taskKey` set for
scatter sub-tasks). Returning `{ allow: false, reason }` rejects that unit with
a **`NonRetriableError`** carrying the reason — the step fails without retry, or
the single scatter task is rejected while its siblings proceed. `after` fires
after each unit settles with `result` (success) or `error` (failure) plus
`durationMs`; it is the recording hook. `after` errors are logged + swallowed;
a `before` that THROWS is treated fail-closed as a rejection. Absent middleware
= zero behavior change (default path untouched).

**Budget is a RECIPE, not a primitive.** Enforce a per-run spend cap in host
code: track spend in an external store keyed by `runId`; in `before`, read the
running total and reject when it would exceed the cap; in `after`, add the
just-finished unit's `actualCost` (optionally persisting it to `StepState.cost`
via a repo write for `getRunMetrics`). The engine never learns what a "budget"
is.

### Added — durable per-step dedupe cache (`ctx.dedupe`)

`ctx.dedupe<T>(key, fn): Promise<T>` memoizes `fn`'s resolved value into the run
doc (`StepState.dedupeCache`) keyed by `key` within the step. On a retry or a
crash-replay, an existing key returns the cached value WITHOUT re-running `fn` —
the "run this side effect at most once, even across crashes" primitive. The
cache write commits to the run doc **before** the value is returned (crash-safe).
Bounded ~10KB per step: an over-budget value is NOT cached (fn runs, a warning
is logged) so a large value degrades to "run every time" instead of growing the
doc.

`ctx.scatter()` already provides per-task failed-only retry via its checkpoint
slot (a 20-task scatter where 18 succeeded re-runs only the 2 failures, with no
host idempotency guard) — that behavior is unchanged and backward-compatible.
`ctx.dedupe` generalizes the same guarantee to any sub-operation. See "solo
decisions" note in the PR: scatter's per-task durability was kept on its
existing checkpoint mechanism rather than rewritten onto `dedupe`, to preserve
its exact tested semantics.

### Added — operator pause / resume of a RUNNING run

- `engine.pause(runId, { reason? })` — sets the durable `paused` flag (idempotent
  no-op on terminal/already-paused runs, mirroring `cancel`). Emits
  `workflow:paused` with the reason. **Honesty (rule 33):** pause takes effect at
  the NEXT step boundary — the in-flight step handler is an in-flight promise and
  is NOT interrupted; it finishes, then no further step is claimed. The
  scheduler and `executeRetry` already skip `paused` runs (`.notPaused()` on
  every pickup query).
- `engine.resume(runId, { data? })` continues from the same step (existing);
  `engine.resumeOperator(runId, { data? })` is the symmetric operator wrapper
  that also synthesizes `workflow:resumed` for the paused-while-running case
  (the waiting case already emits `workflow:resumed` via the executor, so no
  double-emit).

New event `workflow:paused` added to the exhaustive registry. `workflow:resumed`
is REUSED for operator resume (it predates this release for hook/wait resume).

### Added — run metrics aggregation (`engine.getRunMetrics`)

`engine.getRunMetrics(runId)` → `RunMetrics` — pure aggregation over the run
doc's `StepState` (`durationMs` + `attempts`, already present):

```ts
interface RunMetrics {
  runId; status;
  steps: Array<{ stepId; durationMs?; attempts; cost? }>;
  totalDurationMs; totalCost?;
}
```

`cost` is a new optional `StepState.cost` a host/`taskMiddleware.after` records;
`totalCost` is the sum only when at least one step carries a cost, else
`undefined`. Queryable for terminal AND in-flight runs.

### Added — `cancel(runId, { reason })` (additive cancel reason)

`engine.cancel` now accepts an optional `{ reason? }`. The reason persists on the
run as `WorkflowRun.cancellationReason` and is echoed in the `workflow:cancelled`
event payload (`data.reason`). Backward-compatible: `cancel(runId)` with no
reason leaves the field unset (byte-for-byte the pre-2.7 shape). Preserves the
idempotent-no-op-on-terminal behavior (see the tenant/cancel fixes below) — a
terminal-run cancel never overwrites an existing reason.

### Future (not implemented) — cross-workflow priority queueing

Sketch for a later slice: a `priority` field already exists on `WorkflowRun`;
cross-workflow priority scheduling would sort the scheduler pickup by
`{ priority: -1, createdAt: 1 }` and add **aging** (periodically bump the
effective priority of long-waiting drafts) to prevent starvation of low-priority
work behind a flood of high-priority runs. Deliberately deferred — the current
per-engine schedulers pick up their own workflow's runs, so a global priority
queue needs a shared scheduler design first.

### Public API added

- `ctx.reportProgress(p)`, `ctx.dedupe(key, fn)`
- `engine.getStepProgress`, `engine.getRunProgress`, `engine.getRunMetrics`,
  `engine.pause(runId, { reason })`, `engine.resumeOperator(runId, { data })`,
  `engine.cancel(runId, { reason })`
- `wf.getStepProgress`, `wf.getRunProgress`, `wf.getRunMetrics`,
  `wf.pause(runId, { reason })`, `wf.resumeOperator`, `wf.cancel(runId, { reason })`
- Config: `WorkflowConfig.taskMiddleware`
- Types: `StepProgress`, `RunProgress`, `RunMetrics`, `TaskMiddleware`,
  `TaskHookContext`, `TaskGuardResult`, `WorkflowPausedPayload`
- Fields: `StepState.lastProgress`, `StepState.dedupeCache`, `StepState.cost`,
  `WorkflowRun.cancellationReason`
- Event: `workflow:paused` (+ `streamline:workflow.paused`)

## Audit hardening

### Fixed — tenant-filter plugin hook coverage is now DERIVED from mongokit's `OP_REGISTRY` (HIGH)

The plugin's hand-enumerated hook list had drifted behind mongokit:
`before:cursor`, `before:claimVersion`, and `before:getOrCreate` were never
registered, so reads through `cursor()` (including
`cursorStaleRunning()`), CAS writes through `claimVersion()`, and
`getOrCreate()` upserts ran **tenant-UNSCOPED** — the call succeeded and
quietly crossed tenants. Hook registration is now derived from
`OP_REGISTRY` policy keys (the same source mongokit's own
`multiTenantPlugin` uses), so every current op — including `restore`,
`distinct`, `aggregate`, `aggregatePipeline`, `watch`,
`aggregatePipelinePaginate`, `lookupPopulate`, and `bulkWrite`
(per-sub-op filter/document injection) — and every FUTURE op is scoped
automatically. `cursorStaleRunning()`'s docstring claim ("routes through
`before:cursor`") is finally true.

**Behavior change (strict mode):** ops that previously ran unscoped now
throw `Missing tenantId` on a strict-tenant repository unless the caller
passes `tenantId` / `bypassTenant` — that throw is the isolation guarantee
working. Non-tenant (default) repositories are unaffected.

### Fixed — retention TTL covers ALL terminal statuses (saga outcomes included)

The TTL index's `partialFilterExpression` hard-coded
`['done','failed','cancelled']`, so terminal saga runs (`compensated` /
`compensation_failed`) were **never TTL-purged** and accumulated forever.
The filter now derives from the new `TERMINAL_RUN_STATUSES` export in
`core/status.ts`, itself backed by an exhaustive
`Record<RunStatus, boolean>` classification — adding a run status without
classifying it is a compile error, so the TTL can never drift again.
`isTerminalState()` reads the same classification.

**Migration:** this changes the TTL index's `partialFilterExpression`, and
MongoDB will not alter an existing index in place. Re-run
`container.syncRetentionIndexes()` (or the module-level
`syncRetentionIndexes(repository, options)`) after deploying 2.7.0 — it
detects the spec conflict (codes 85/86) and drops + recreates
`streamline_terminal_runs_ttl` automatically. Until you do, settled saga
runs remain un-purged (the pre-2.7 behavior, no worse).

### Fixed — `SchedulingService.schedule()` works under strict-tenant repositories

`scheduleWorkflow` accepted `tenantId` but (a) never forwarded it as
repository options — a strict-tenant repo's `before:create` hook threw —
and (b) stamped a hard-coded `context.tenantId` key regardless of the
plugin's configured `tenantField`. It now forwards `{ tenantId }` into
`repository.create()` (same pattern as `engine.start()`), and stamps the
context via the repository's configured `tenantField` (the
`bumpDebounceDraft` mechanism); non-`context.*` fields (e.g. `meta.orgId`)
are stamped by the plugin's `before:create` injection at the configured
path.

### Fixed — `resumeViaDb` (cross-process hook resume) rework

Three defects in the durable `resumeHook` fallback:

1. **Owning repository.** Writes always went through the module-level
   repository singleton, bypassing a custom container's plugin chain
   (audit, tenant, observability). Resolution order is now: explicit
   injection → registered engine's container repository → singleton.
   New optional arg: `resumeHook(token, payload, { repository })` /
   `cancelHook(token, { reason, repository })`.
2. **Atomic advance.** The step-done write and the `currentStepId`
   advance (or completion) were two separate updates — a crash between
   them left `status: 'running'` pointing at a done step. They are now
   ONE `findOneAndUpdate` behind a `status + steps.<i>.status` CAS guard;
   the intermediate state can no longer exist, and the epoch
   `lastHeartbeat` stamp for engine-less resumes rides the same write.
3. **Completion contract.** The "no next step" path marked the run done
   via a raw write with NO `workflow:completed` emission and never
   released the strict-concurrency slot (the counter leaked until
   recount). It now mirrors the engine's completion contract: durable
   write first, then `workflow:completed` on the owning container bus
   (whose `releaseSlotOnTerminal` listener frees the slot); with no
   engine in-process the slot is released explicitly against the counter
   repository.

### Fixed — `engine.cancel()` is an idempotent no-op on terminal runs

`cancel(runId)` on an already-terminal run (`done` / `failed` /
`cancelled` / `compensated` / `compensation_failed`) previously
overwrote the terminal status with `cancelled` — an illegal
`RUN_MACHINE` transition that retroactively falsified a completed
outcome and re-fired terminal listeners. It now returns the run
unchanged (no write, no `workflow:cancelled` emission), mirroring
`pause()`'s guard. **Behavior change** for callers that relied on
re-labelling finished runs; cancel before the run settles instead.

### Changed — event-sink default list is compile-time exhaustive

`createEventSink`'s default event array was hand-rolled and had drifted:
`workflow:retry`, the saga lifecycle (`workflow:compensating` /
`:compensated` / `:compensation_failed`), `step:compensated`,
`step:stream`, `engine:error`, and `scheduler:*` were silently never
forwarded. The default is now derived from an exhaustive
`Record<WorkflowEventName, true>` registry (a new event that isn't
classified is a compile error) minus one explicit named exclusion:
`step:stream` (non-durable, high-frequency `ctx.stream()` frames — opt in
via `options.events`). New exports: `ALL_WORKFLOW_EVENT_NAMES`,
`EVENT_SINK_DEFAULT_EXCLUSIONS`.

**Behavior change:** default sinks (no `options.events`) now receive the
previously-dropped events above. Sinks that pass an explicit `events`
list are unaffected.

### Changed — `exactOptionalPropertyTypes: true`

The compiler now distinguishes "absent" from "explicitly `undefined`".
All fallout fixed by honest type widening (`T | undefined` on fields the
engine deliberately clears, or that hosts build from possibly-absent
values) — zero casts added. Host-facing option bags widened so
`{ ...base, field: maybeUndefined }` spreads keep compiling:
`TenantFilterOptions`, `RetentionOptions`, `ContainerOptions`,
`WorkflowEngineOptions`, `engine.start()` options, plus the persistence
shapes (`WorkflowRun`, `StepState`, `StepError`, `WaitingFor`,
`SchedulingInfo`, `JoinBranchResult`). Type-level change only — no
runtime behavior difference.

### Changed — logged (still-swallowed) failure paths

Three fire-and-forget catch sites now log at `warn` via the streamline
logger (configure with `configureStreamlineLogger`) instead of swallowing
silently: event-transport bridge publish failures (`events/bridge.ts`),
`cancelOn`-triggered cancel failures (`engine.start` listener), and step
log-flush failures (`executor`, buffered `ctx.log` entries dropped).
Swallowing is still correct at all three sites — now it's diagnosable.

### Changed — dependencies

Dev/test matrix upgraded and verified: `@classytic/mongokit` `^3.18.0`,
`@classytic/repo-core` `^0.7.0`, `@classytic/primitives` `^0.9.1`. No
source changes required. `peerDependencies` floors are unchanged, but
note: **mongokit 3.18 itself peer-requires `@classytic/repo-core >=0.7.0`**
— hosts upgrading mongokit must bring repo-core along. The tenant-filter
plugin's `OP_REGISTRY` derivation uses exports present since mongokit
3.14 (the existing floor).

### Packaging & docs

- `publishConfig.access: "public"` declared explicitly; `CHANGELOG.md`
  now ships in the npm tarball (`files`).
- JSDoc `@example` imports referencing non-existent subpaths
  (`@classytic/streamline/plugins`, `/scheduling`) corrected to root
  imports — the package exports only `.`, `./fastify`, `./telemetry`.
- Hand-rolled duplicate-key detector replaced with mongokit's
  `isDuplicateKeyError` (also catches mongoose-wrapped shapes).
- Every `schema.index()` in `run.model.ts` now names the query it serves.

### Testing

- Tenant plugin: `cursor` / `cursorStaleRunning` / `claimVersion` /
  `getOrCreate` tenant-scoping + strict-throw coverage.
- Retention: TTL filter includes all terminal statuses + a no-drift
  assertion tying the index spec to the state machine's terminal set.
- Scheduling: strict-tenant scheduling (stamped + scoped + strict-throw +
  configured-field, not hard-coded literal).
- `resumeViaDb`: injected-repository routing, single-round-trip atomic
  advance (repo spy + CAS-guard shape), completion emission + strict-slot
  release to zero.
- Event sink: no-drift tests (registry ↔ constants map, default-vs-
  exclusion completeness, `options.events` override).
- Generalized API contracts: `wf.cancel` (mid-step abort via `ctx.signal`,
  during-wait, terminal idempotency), `cancelHook` reason persistence +
  event payload + late-resume rejection + saga-compensation composition,
  step outputs rehydrating on a fresh engine after restart, `ctx.loop`
  resuming at the committed iteration (with accumulator) on a NEW engine.
- Type-level DX tests (`test/type-inference.test-d.ts`, now including
  typed step outputs both-ways checking) are wired into the `unit`
  project via vitest `typecheck` — previously nothing verified that file.


## [2.6.0] - 2026-06-11 — Typed outputs, durable loops, recurring schedules, payload guards

One release, five additive capabilities. No behavior changes for existing
workflows — every feature is opt-in or warn-only by default.

### Added — typed step outputs (`ctx.outputs`)

`createWorkflow` gains an optional third generic, `TOutputs`. Declare an
outputs interface once and every handler gets typed, typo-checked access to
sibling step outputs — no more `getOutput<T>('...')` casting:

```ts
interface Outputs {
  fetch: { html: string };
  parse: { items: number };
}
createWorkflow<Ctx, Input, Outputs>('scrape', {
  steps: {
    fetch: async (ctx) => ({ html: await get(ctx.context.url) }),
    parse: async (ctx) => ({ items: count(ctx.outputs.fetch?.html) }),
    //                                       ^ typed; typo = compile error
  },
});
```

With a declared `TOutputs`, the steps map is checked both ways: every
declared step must exist, no extra steps are allowed, and each handler's
resolved return type must match. Without the generic, behavior and types are
byte-for-byte 2.5 (`ctx.outputs.x` is `unknown`); `getOutput` is unchanged
and remains the dynamic-step-id path. `TOutputs` is deliberately
non-inferable (`NoInfer`-guarded) — inferring it from the steps object would
be circular and collapse to implicit-any. Runtime: `ctx.outputs` is a lazy
proxy over the loaded run's steps (enumerable, `undefined` for incomplete
steps). New export: `WorkflowSteps` type.

### Added — `ctx.loop` (durable agent-loop primitive)

```ts
const final = await ctx.loop(
  { messages: [seed] },
  async (state, i) => {
    const reply = await llm.chat(state.messages, {
      idempotencyKey: ctx.idempotencyKey(`iter:${i}`),
    });
    return { state: { messages: [...state.messages, reply] }, done: reply.stop };
  },
  { maxIterations: 50 },
);
```

Runs `body(state, iteration)` until `{ done: true }`, durably checkpointing
state after EVERY iteration. Each checkpoint write also bumps the run's
heartbeat, so a long loop never trips the stale detector. Crash/retry
recovery resumes from the last committed iteration — completed iterations
never re-run; the interrupted one re-runs from its start (at-least-once per
iteration; pass `ctx.idempotencyKey('iter:N')` to external side effects).
`maxIterations` (default 1000) fails the step NON-retriably — a runaway
agent can't spin forever. Owns the step's checkpoint slot (same constraint
as `ctx.scatter`).

### Added — recurring schedules are now driven (daily/weekly/monthly/cron)

`scheduling.recurrence` was stored but never acted on — recurring jobs
required hand-rolled re-scheduling. Now the engine drives the chain: when
the scheduler claims a recurring scheduled draft, the claim winner spawns
the NEXT occurrence as a new draft with a deterministic idempotency key
(`<workflowId>:recur:<nextFireISO>`), so a crash or duplicate pickup can
never double-spawn.

- Patterns: `daily` / `weekly` (`daysOfWeek`, 0=Sunday) / `monthly`
  (`dayOfMonth`, clamped to short months) / `custom` (5-field cron via
  `cron-parser`, evaluated in the schedule's IANA timezone).
- Wall-clock semantics: "9am daily in New York" stays 9am across DST
  (routes through the existing DST-aware `TimezoneHandler`).
- No catch-up: occurrences missed while the engine was down are skipped,
  not replayed.
- `until` / `count` end the chain; `occurrences` counts firings.
- Overlap policy: occurrences are independent runs — combine with
  `concurrency: { limit: 1 }` to prevent overlap of long jobs.
- `SchedulingService.schedule()` now VALIDATES `recurrence` and throws on
  malformed patterns (was: stored silently, never fired).
- **Legacy-data guard:** `recurrence` stored on pre-2.6 runs (when the field
  was inert) only activates if its `pattern` is one of the four recognized
  values (and `custom` has a `cronExpression`) — unknown shapes stay inert
  rather than silently starting to fire. Migration note: if you DID store
  valid recurrence data pre-2.6 expecting it to stay inert, strip it before
  upgrading.
- New exports: `computeNextOccurrence` (preview the next firing),
  `validateRecurrence`. New runtime dependency: `cron-parser@^5`.
- Dev/test matrix: built and verified against the published mongokit 3.16.0 +
  repo-core 0.6.0 (also green on 3.14/0.5 and 3.15/0.5). Peer FLOORS are
  unchanged (`mongokit >=3.14`, `repo-core >=0.5`, `primitives >=0.6`) —
  streamline uses no 3.16/0.6-exclusive API, the floor stays at the versions
  whose primitives it load-bears (`claim()`, `MongoOperatorUpdate`,
  `HttpError`), and the open ranges already admit the new releases. Hosts on
  mongokit 3.16 automatically get `repo.capabilities` / `watch()` on
  streamline's repositories via inheritance.

### Added — payload size guards (`maxPayloadBytes`)

Step outputs, checkpoints, context and history all live inline on the run
document; one oversized payload used to kill the run at Mongo's 16MB BSON
cap with an opaque driver error. Now:

- **Default (no config): warn-only.** Outputs/checkpoints over 1MB log a
  warning naming the run + step. Nothing is rejected.
- **Opt-in hard cap:** `createWorkflow('x', { maxPayloadBytes: 2_000_000 })`
  fails the step NON-retriably (retrying can't shrink a payload) with a
  message telling you to store a reference/handle instead.

### Added — step middleware (observability seam)

`createWorkflow('x', { middleware: [...] })` — cross-cutting hooks awaited
around every step execution, in array order:

- `beforeStep` — after the atomic claim, before the handler.
- `afterStep` — after the durable success write (`output` + `durationMs`).
- `onStepError` — handler threw a non-wait error (before retry handling).
- `onWait` — handler suspended (`wait`/`sleep`/`waitFor`/child/branch join),
  with `waitType` + `reason`.

**Observability-only by contract:** a hook that throws is logged and
SWALLOWED — middleware can never veto, fail, retry, or suspend a step, so
the seam adds zero new control-flow failure modes. Use it for metrics,
tracing, token metering, structured logging. New exports: `StepMiddleware`,
`StepMiddlewareInfo`.

### Added — `ctx.stream(frame)` (non-durable progress frames)

Fire-and-forget streaming for live UIs (LLM tokens, percent-complete).
Frames are emitted as `step:stream` on the container event bus (payload:
`{ runId, stepId, attempt, seq, frame, timestamp }`) and republished on the
cross-process signal store (`streamline:stream:<runId>`); the arc-shape
transport maps it to canonical `streamline:step.stream`.

Deliberately weaker contract than everything else in streamline —
**at-most-once, never persisted, side-effect-free on run state**: a crash
loses unflushed frames, a retry restarts `seq` at 0, and frames emitted
after cancellation are dropped silently (abort ≠ error — same discipline as
the AI SDK). Durable data belongs in step outputs / checkpoints, never in
frames. Arc's SSE endpoint (`@classytic/arc/integrations/streamline`)
delivers these to browsers. New event + payload type: `'step:stream'`,
`StepStreamPayload`; new canonical constant `STREAMLINE_EVENTS.STEP_STREAM`.

### Fixed — heartbeat resilience under transient DB blips

The heartbeat loop now (a) skips a tick while the previous write is still
in flight — a hung write no longer piles up overlapping updates or inflates
the failure count — and (b) retries once in-tick (delay scales with the
interval; 1s at the default 30s cadence) before counting a failure, so a
single socket reset / replica-set stepdown no longer moves a step toward
the abort threshold. The abort semantics past
`HEARTBEAT_FAILURE_ABORT_THRESHOLD` are unchanged.

## [2.5.0] - 2026-06-05 — Hands-off human-in-the-loop + shared-bus listener fix

A single release focused on making human-in-the-loop / approval ("hands-off")
workflows production-grade, plus a shared-bus listener fix. All changes are
additive (new API + a default-absent field); existing workflows behave
byte-for-byte as before.

### Added — inspect parked human waits without resuming (approval queues + authz)

Building an approval UI / authorization gate previously meant hand-rolling
queries against `workflow_runs`. Three read-only surfaces close that — none
mutate a run (resuming is still `resumeHook`):

- **`getHookByToken(token): Promise<PendingHook | null>`** — inspect one parked
  approval before resuming (authorize a reviewer, render a card). Fail-closed
  on the token (parity with `resumeHook`): only the step that stored that exact
  token matches, so a guessed `<runId>:…` reveals nothing.
- **`listPendingHooks({ workflowId?, limit? }): Promise<PendingHook[]>`** — the
  pending-approvals queue, oldest-first, each entry carrying the resume `token`,
  `reason`, and host `metadata` so a dashboard renders + routes without a
  second fetch.
- **`WorkflowRunRepository.getWaitingRuns(waitType?, limit?, options?)`** — the
  tenant-aware query behind it, routed through inherited mongokit `findAll`
  (tenant scope + plugins fire). Multi-tenant hosts call it on their container
  repository with `{ tenantId }`; standalone `listPendingHooks` uses the
  default singleton (same as `resumeHook`'s durable path).

`createHook(ctx, reason, options)` now **uses** `reason` (it was the ignored
`_reason` param) and accepts `options.metadata`; both are echoed on the
`HookResult` so you forward them onto the waiting step in one place. They land
on `waitingFor.reason` / `waitingFor.data.metadata` — exactly what the
inspectors read. New exported type **`PendingHook`**.

### Added — waits can time out (`expiresAt`) or be withdrawn (`cancelHook`)

A `ctx.wait(...)` for approval previously parked **forever** if no one
answered — a real hazard for long-running workflows. Now:

- **`expiresAt`** on `createHook` / the wait data — when the deadline passes,
  the scheduler's new expiry sweep auto-resumes the step with a timeout
  sentinel:

  ```ts
  const hook = createHook(ctx, 'manager approval', {
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return ctx.wait(hook.reason, { hookToken: hook.token, expiresAt: hook.expiresAt });
  ```

  Lands on `waitingFor.expiresAt`; the scheduler matches `expiresAt <= now`
  (new `getExpiredWaits` repo query, mirrors the timer-ready sweep) and resumes
  via `engine.resume(runId, timeoutSentinel)`. Race-safe against a concurrent
  `resumeHook` via the existing `waiting → running` CAS (whichever wins, the
  other is a no-op). A human wait with `expiresAt` also ensures the scheduler is
  polling, so the deadline fires even on an engine that booted idle.

- **`cancelHook(token, { reason? })`** — withdraw a pending wait (superseded /
  escalated / source deleted). Resumes with a cancellation sentinel;
  token-validated + fail-closed exactly like `resumeHook`. Withdraws THE WAIT,
  not the run — to abort the whole workflow use `wf.cancel(runId)`.

- **`getWaitResolution(output)`** + **`WaitResolution`** type — in the step
  AFTER the wait, discriminate a normal answer (real payload → `null`) from a
  `timeout` (`{ __waitResolved: 'timeout' }`) or `cancelled`
  (`{ __waitResolved: 'cancelled', reason }`). Sentinels never leak into the
  happy path. New `WaitingFor.expiresAt` field is default-absent (no migration).

### Fixed — engine slot-release listeners registered unconditionally on a shared bus (perf + warning)

`WorkflowEngine`'s constructor attached 5 lifecycle listeners
(`workflow:completed` / `:failed` / `:cancelled` / `:compensated` /
`:compensation_failed`) to its container's event bus **unconditionally**. Those
listeners exist only to release `concurrency.strict` slots and early-return for
any run without a `meta.concurrencyCounterId` — i.e. for every non-strict
workflow. On a shared bus (`createContainer({ eventBus: 'global' })`, the
standard multi-workflow wiring) every engine piled its 5 onto the one bus, so N
workflows crossed Node's 10-listener-per-event cap (a boot-time
`MaxListenersExceededWarning`) AND every terminal event fanned out to an O(N)
`getById` storm that each non-owning engine immediately discarded.

Registration is now gated on a new `usesStrictConcurrency` engine option, which
`createWorkflow` sets `true` only for workflows declaring `concurrency.strict`.
Non-strict workflows register **zero** engine bus listeners. Behavior-preserving
(a non-strict run never carries the marker those listeners act on); strict
workflows are unchanged and `shutdown()` still tears their listeners down.

## [2.4.1] - 2026-06-04 — Index fix: workflow-scoped keyset sweeps

### Fixed — missing index for workflowId-scoped scheduler sweeps (perf)

v2.4.0 scoped each engine's scheduler sweeps to its own `workflowId`, adding a
leading `workflowId` equality term to the keyset-paginated pickup queries
(`getReadyForRetry` / `getReadyToResume` / `getChildWaitingRuns` /
`getStaleRunningWorkflows` / `scheduledReady`). v2.4.0 added `workflowId`-prefixed
indexes for the *non*-keyset pickup queries but **missed the keyset ones** — so
those sweeps filtered `{ status, paused, workflowId }` / sorted `updatedAt` with
no matching schema-declared index. MongoKit logged a "no matching compound index"
warning on **every poll tick** and MongoDB fell back to a wider scan.

Added `WorkflowRunSchema.index({ status: 1, paused: 1, workflowId: 1, updatedAt: 1, _id: 1 })`
— the exact index MongoKit's keyset detector asks for. Purely additive; no query
or behavior change.

## [2.4.0] - 2026-06-01 — Durable saga · crash-recovery fix · output history · parallel/join · idempotency keys

A capability release that makes streamline best-in-class for agentic, order, and
distributed workflows — while staying a **neutral durable-execution substrate**
(no AI/LLM/streaming; that layer is `@classytic/arc-ai`, which composes on top of
this engine via `./integrations/streamline`). All changes are **additive /
semver-minor**; default behavior for existing workflows is byte-for-byte unchanged
(proven by the full e2e suite passing untouched). See the two type-level notes
under *Migration*.

### Fixed — childWorkflow / untimed-wait crash-recovery (data-loss bug)

A run suspended on `ctx.startChildWorkflow()` was woken to completion **only** by
in-memory event-bus listeners. After a process crash those listeners were gone,
and no scheduler poll class reclaimed the parent (`status:'waiting'`, no
`resumeAt`, not `running`) — it dead-waited forever. v2.4 adds a durable
reconciliation poll (`CommonQueries.childWaiting` → `getChildWaitingRuns` →
scheduler branch) plus reconcile-on-re-entry: a reclaimed parent re-reads the
child's persisted status and resumes (or re-arms) instead of no-oping. Same spine
now also backs the new `branchJoin` waits.

### Added — durable saga compensation

`failed → compensating → compensated | compensation_failed` as a first-class,
crash-recoverable phase. `onCompensate` handlers roll back completed steps in
reverse order, derived from freshly-read persisted state; the `failed→compensating`
transition is an `assertAndClaim` (multi-worker entry resolves to one winner);
per-step `pending→done` memoization via a numeric-index guarded CAS makes
recovery skip already-compensated steps (effectively-once within the cluster). A
real heartbeat runs for the rollback's duration so the stale-sweeper can't
race-kill it. Proven by an 11-scenario matrix (`test/integration/saga-compensation.test.ts`).
**Exactly-once boundary (honest):** for external side effects use
`ctx.idempotencyKey('compensate')` — the engine provides effectively-once via a
stable key, not transactional exactly-once against third-party APIs.

### Added — `ctx.idempotencyKey(scope?)`

Deterministic, **attempt-invariant** key (`${runId}:${stepId}[:${scope}]`) for
effectively-once external calls. Stable across retries and crash recovery by
design (never folds in `attempt`), so a re-issued call dedupes at the provider.

### Added — per-step versioned output history (opt-in)

`Step.outputHistory: { keep }` keeps the last N outputs of a step in a bounded
ring buffer, captured on the rerun/rewind transition. Read via
`ctx.outputHistory(stepId?)`; restore a prior generation via
`ctx.pinOutput(version, stepId?)`. `keep` 0/undefined ⇒ disabled ⇒ no schema
growth, byte-for-byte v2.3.4.

### Added — declarative parallel steps + durable join

`ctx.joinBranches(branches, { policy })` fans out child-workflow branches that run
concurrently and join durably, with policies `all | any | race | allSettled`.
Each branch is a real run with its own retry/timeout/compensation; the join is a
crash-recoverable `branchJoin` wait (reuses the reconciliation spine above).
Under `policy:'all'`, a branch failure fails the step and triggers saga
compensation of completed work. Gated entirely behind branch-presence — the
linear step graph (`getNextStep`) is untouched.

### Changed — storage deepening on mongokit

`WorkflowDefinitionRepository` now extends mongokit `Repository` (the old
plain-object export remains as a deprecated delegating shim). Dropped the dead,
never-executed serialized `condition` field from the definition model (no
eval-of-data — explicit non-goal). Added an `assertWriteConcern` regression test
guarding `{ w:'majority', j:true }` on the run + concurrency-counter models.

### Internal — engine.ts de-bloated

Extracted cohesive subsystems out of the 2076-line god-class into focused modules
(`saga.ts`, `child-workflow.ts`, `parallel-steps.ts`, `registries.ts`); engine.ts
is the thin orchestrator. No public API or behavior change.

### Hardened — distributed correctness (adversarial-review fixes)

- **Cross-workflow scheduler isolation (was a critical bug).** Each engine's
  scheduler previously polled the *global* run pool and could claim + mis-execute
  another workflow's run. Pickup queries are now scoped by the engine's
  `workflowId` (+ a routing guard at the claim/execute paths). Regression test
  registers two distinct workflows and proves isolation.
- **`resume` is now a true waiting-step CAS** — the durable write is guarded on
  the step still being `waiting`, so two concurrent resumes can't both advance it.
- **`ctx.scatter()` no longer drops early task failures** — failures are
  accumulated independently of the concurrency-gating set; a failed task reliably
  throws instead of returning partial success.
- **`stepLogs` is ring-buffer capped** (`maxStepLogs`, default 1000) — prevents
  unbounded `$push` growth toward the 16 MB BSON limit.
- **`WorkflowConcurrencyCounterRepository.reconcile(workflowId, concurrencyKey?)`**
  implemented — recounts true slot-holding runs and repairs leaked strict-mode
  counters (was documented but missing).
- **`scheduler.inMemoryTimers` opt-out** — set `false` to rely purely on DB
  polling for resumes (bounded timers for high-scale deployments). Default `true`.
- **Strict-concurrency cold-bucket under-admission (was misdiagnosed as a flaky
  test).** `claimSlot` treated *any* E11000 as "at limit"; on a cold bucket a
  concurrent racer collided on the just-inserted counter doc and was wrongly
  rejected though `count < limit`. Now the duplicate-key branch retries a
  non-upsert guarded increment before deciding the bucket is full.
- **Idempotency lookup now matches the partial-unique index.** `findActiveByIdempotencyKey`
  used `$nin:['done','failed','cancelled']`, which wrongly treated settled saga
  runs (`compensated`/`compensation_failed`) as active — so `start({idempotencyKey})`
  could return an old settled run. Switched to the active allowlist
  `['draft','running','waiting','compensating']`.
- **`shutdown()` now tears down the 5 slot-release bus listeners.** They were
  registered once in the constructor and never removed; recreating an engine for
  the same `workflowId` on a shared bus left the old listener live, double-releasing
  a new run's slot.
- **childWorkflow first-entry double-spawn fixed** — the child is now started with
  a deterministic idempotency key (mirrors branchJoin), so a crash before the
  `childRunId` write can't spawn the child twice.
- **childWorkflow/branchJoin wedge-forever fixed** — `handleWait` stamps an initial
  `nextReconcileAt`, so the reclaim sweep can recover a wait even if the process
  crashed before the handler ran.
- **`workflow:completed` now persists-before-emit**; saga slot released only at a
  compensation-terminal state (held through rollback), idempotent per run;
  `compensating` counted in the best-effort active cap; `recoverStale` uses
  `$unset` (not the driver-dropped `$set: undefined`) to clear `startedAt`.

### Packaging (publish blockers cleared)

- `@classytic/{mongokit,primitives,repo-core}` moved to **peerDependencies only**
  (removed from `dependencies`) — a dual declaration risked a duplicate nested
  copy and split `Repository`/`HttpError` class identity across the host boundary.
- `WorkflowConcurrencyCounterRepository` + `workflowConcurrencyCounterRepository`
  + `makeCounterId` + `WorkflowConcurrencyCounter` are now exported from the package
  entry, so the documented `reconcile()` drift-recovery primitive is reachable.
- Added `.gitattributes` (`* text=auto eol=lf`) to prevent CRLF diff churn.

### Testing tiers

The suite is split into three vitest projects: **dev loop** `npm test` (unit +
integration, fast), **before publish** `npm run test:all` (unit + integration +
long — what `prepublishOnly` runs), and **nightly / slow CI** `npm run test:long`
(long-running scenarios only). New v2.4 regression coverage: saga compensation
(11 scenarios), parallel/join, multi-workflow isolation, output-history,
strict-concurrency fixes, childWorkflow correctness (incl. terminal-child adopt).

### Known limitations / operating guidance

streamline is multi-worker-capable and durable on a single cluster, but it is
**not** "Temporal-grade distributed by default" (no worker-lease protocol, no
sharded task queue, BYO Redis/Kafka signal store + monitoring, inline payloads
bounded only for logs/output-history). See
[`docs/DISTRIBUTED-READINESS.md`](docs/DISTRIBUTED-READINESS.md) for the full
limitations + how to operate around each at scale.

### Migration (two type-level notes — no runtime migration)

- **`RunStatus` gains `'compensating' | 'compensated' | 'compensation_failed'`**
  and **`WaitingFor.type` gains `'branchJoin'`**. Additive at runtime (never
  emitted unless you use compensation / `joinBranches`), but a downstream
  exhaustive `switch (status)` with a `never`-default will stop compiling until it
  handles the new literals.
- **Idempotency partial-unique index** now includes `'compensating'` in its active
  set (a compensating run still blocks duplicate keys); terminal compensation
  states are excluded so keys remain reusable. Index rebuilds automatically.

## [2.3.4] - 2026-05-24 — `Workflow.bindFailureTo` + peer dep floor bumps

### Added — `Workflow.bindFailureTo({ model, key, field, value, errorField? })`

Subscribe a workflow to its parent doc once at registration and have failures
auto-patch the parent's status field — replaces the hand-rolled
`subscribe('workflow:failed') → match by workflow id → look up parent → patch`
boilerplate hosts otherwise repeat once per workflow. Returns an `off()`
unsubscribe for graceful shutdown.

```ts
const off = renderVideo.bindFailureTo({
  model: VideoJobModel,
  key: 'videoJobId',        // read from run.input.videoJobId
  field: 'status',
  value: 'failed',
  errorField: 'errorMessage',
});
```

Lock-in: `test/integration/bind-failure-to.test.ts`.

### Changed — peer dep floors

- `@classytic/mongokit` `>=3.13.0` → `>=3.14.0` (compliance-grade `purgeByField`).
- `@classytic/primitives` `>=0.4.0` → `>=0.6.0` (`phone`, `status-history`,
  `condition`, `mixin`, `sla-policy` primitives + cleaner shape for
  `BankTransaction` / `Money`).
- `@classytic/repo-core` `>=0.4.0` → `>=0.5.0` (`PurgePort` + `runChunkedPurge`).

Floor-only — no API breaks. Hosts already on these peer-dep ranges pick up
2.3.4 transparently.

## [2.3.3] - 2026-05-10 — dead-letter cap · in-flight version pinning · migrateRun

> **Why this release.** Two production gaps the 2.3.2 retention block left
> open: (1) a wedged run that crashes-recovers-crashes-recovers forever
> still wedged the scheduler, because the sweep kept terminating it with
> `stale_heartbeat` and the engine kept recovering it; (2) deploying a new
> workflow version while v1 runs were still in-flight either failed them
> with `VERSION_MISMATCH` or required the host to manually keep both
> engines registered without any framework support. Both close in this
> release without breaking 2.3.2's API surface.

### 🚀 New — dead-letter cap

- **`RetentionOptions.maxStaleRecoveries`** (default 5) — bound on how
  many times the recovery + sweep paths may touch a single run. Once
  exceeded, the next sweep cycle calls
  `repository.markAsDeadLettered(...)` (atomic CAS), marks the run
  `failed` with `error.code === 'dead_lettered'`, and emits
  `workflow:failed` with that distinct code. The crash-recover-crash-recover
  loop now terminates after a bounded number of attempts.
- **`WorkflowRun.recoveryAttempts: number`** — incremented atomically by
  both `engine.recoverStale()` (`$inc: { recoveryAttempts: 1 }` inside
  the `claim()` patch) and `repository.markStaleAsFailed()`. Hosts can
  build "stuck runs" dashboards off this field directly without
  re-deriving from logs.
- **`repository.markAsDeadLettered(runId, attempts, max)`** — typed CAS
  method, returned `boolean` for "did we win the race." Plugin pipeline
  fires (audit / cache invalidation / observability) — the dead-letter
  transition is observable like any other.

### 🚀 New — in-flight version pinning

- **`WorkflowRun.definitionVersion: string`** — every run snapshots its
  starting definition's `version` at create-time
  (`WorkflowRegistry.createRun`). Required for safe rolling deploys.
- **`workflowRegistry.lookupVersion(workflowId, version)`** — returns
  the engine pinned to a specific `(workflowId, version)`. Populated
  automatically when each `createWorkflow` registers; coexists with the
  existing single-engine-per-workflowId map for back-compat.
- **Engine routing on resume** — `engine.execute(runId)` checks the run's
  `definitionVersion` against its own. When they differ AND a pinned
  engine is registered, it delegates execution to the pinned engine. The
  host can run two engine versions in the same process during a rolling
  deploy without `VERSION_MISMATCH` failures.
- **`WorkflowConfig.migrateRun(run) → Partial<WorkflowRun> | null`** —
  optional migration hook called when the pinned engine isn't available.
  Returns a partial run shape (remapped `currentStepId`, backfilled
  `context`, rewritten `steps[]`); the engine merges + re-pins the run
  to its own version, then continues. Returning `null` falls through
  (engine fails the run with `VERSION_MISMATCH`, same pre-2.3.3
  behaviour).

### 📋 Migration

- **No breaking changes.** Runs created before 2.3.3 have no
  `definitionVersion` and `recoveryAttempts: undefined`; both code paths
  treat that as the "back-compat" case. The new fields are added to the
  Mongoose schema with safe defaults so existing collections don't need
  a migration.
- **Hosts that already wire `recoverStale` callbacks** — no change. The
  `$inc: { recoveryAttempts: 1 }` is added inside `engine.recoverStale`
  itself, so hosts using the engine's own recovery path get the counter
  bumped automatically.
- **Hosts using `WorkflowDefinitionModel`** — unrelated; the doc-store
  is untouched. The version pinning above keys off the in-process
  `workflowRegistry`, not the persisted definition.

## [2.3.2] - 2026-05-10 — retention block: TTL · tenant compounds · stale-run sweeper

> **Why this release.** Three operational gaps that the host had to wire by
> hand on every fresh deploy — a TTL on terminal runs, the tenant-prefixed
> compound multi-tenant deployments need, and a give-up sweeper for runs
> whose worker crashed and never came back. All three are now first-class
> on `createContainer({ retention })`. The package previously documented
> the patterns in code comments + README snippets and trusted the host to
> remember them; this release moves them into the container surface so
> "forgot to add the index" stops being a footgun.

### 🚀 New — `ContainerOptions.retention`

- **`retention.terminalRunsTtlSeconds`** — TTL on terminal runs
  (`done` / `failed` / `cancelled`). Index spec is
  `{endedAt:1}` with `partialFilterExpression: {endedAt:{$exists:true},
  status:{$in:[done,failed,cancelled]}}` so fresh `running` runs aren't in
  the index at all (no TTL eligibility). `container.syncRetentionIndexes()`
  is idempotent on repeat calls and drops + recreates when the TTL value
  changes (closes `IndexOptionsConflict`).
- **`retention.multiTenantIndexes`** (default: `true` when the repository
  is multi-tenant) — auto-builds `{<tenantField>:1, workflowId:1,
  createdAt:-1}`. PACKAGE_RULES §33 (scope-field prefix on compound
  indexes) made literal — without this index, every org-scoped list
  fanned out across every tenant's runs.
- **`retention.staleHeartbeatThresholdMs`** — setting this AUTO-STARTS
  `StaleRunSweeper`. Self-rescheduling `setTimeout` (no overlap),
  `unref()`'d so it never blocks process exit. Sweeper terminates each
  stale run via the new repository CAS `markStaleAsFailed()` and emits
  `workflow:failed` with `error.code === 'stale_heartbeat'`.
- **`retention.staleRunAction`** (`'fail'` | `'cancel'`, default `'fail'`)
  — pick the terminal status the sweeper writes.
- **`retention.staleRunSweepIntervalMs`** (default 60_000) and
  **`retention.staleRunBatchSize`** (default 100) — cap sweep frequency
  and per-cycle Mongo round-trips.

### 🚀 New — `WorkflowRunRepository.markStaleAsFailed()`

Atomic give-up CAS via mongokit's `claim()`. Distinct from
`engine.recoverStale()` (re-execute from last heartbeat) — this terminates.
Routes through the standard plugin pipeline, so audit / cache invalidation
/ observability all fire on each terminator. Returns `false` when another
writer (e.g. recovery) won the race; the caller treats it as "not my
problem anymore," not as an error. Run both paths with different
thresholds (recover at 5 min, terminate at 30 min) and the longer
threshold acts as a backstop.

### 🚀 New — exports

- `RetentionOptions`, `RETENTION_DEFAULTS`, `resolveSweeperConfig`,
  `StaleRunSweeper`, `syncRetentionIndexes` from package root.
- `StreamlineContainer.syncRetentionIndexes()` and
  `StreamlineContainer.dispose()` — call the first from a deploy script
  after `mongoose.connect`, the second on graceful shutdown (optional —
  timer is `unref()`'d).
- `WorkflowRunRepository.isMultiTenant` (was `private`) — promoted to
  `public readonly` so retention helpers can decide whether to build
  the tenant compound without rerouting through the original config.

### 📋 Migration

- **Existing hosts with hand-rolled `syncStreamlineIndexes()`** — replace
  with `container.syncRetentionIndexes()`. Same indexes, slightly different
  names (prefixed `streamline_`); on first run the new helper coexists
  with the old hand-built ones until you drop them. Pre-existing
  `terminal_runs_ttl` / `org_workflow_recent` indexes can stay or be
  dropped — they're functionally redundant once the package-managed ones
  exist.
- **No breaking changes.** `createContainer()` with no `retention` block
  behaves identically to 2.3.1 — sweeper not started, no indexes built,
  `dispose()` is a no-op.

## [2.3.0] - 2026-05-02 — start-rate gates · strict concurrency · HttpError · mongokit 3.13 / repo-core 0.4 alignment · security + correctness hardening

> **Why this release.** Three gaps closed at once: (1) start-rate gates
> (debounce / throttle / strict concurrency) for callers that can't afford to
> overload downstream APIs; (2) tenant + race-safety closure across every
> persistence path the engine touches (idempotency, scheduler probes,
> debounce bumps, child-workflow events); (3) source-of-truth alignment with
> `@classytic/repo-core` 0.4 + `@classytic/primitives` so a host installing
> `arc + mongokit + repo-core + primitives + streamline` shares one set of
> contracts — no dedup-induced drift.

### ⚠️ Breaking — requires action

1. **Peer dep bump:** `@classytic/mongokit` `>=3.11` → `>=3.13.0`.
   `@classytic/repo-core` `>=0.4.0` is now a direct peer dep (was reached
   through mongokit). Hosts must install repo-core in the same `node_modules`
   so all packages share the same instance.
2. **Webhook security — fail-closed token validation.** `resumeHook()` now
   rejects when `ctx.wait` was called without `{ hookToken: hook.token }`
   stored. Pre-fix any token starting with a valid runId would resume the
   workflow (the README example was the canonical misuse). Workflows using
   `createHook` MUST update `ctx.wait('reason', { hookToken: hook.token })`.
3. **Idempotency unique partial index** on `{ idempotencyKey: 1 }` filtered
   to non-terminal statuses. Existing deployments with duplicate active
   `idempotencyKey` values (possible under the pre-fix race) MUST run the
   pre-deploy migration script in [`run.model.ts:142`](./src/storage/run.model.ts)
   to terminate duplicates before deploying — Mongo refuses to build the
   index otherwise.
4. **`WorkflowError.code` shape change.** Now the hierarchical
   `'workflow.not_found'` form (HttpError-canonical). The legacy
   screaming-snake value lives on `err.legacyCode` for backwards compat.
   Consumers comparing `err.code === ErrorCode.X` must switch to either
   `err.legacyCode === ErrorCode.X` or `err.code === ErrorCodeHierarchical.X`.
   Three migration paths documented in the README error-handling section.

### 🚀 New — start-rate gates

- **`concurrency.throttle: { limit, windowMs }`** — best-effort smoothing.
  First `limit` starts per window per key fire immediately; excess starts
  queue as scheduled drafts spread across the window
  (`tail.executionTime + windowMs / limit`). Sequential bursts strictly
  smooth; parallel callers may collide on the same slot — this is documented
  in code + README + a contract test. Use for "don't overload an embedding
  API," NOT for "exactly N per window."
- **`concurrency.debounce: { windowMs }`** — trailing-edge collapse.
  Repeated starts within `windowMs` atomically push the pending draft's
  `executionTime` and overwrite `input` / `context` with the latest values.
  Lodash semantics. Tenant scope preserved on bumps.
- **`concurrency.strict: true`** — atomic per-bucket counter via
  `WorkflowConcurrencyCounterRepository`. Race-safe across parallel workers
  and processes. Rejects starts past the limit with
  `ConcurrencyLimitReachedError` (status 429). Use for payment captures,
  SLA-bound work, partner-API quotas. Requires `limit` + `key`. Drift
  recovery via the leaky-counter reconciliation pattern documented on the
  repo. Validation throws at `createWorkflow()` if misconfigured.
- **`config.trigger`** now accepts `tenantId` extractor /
  `staticTenantId` / `bypassTenant` so triggered workflows propagate tenant
  context end-to-end. Pre-fix triggered firings called `engine.start(data)`
  bare and bypassed both tenant scope AND every concurrency gate
  (debounce / throttle / limit). They now flow through the wrapped `start()`
  with the full gate stack. Trigger errors surface via `engine:error`
  instead of being silently swallowed.

### 🚀 New — repository surface (mongokit 3.13 alignment)

- **`Repository.claim()` migration.** Streamline's atomic state-transition
  CAS sites (scheduler claim, stale recovery, draft promotion, paused
  resume) now use `super.claim(id, { from, to, where? }, patch, options)`
  from mongokit 3.13. 6/21 atomic-write sites are claim — every true
  state-machine transition; the remaining 15 are non-CAS field updates that
  correctly stay on `findOneAndUpdate`. Full plugin chain (audit, cache,
  observability, multi-tenant) fires on every claim because `claim` is in
  `OP_REGISTRY` with `policyKey: 'query'`.
- **`MongoOperatorUpdate` typed update**. Streamline's local `MongoUpdate`
  type is now an alias to mongokit's exported `MongoOperatorUpdate` (typed
  operator keys + index signature). The historic
  `as unknown as Record<string, unknown>` cast is gone. Callers building
  typed update docs get full IntelliSense.

### 🚀 New — error contracts (repo-core alignment)

- **`WorkflowError implements HttpError`** from `@classytic/repo-core/errors`.
  Three new fields per error: `status: number`, hierarchical `code: string`,
  `meta: Record<string, unknown>`. Arc handlers and any HTTP-layer host
  auto-map to the canonical wire envelope without translation tables. New
  exports: `ErrorCodeHierarchical`, `ERROR_STATUS_MAP`. New error class:
  `ConcurrencyLimitReachedError` (429).

### 🛠 Tenant correctness — every persistence path now scoped

- **`StartOptions.tenantId` / `bypassTenant`** added; threaded through
  `engine.start` → `repository.create`, the idempotency lookup,
  `bumpDebounceDraft` (with explicit re-stamping of the tenant subpath
  when `context` is overwritten), and every throttle/concurrency probe
  (`countStartsInWindow`, `nextThrottleFireAt`, `oldestStartInWindow`,
  `countActiveByConcurrencyKey`).
- **Scheduler-side reads** (`getReadyToResume`, `getReadyForRetry`,
  `getStaleRunningWorkflows`, `getScheduledWorkflowsReadyToExecute`,
  `getConcurrencyDrafts`, `hasConcurrencyDrafts`, `countRunning`,
  `hasWaitingWorkflows`, `countConcurrencyDrafts`) now accept
  `AtomicUpdateOptions`. Scheduler/engine sweep callers pass
  `{ bypassTenant: true }` since one scheduler serves every tenant.
- **`tenantFilterPlugin`** now hooks `before:claim`, `before:findOneAndUpdate`,
  `before:getOne`, `before:findAll`, `before:count`, `before:exists` —
  closes the silent-gap bug class on cross-cutting plugin hook coverage.

### 🛡 Security + correctness fixes

- **Webhook token fail-closed validation** (see breaking changes).
- **Idempotency race-safety** via partial unique index (see breaking
  changes). `repository.create()` catches E11000 and returns the winning run.
- **Child workflow cross-container events.** Parent now subscribes to BOTH
  its own and the child engine's container event bus when they differ
  (deduped via `resumed` flag). Pre-fix the parent listened only on its own
  bus and missed cross-container completion events.
- **Heartbeat backpressure** unchanged from 2.2 — but the new strict-concurrency
  counter release listener is registered on every engine for free.

### 📦 Source-of-truth alignment

| Type / shape | Source of truth | Was |
|---|---|---|
| `OffsetPaginationResult` / `KeysetPaginationResult` | `@classytic/repo-core/pagination` | Hand-rolled local interface |
| `MongoOperatorUpdate` | `@classytic/mongokit` | Hand-rolled local `MongoUpdate` |
| `HttpError` | `@classytic/repo-core/errors` | Custom `WorkflowError` shape with no `status` |
| `EventTransport` / `DomainEvent` / `OperationContext` | `@classytic/primitives/events` + `@classytic/primitives/context` | Already aligned in 2.2; documented for completeness |

### 🧪 Tests added

- **`test/integration/throttle-debounce-scenarios.test.ts`** — 11 scenarios
  pinning the throttle staggering (deep-burst), debounce trailing-edge
  collapse, key isolation, tenant propagation in strict mode, and the
  cross-tenant scheduler probe bypass.
- **`test/integration/strict-concurrency-scenarios.test.ts`** — 10 scenarios
  pinning admit/reject behavior, counter lifecycle (completed / failed /
  cancelled), `releaseSlot` idempotency, parallel race safety, and config
  validation.
- **`test/integration/contract-scenarios.test.ts`** — 11 scenarios pinning
  webhook token fail-closed (3 tests including attacker-guess case),
  abort/timeout honest contract (engine delivers + releases, can't kill
  unaware handler), child-workflow cross-container completion, concurrency
  best-effort vs strict contract, trigger-event tenant propagation
  (extractor + static).
- **`test/unit/errors.test.ts`** — 23 tests covering `HttpError` conformance
  on every error subclass via `it.each` matrix, hierarchical-code parity,
  `ERROR_STATUS_MAP` validation, legacy-field preservation.

- **`test/integration/state-machine-cursor-scenarios.test.ts`** — 9
  scenarios pinning `RUN_MACHINE` / `STEP_MACHINE` transition tables,
  the deliberate `isTerminalState`-vs-`RUN_MACHINE.isTerminal` semantic
  divergence (caught a regression mid-implementation), and
  `cursorStaleRunning` streaming behavior (yields one-at-a-time, respects
  consumer break, excludes paused runs).

Total test count: **298 passing** (was 254 — 44 added).

### 🚀 New — internal upgrades (best-practice adoption)

- **`defineStateMachine()` from `@classytic/primitives/state-machine`** for
  workflow-run + step status. Replaces `core/status.ts`'s previously-dead
  `isValidStepTransition` / `isValidRunTransition` validators with live
  `RUN_MACHINE` and `STEP_MACHINE` instances. Engine's atomic claim sites
  use `assertAndClaim(RUN_MACHINE, repo, runId, { from, to, ... })` —
  pairs sync `assertTransition` (catches programmer bugs as
  `IllegalTransitionError` before the round-trip) with the existing
  Mongo CAS (catches concurrent writers via `null`). Two layers, both
  load-bearing. The legacy validator functions stay as `@deprecated`
  back-compat shims.
- **`cursor()` for stale-workflow scanner.** New
  `WorkflowRunRepository.cursorStaleRunning()` streams stale runs one at
  a time via mongokit's `cursor()` instead of buffering the full page.
  Lower memory peak when cluster crashes leave thousands of stale runs;
  same wire cost since the consumer breaks at the per-poll budget.

### 🚫 Deliberately not done (recorded so future maintainers don't relitigate)

- **`useMiddleware()` for tenant-filter plugin.** Mongokit's own CLAUDE.md
  rules this out: *"Don't use middleware for security policy (tenant scope,
  soft-delete filtering, audit). Policy hooks fire BEFORE middleware sees
  the op, so middleware can never wrap a policy failure. Use `before:*`
  hooks for policy, `useMiddleware()` for ergonomics."* The 13 hook
  registrations stay; the rationale is now locked in as a docstring on the
  plugin so this doesn't get relitigated. **Note:** `isTerminalState()`
  intentionally has a different definition than `RUN_MACHINE.isTerminal()`
  — the helper carries the streamline domain semantic
  (done/failed/cancelled), the machine the structural one (only cancelled,
  since done/failed allow rewind). Both coexist by design.

### 📦 Migration

```diff
- "@classytic/mongokit": ">=3.11"
+ "@classytic/mongokit": ">=3.13.0"
+ "@classytic/repo-core": ">=0.4.0"
```

```ts
// Webhook security — REQUIRED migration:
- await ctx.wait('Awaiting approval');
+ await ctx.wait('Awaiting approval', { hookToken: hook.token });

// Error code comparison — pick one:
- if (err.code === ErrorCode.WORKFLOW_NOT_FOUND) { ... }
+ if (err.legacyCode === ErrorCode.WORKFLOW_NOT_FOUND) { ... }     // legacy
+ if (err.code === ErrorCodeHierarchical.WORKFLOW_NOT_FOUND) { ... } // canonical
+ if (err.status === 404) { ... }                                   // HttpError
```

```js
// Idempotency duplicates pre-deploy migration (run ONCE before rolling out 2.3):
db.workflow_runs.aggregate([
  { $match: { idempotencyKey: { $type: 'string' },
              status: { $in: ['draft', 'running', 'waiting'] }}},
  { $group: { _id: '$idempotencyKey', ids: { $push: '$_id' }, n: { $sum: 1 }}},
  { $match: { n: { $gt: 1 }}},
]);
// For each duplicate group: cancel all but the oldest. See run.model.ts:142.
```

---

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

