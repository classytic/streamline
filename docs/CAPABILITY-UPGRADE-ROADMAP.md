I have all the material I need; this is a synthesis task. No code exploration required — the eight designs and their adversarial verdicts are fully specified. Writing the roadmap directly.

# Streamline v2.3.4 → Best-in-Class Durable Workflow Engine — Implementation Roadmap

## 1. TL;DR

- **Checkpoint-resume, not deterministic replay.** Every upgrade below leans on streamline's existing DBOS/Restate-style model (per-step `output` checkpoint + version-pinned `definitionVersion` + `claim()` CAS). No design introduces an event-replay determinism tax — correct call for agentic/LLM workloads.
- **The single highest-leverage fix is not a new feature — it's closing the childWorkflow crash-recovery hole.** Three separate designs (`dag-parallel`, `agentic`, `distributed-scale`) independently discovered that a run parked on `waitingFor.type === 'childWorkflow'` is selected by **no scheduler poll class** and is woken **only by an in-process bus listener that dies on crash**. This is a pre-existing latent bug; it must be fixed first because three features sit on top of it.
- **Two designs are genuinely safe and additive today:** per-step output history (`output-history`) and the mongokit storage deepening (`mongokit-refactor`) — both small, both philosophy-clean, both fixable in a week.
- **Saga durability (`order-saga`) is the most valuable correctness upgrade** — streamline ships a saga surface that violates its own durability contract (compensation runs off the state machine, post-cleanup, with no recovery). Fixing it makes Area 3 best-in-class.
- **After this lands, streamline is best-in-class on Areas 1–3** (agentic dynamic graphs, general workflows, transactional sagas) and **honestly-bounded on Area 4** (per-partition ordering, effectively-once, poll-augmented-by-push) — the real Mongo ceiling, stated not papered over.

---

## 2. Build now (safe, additive, high-value)

> No design in the set was rated `sound/build-now` outright — all eight came back `needs-fixes` or `build-after-fixes`. **However, two have only mechanical/scoped fixes (no architecture rewrite, no philosophy risk) and should be treated as "build now after a 1–2 day fix pass."** They are the safe foundation.

### 2.1 — `mongokit-refactor` (storage deepening) — **DO THIS FIRST**
The refactor is ~85% already shipped; remaining work is small and de-risks every later storage change.

- **Public API:** `class WorkflowDefinitionRepository extends Repository<WorkflowDefinitionDoc>` (new barrel export); existing plain-object `workflowDefinitionRepository` stays as a deprecated delegating re-export. New optional `createContainer({ retention: { singletonLock?: LockAdapter } })`. Internal `assertWriteConcern(WorkflowRunModel)` test export. **No** signature change to `WorkflowRunRepository`, `StepContext`, `createWorkflow`, or any `ctx.*`.
- **mongokit leverage:** Already-adopted `Repository.claim()` (null-on-miss CAS), `cursor()` keyset streaming, `methodRegistryPlugin`+`mongoOperationsPlugin`+`tenantFilterPlugin`. New: `WorkflowDefinitionRepository` + `timestampPlugin`; optional `createMongoLockAdapter` for the stale-sweep singleton. Concurrency-counter **stays hand-rolled** (`incrementIfBelow` has no upsert/`$setOnInsert` bootstrap). Per-step `steps[]` writes **stay on guarded `updateOne`** (`claim()` keys a single top-level stateField — cannot express `steps.$.status`).
- **semver:** minor-additive **only if** the `pre('save')` semver hook is retained (see fix below); otherwise it is a hidden major break.
- **First step:** Add the `assertWriteConcern` regression test on `WorkflowRunModel` **and** `concurrency-counter.model` — this is the tripwire protecting `{w:'majority',j:true}` for all later work. Do it before touching anything else.

### 2.2 — `output-history` (per-step versioned output ring buffer)
- **Public API:** new optional `StepState.outputHistory?: StepOutputVersion[]` + `pinnedVersion?: number` (new fields, **never** the `output` slot — invariant #9); `Step.outputHistory?: { keep: number }` (0/undefined = disabled = byte-for-byte v2.3.4); `ctx.outputHistory(stepId?)` (pure read), `ctx.pinOutput(version, stepId?)` (durable copy-back); `WorkflowRunRepository.restoreStepOutput(...)`; barrel `export type { StepOutputVersion }`.
- **mongokit leverage:** `$push` + `$slice:-keep` ring buffer through `repo.updateOne → super.findOneAndUpdate` (inherits schema write concern); `restoreStepOutput` via `claim()` with `CANCELLED_GUARD`. Correctly avoids pagination/lease/`incrementIfBelow`.
- **semver:** minor-additive (new optional fields default-absent, no migration, read by `_id`).
- **First step:** Re-anchor the capture trigger — push a history version on the **rerun/rewind transition** (a previously-`done` step re-succeeds), **not** "a prior output happens to occupy the slot at success." Snapshot the prior committed output in `updateStepState` *before* `applyStepUpdates`. (See §3 for the full fix list — this design is `build-after-fixes`, not pristine, but the fixes are mechanical.)

---

## 3. Build after fixes

All four below are `recommendation: build-after-fixes` — good designs, real correctness holes, no philosophy blocker. Listed by leverage.

### 3.1 — `order-saga` (durable saga / compensation + `ctx.idempotencyKey`) — highest correctness value
Required fixes (verifier-mandated):
1. **Drop `attempt` from `ctx.idempotencyKey`.** Make it `${runId}:${stepId}[:scope]` — stable across retries. Including `attempt` causes the exact double-charge the feature exists to prevent.
2. Replace the illegal `claim(field:'steps.$[i]...')` with **numeric-index CAS via `repo.updateOne`**: `{_id, status:'compensating', 'steps.${i}.compensation.status':'pending'} → $set 'done'` (mongokit `claim()` does not forward arrayFilters).
3. **Move compensation into a state-machine-driven `compensating` phase inside the run loop**, and reorder `engine.ts:702-711` so `cleanupEventListeners`/`hookRegistry.unregister` fire only on `compensated`/`compensation_failed`/`cancelled`. Make `failed→compensating` `assertAndClaim` the first durable action (multi-worker entry race).
4. **Give the compensation phase a real heartbeat** (AbortController + `executeWithTimeout` interval) or the StaleRunSweeper `markStaleAsFailed`-races mid-compensation.
5. Re-derive the reverse-ordered completed-step list from **freshly-read persisted StepState** on both inline and recovery paths; define semantics for `waiting`/`running` and goto-looped steps.
6. Document the exactly-once boundary honestly (memoization = same-cluster only; external = effective-once via the fixed key).
7. Call out the `RunStatus` union extension as a **type-level break** for exhaustive switches; confirm partial-unique idempotency index treatment of the 3 new statuses.
8. Enforce at define-time that `onCompensate` handlers do not call suspending primitives (`throw` in `define.ts`).

### 3.2 — `output-history` (also build-after-fixes)
Required fixes: re-anchor capture to the rerun transition (above); gate the push to exclude `__checkpoint` sentinels and stale intermediates; add an attempt/generation idempotency guard on the push; fix `applyStepUpdates` to replicate `$push`+`$slice:-keep` in-memory; implement `preserveHistory` **without** widening `rewindRun`'s full-doc spread (fix `rewindTo`'s narrow-`$set` violation of invariant #8 regardless); decide/document restore-on-terminal policy (forbid, or define TTL/`endedAt` interaction); document the `buildStepUpdateOps` internal-contract change (now emits `$push`).

### 3.3 — `dag-parallel` (declarative parallel + durable join) — **blocked on the childWorkflow recovery fix**
Required fixes:
1. **BLOCKER (shared with agentic): add the durable reconciliation path.** New `CommonQueries` entry (`status:'waiting'` + `waitingFor.type:'branchJoin'` + `nextReconcileAt<=now`) + `getReadyBranchJoins` repo method + a `smart-scheduler.poll()` branch that re-reads ALL child statuses synchronously (status re-read = correctness path, bus listener = optimization). This also fixes the pre-existing `childWorkflow` latent bug.
2. Make child start idempotent inside `handleWaitingState`: synthesize `idempotencyKey = ${parentRunId}:${parentStepId}:${branchKey}` and pass to `childEngine.start(...)` (engine issues the start — not a caller contract).
3. Stamp a durable parent back-pointer on each child + publish child completion to `signalStore` (cross-process).
4. Implement parent-cancel child-tree-walk (tolerant of already-terminal).
5. Reserve a collision-proof namespaced resume sentinel (not bare `__branchJoin`).
6. Confirm quorum-eval loser strictly discards on null-claim.
7. 4 completion policies as **pure status math** (closed enum), never serialized predicates.
8. Forward-compat migration note: mixed-version fleet — gate rollout so all workers understand `branchJoin` before any such run is created.
9. Register/teardown listeners on all three event prefixes.

### 3.4 — `agentic` (injectSteps, durable loop, spawnAgents, gates, stream)
Required fixes:
1. **BLOCKER: same durable resume path as 3.3** for `childWorkflow`/`gate` waits — `CommonQueries.readyChildWorkflows` + index + scheduler branch. Ship **before** `spawnAgents`.
2. Fix `resolveGate` CAS: `where:{'steps.waitingFor.data.gateId': gateId}` (multikey/`$elemMatch`), **not** `steps.$[]`; globally-unique `gateId`; assert resolved step is the run's waiting step; declare the sparse/partial gate index as a deploy-time migration.
3. **Specify the FULL graph-model migration**, not just `moveToNextStep`: every site deriving a step index from `registry.definition.steps` must switch to run-aware indexing against `run.steps` — specifically `handleGoto`'s `targetIndex` (`executor.ts:765`) and `rewindRun`. Regression test goto+injectSteps writes the correct slot; prove version-pinning/`migrateRun` unaffected.
4. injectSteps idempotency: single atomic `updateOne` with `{_id, CANCELLED_GUARD, 'steps.stepId':{$ne:stepId}}` + `$push` (not `$addToSet` on objects).
5. Enforce loop heartbeats automatically (`ctx.heartbeat()` after each iteration's checkpoint).
6. spawnAgents cancel-propagation via claim-guarded per-child cancel.
7. Document loop = effectively-once per iteration (require caller idempotency keys); `ctx.stream` = at-most-once, unordered, no replay, side-effect-free on run state.
8. Philosophy guard test: `dynamicHandlers` are in-code `StepHandler`s only; engine never reads the dead `condition: String`; `StepNotFoundError` on unknown `handlerKey`.

> **Delivery order within agentic:** `gate` + `stream` first (low blast radius), then `loop`, then `injectSteps` last (it reinterprets the core `getNextStep` seam).

---

## 4. Design-only / needs sign-off

### 4.1 — `rerun-node` (isolated single-node re-run + deps DAG)
**Recommendation: `design-only-needs-signoff`.** The engine-level `deps` rerun is only correct for the **`StepState.output`-only subset** — the idiomatic output channel is `ctx.set → run.context`, which selective invalidation does **not** revert (P0 dataflow unsoundness). It also wedges on the linear forward-walk over `done` non-dependents (P0), and conflicts with goto-loop dataflow.

**Open question for sign-off:** *Do we ship engine-level `deps`-based rerun at all, or make **child-workflow-per-unit the SOLE supported isolation primitive**?* The verifier's recommended fix is the latter for any `ctx.set`-using workflow. For Prism specifically (shots in a storyboard, order-lines), child-workflow-per-unit is strictly better — each shot is already a natural sub-run, true isolation is free, zero shared-context under-invalidation risk, **zero engine change**. **Recommendation: adopt child-workflow-per-unit as the documented host pattern; defer/reject in-graph `deps` rerun** unless a concrete single-run-shared-context need appears. (Note: the design's claim that `RUN_MACHINE`/`STEP_MACHINE` transitions must be added is **wrong** — `done|failed→running` and `done|failed→pending` already exist.)

### 4.2 — `workflow-as-data` (named-handler registry hydration)
**Recommendation: `build-after-fixes` but philosophy-sensitive → sign-off the SCOPE.** Hydrating `WorkflowDefinitionDoc` into a runnable workflow by **selecting** pre-registered handlers/predicates by name is philosophy-clean. The hard-reject of the serialized `condition: String` field is correct and mandatory.

**Open questions for sign-off:**
- *Ship the minimal slice (handler + predicate + compensation name selection + retries/timeout/order) and **drop the `inputs` I/O-wiring metadata for v1**?* The verifier flags `inputs` as the nearest edge to orchestrator creep. **Recommendation: yes, minimal slice.**
- *Make `handlerSignature` mandatory* (content hash over sorted step IDs + resolved handler/predicate names + version), with the global registry **rejecting** a second `register()` for the same `(workflowId, version)` whose signature differs — closing the WeakRef last-write-wins silent-mis-execution hole. **Recommendation: mandatory, not optional.**
- Also requires: enforce definition immutability per `(workflowId, version)`; synchronous `UnknownHandlerError` at hydrate; default `loadWorkflowFromStore` to **version-explicit**; remove `contextFactories` from the recovery-determinism story (context is start-only, persisted, reused on resume); **add explicit `@classytic/mongokit ^3.14.0` + `@classytic/repo-core` deps to `streamline/package.json`** (pre-existing undeclared-dependency packaging bug).

### 4.3 — `distributed-scale` (worker leasing, partitioning, push-wake)
**Recommendation: `build-after-fixes`, but the highest-effort/highest-risk item → sign-off the AMBITION.** Philosophy-clean (pure execution substrate). But the verifier found the **lease premise is partly fictional**: recovery is scheduler-**PUSH** (`recoverStale → this.execute(runId)` runs inline on the polling scheduler), not worker-**PULL** — so `ownedBy`/`workerId` adds little safety over the existing heartbeat-age CAS. The proposed `leasePlugin` delegation does **not** hold (`leasePlugin.lease()` is predicate-FIFO with no id; its terminal-status flip would violate `RUN_MACHINE`).

**Open question for sign-off:** *Is Area-4 horizontal scale a real near-term requirement, or premature?* If pursued, the mongokit story must be **`claim()` with lease fields as extra `$set`** (drop `leasePlugin` entirely), gate **all** behavior changes behind "distributed options configured" (default install stays byte-for-byte `lastHeartbeat`-only), unify the staleness clock across `recoverStale`/`markStaleAsFailed`/`markAsDeadLettered`, validate `leaseTtlMs > HEARTBEAT_INTERVAL + maxStepDuration`, add a worker-side lease-loss abort, enforce partition-coverage in code, route WakeSource through the same concurrency-admission gate as poll, and accept the honest ceiling: **per-partition ordering, effectively-once, poll-augmented-by-push.** **Recommendation: spec it, do not merge until scale is a committed requirement.**

---

## 5. Reject / keep out of the engine

- **Cost / pricing / accounting hooks.** Confirmed absent and must stay absent. Cost accounting lives in the **host** (Prism `pipelines/cost.ts`). The engine emits `step:completed`/`step:progress`; the host meters. (Reinforced by every design's philosophyNote and the project's "Prism = primitives, agent = workflow" rule.)
- **Deserializing the `condition: String` field** in `definition.model.ts`. It is dead storage today. Wiring an `eval`/`new Function` deserializer turns the engine into a data-driven business-logic orchestrator — the exact HARD-RULE violation. **Drop the field during the mongokit-refactor migration** (preferred) or annotate it FORBIDDEN-TO-EVAL.
- **Full declarative DAG with serialized branch conditions / expression DSL / data-driven branching.** Rejected in `dag-parallel` and `workflow-as-data`. The join is policy-over-named-children; workflow-as-data is selection-only. Anything richer belongs in the agent layer.
- **Built-in transactional-outbox collection or per-entity distributed lock in the engine.** Host/mongokit territory (`batchTransaction`, `createMongoLockAdapter`, `leasePlugin`). The engine exposes the durable checkpoint + idempotency key; the host composes exactly-once.
- **Built-in matching-service / global-FIFO / sub-second push dispatcher** (`distributed-scale`). Requires a substrate Mongo doesn't provide and would drag fairness/priority **policy** into the engine. Out of scope.
- **`inputs` I/O-wiring metadata in workflow-as-data v1.** Defer — nearest edge to orchestrator creep.
- **Marketing language "exactly-once" against external APIs.** No engine delivers it. Say *"effectively-once with idempotency keys"* and *"transactional exactly-once for same-cluster writes."*

---

## 6. Sequencing + semver plan

**The mongokit-refactor goes FIRST, as the foundation** — it is ~85% shipped, lowest-effort, and its `assertWriteConcern` tripwire + definition-repo cleanup de-risk every later storage write. (It is not "last to de-risk" because it touches no orchestration semantics and the durability guarantee it pins is a prerequisite for trusting all subsequent claims.)

**Phase 0 — Foundation (v2.4.0, minor)**
- `mongokit-refactor` fixes (retain `pre('save')` hook, singleton-lock `release()`+correct lease duration, prevent `recoveryAttempts` double-inc, drop `condition` field, `assertWriteConcern` test). *Minor — provided `pre('save')` is retained; otherwise major.*

**Phase 1 — The unblocker (v2.5.0, minor)**
- **Durable childWorkflow/gate/branchJoin reconciliation path** (new `CommonQueries` + index + scheduler poll branch). Fixes the pre-existing latent bug. *Minor (bug-fix behavior change — migration note: operators who built around the broken dead-wait behavior).* **Everything in Phase 3 depends on this.**

**Phase 2 — Safe additive primitives (v2.6.0, minor)**
- `output-history` (after fixes) + `ctx.idempotencyKey` extracted from `order-saga` (the attempt-invariant version) as a standalone primitive. *Minor-additive.*

**Phase 3 — Saga + agentic + parallel (v2.7.0, minor)**
- `order-saga` durable compensation; then `agentic` (`gate`+`stream` → `loop` → `injectSteps`); then `dag-parallel`. All ride the Phase 1 reconciliation path.
- **Type-level break watch:** extending the `RunStatus` union (`order-saga`) and adding `WaitingFor.type` literals (`gate`, `branchJoin`) break downstream exhaustive switches under `isolatedModules`. **Documented migration note required; still semver-minor** (additive at runtime), but flag loudly.
- **The one true major-version candidate:** if the `agentic` graph-model migration (`getNextStepForRun` replacing `getNextStep` at goto/rewind sites) cannot be cleanly gated behind deps/overlay-present, it is a core forward-walk semantics change → **major**. Gate it; if ungatable, ship in a v3.0.0.

**Phase 4 — Sign-off-gated (no fixed release)**
- `workflow-as-data` (minimal slice, mandatory `handlerSignature`) and `distributed-scale` (claim-with-lease-fields, fully gated) — spec now, merge only on explicit decision.

**Non-breaking vs major summary:** Phases 0–3 are all semver-**minor** (additive surface, opt-in flags, default-absent fields) **with two documented caveats** — the `RunStatus`/`WaitingFor` type-union extensions (exhaustive-switch break) and the `mongokit-refactor` `pre('save')` retention. The **only** genuine major risk is an ungatable `getNextStep` seam change in `agentic`.

---

## 7. Proposed target public API (after all "build now" + Phase 1–3 land)

```ts
// ── ctx.* surface (additive to existing set/getOutput/wait/waitFor/sleep/
//    goto/checkpoint/getCheckpoint/scatter/log/emit/heartbeat/startChildWorkflow) ──

interface StepContext<TContext> {
  // Per-step output history (Phase 2)
  outputHistory<T = unknown>(stepId?: string): StepOutputVersion<T>[]; // pure read
  pinOutput(version: number, stepId?: string): Promise<void>;          // durable copy-back

  // Effective-once external calls (Phase 2) — ATTEMPT-INVARIANT
  idempotencyKey(scope?: string): string; // = `${runId}:${stepId}[:${scope}]`

  // Durable fan-out + join over named child workflows (Phase 3, dag-parallel)
  joinBranches<TJoin = unknown>(
    branches: Array<{ workflowId: string; input: unknown; key?: string }>,
    options?: { policy?: 'all' | 'any' | 'race' | 'allSettled'; cancelLosers?: boolean },
  ): Promise<TJoin>;

  // Agentic primitives (Phase 3) — delivered gate+stream → loop → injectSteps
  gate(reason: string, data?: unknown): Promise<unknown>;          // durable human waitpoint
  resolveGate(gateId: string, decision: unknown): Promise<void>;   // cross-run resolve
  loop<S>(init: S, body: (s: S, i: number) => Promise<{ state: S; done: boolean }>,
          opts?: { maxIterations?: number }): Promise<S>;          // auto-heartbeats per iter
  spawnAgents(children: Array<{ workflowId: string; input: unknown }>,
              opts?: { concurrency?: number; joinPolicy?: 'all' | 'first' | 'allSettled' }): Promise<unknown[]>;
  injectSteps(steps: Array<{ stepId: string; handlerKey: string; input?: unknown }>,
              opts?: { position?: 'after-current' | 'end' }): Promise<void>; // named-handler registry only
  stream(frame: unknown): void; // NON-durable, at-most-once, side-effect-free on run state
}

// ── Step / Workflow config (additive, all optional) ──
interface StepConfig<TContext> {
  // ...existing retries/timeout/condition/skipIf/runIf/onCompensate...
  outputHistory?: { keep: number };                                 // 0/undefined = disabled
  compensateRetries?: number; compensateRetryDelay?: number;
  compensateRetryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
}
interface WorkflowConfig<TContext, TInput> {
  // ...existing...
  defaults?: { outputHistory?: { keep: number } };
  saga?: { durable?: boolean };                                     // default false (v2.3.4 back-compat)
  dynamicHandlers?: Record<string, StepHandler<unknown, TContext>>; // named-handler registry for injectSteps
}

// ── Engine handle (via createWorkflow) ──
interface WorkflowHandle<TContext> {
  resolveGate(gateId: string, decision: unknown): Promise<WorkflowRun<TContext>>;
  // distributed-scale verbs (claimWithLease/renewLease/releaseLease) — Phase 4, gated
}

// ── New durable state (new StepState fields — NEVER the output slot) ──
interface StepOutputVersion<T = unknown> {
  value: T; attempt: number; recordedAt: Date; durationMs?: number;
  reason?: 'success' | 'rerun' | 'restore';
}
interface StepState {
  // ...existing output/error/status/attempts/waitingFor...
  outputHistory?: StepOutputVersion[]; pinnedVersion?: number;      // Phase 2
  compensation?: { status: 'pending' | 'done' | 'failed' | 'skipped';
                   attempts: number; startedAt?: Date; completedAt?: Date; error?: StepError }; // Phase 3
}

// ── New wire/status surface (TYPE-LEVEL break — migration note) ──
type RunStatus = /* existing */ | 'compensating' | 'compensated' | 'compensation_failed';
type WaitingForType = /* existing */ | 'gate' | 'branchJoin';

// ── Workflow-as-data (Phase 4, sign-off, minimal slice) ──
function createWorkflowFromDefinition<TContext, TInput>(
  def: WorkflowDefinitionDoc, registry: HandlerRegistry<TContext>,
  opts?: { container?: StreamlineContainer },
): Workflow<TContext, TInput>;
class WorkflowDefinitionRepository extends Repository<WorkflowDefinitionDoc> {} // Phase 0
```

**Recommended host pattern (zero engine change, documented):** model independently-rerunnable fan-out units (Prism shots, order-lines) as **child workflows via `startChildWorkflow`/`joinBranches`** — re-running one unit = re-invoking one child with its deterministic idempotency key. This is the preferred answer to `rerun-node` over in-graph `deps`.

---

*Relevant source roots referenced throughout (absolute):* `D:/projects/packages/streamline/src` (engine), `D:/projects/packages/mongokit/src` (storage primitives), and the host `d:/projects/creative/prism/apps/api/src/pipelines/cost.ts` (where all cost accounting stays).