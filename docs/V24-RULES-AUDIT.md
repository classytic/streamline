# v2.4 Rules Audit — `@classytic/streamline`

**Scope:** `git diff 76f8f51..HEAD` (76f8f51 = 2.3.4 baseline → a2ab0c9 = v2.4 in-progress HEAD).
**Bible:** `D:\projects\ecom\commerce\PACKAGE_RULES.md` (all 2594 lines).
**Reference APIs read:** mongokit `Repository.ts` (claim / claimVersion / cursor / updateMany / findOneAndUpdate / count / exists), `QueryParser.ts`, repo-core `errors`/`pagination` subpaths.

## Applicability stance (read this first)

streamline is **INFRASTRUCTURE** — a durable, MongoDB-native workflow *engine*, not a domain CRUD package. PACKAGE_RULES is written primarily for domain packages (Order, Cart, Catalog, …) that model business aggregates behind Arc. A large class of its rules therefore **does not apply** and forcing them would be wrong:

- **Domain primitives** (`Money`, `Address`, `GeoPoint`, `DateRange`/`Period`, `ApprovalChain`, `Result`, `Cadence`, `SLA`, `ExternalRef`) — N/A. A workflow engine has no money/address/approval domain. `WorkflowRun`/`StepState` are engine state, not business value objects. (P1, P3, P6, P7, P12 approval/money/geo bullets.)
- **Multi-tenant *schema* rules** (P11 `inject-tenant.ts`, §9.x `multiTenantPlugin({fieldType})`, §33/§34 scope-prefix indexes, tenantField vs contextKey) — N/A as written. streamline does **not** use mongokit's `multiTenantPlugin`; it ships its own `tenantFilterPlugin` keyed on a config-driven `tenantField` (default `context.tenantId`) because a workflow run's tenant lives *inside* the run's context, not on a fixed schema column the host owns. This is a justified infra divergence; documented in `run.repository.ts`.
- **`customId` / `prefixedId` / dual-id resolver (P9, §8)** — N/A. Runs are keyed by a `randomUUID()` `_id`; no user-facing slug. Correct per §8 decision-tree branch 1 ("`_id` is enough").
- **SourceBridge / polymorphic external refs (§7)** — N/A. The engine references child *runs* by id within its own collection (self-ref semantics), not foreign aggregates.
- **Arc resource/action/route rules (§27–§30), Zod `/schemas` subpath (§24–§26), `packageEventDefinitions[]` (§18.5)** — N/A to the v2.4 diff. streamline is not wired as an Arc `defineResource`; it exposes an engine + repositories. No v2.4 change touched these surfaces.
- **Outbox / `dispatch()` / session-threading (§5.5, §16, P8, §17)** — N/A to v2.4. streamline uses its own `WorkflowEventBus` + an optional `EventTransport` (already structurally arc-compatible); v2.4 added no outbox path. Domain-event durability is the run document itself + `{w:'majority',j:true}`.

Rules that **DO** apply to an infra workflow-engine package and were checked carefully are below.

---

## Summary counts

| Verdict | Count |
|---|---|
| COMPLIANT | 14 |
| VIOLATION — FIXED | 1 |
| VIOLATION — FLAG (owner decision) | 2 |
| N/A (justified) | 9 rule-groups (see stance above) |

**Top findings**
1. **FIXED** — `define.ts` + the extraction-target `engine.ts` failed `biome ci` (format). Fixed by `biome --write` (whitespace-only; `git diff -w` confirms no semantic change). Now `npm run check` is clean.
1b. **FIXED (stale test, v2.4 drift)** — `test/e2e/version-saga.e2e.test.ts:172` asserted `result.status === 'failed'` for a run with `onCompensate` handlers. v2.4's durable-saga work made the engine drive compensation before returning, so the terminal status is now `'compensated'`. Proven PRE-EXISTING (fails identically on the committed engine with my changes stashed — NOT a refactor regression), but it is a clear v2.4 code/test drift, so the stale assertion was corrected to `'compensated'` (matches the documented terminal-state design in `core/types.ts` + the test's own compensation-order assertion, which already passes).
2. **FLAG** — `package.json` moved `@classytic/{mongokit,primitives,repo-core}` into `dependencies` while they remain in `peerDependencies`. Listing the same `@classytic/*` package in BOTH `dependencies` and `peerDependencies` is unusual; the rules want peer-deps for shared singletons. See R2 below — likely should be `peerDependencies` only (+ devDep for local resolution), OR keep as-is intentionally. Owner call.
3. **FLAG** — `workflowDefinitionRepository` plain-object delegate (Slice 2) re-exposes verbs as forwarding closures. It is a `@deprecated` back-compat shim, not a fresh proxy layer; acceptable, but flag for eventual removal at the next major. See R8.

---

## Rule-by-rule

### R1 — "No repo alias names. Let mongokit handle, no override unneededly. Fully trusted." (line 7) + §3 No proxy methods
**Verdict: COMPLIANT** (new v2.4 repo methods).
The new Slice-1/2/3 repo methods are genuine domain verbs, not renamed passthroughs:
- `getChildWaitingRuns` (`run.repository.ts:365`) — encodes the childWorkflow-reconcile cadence query (`CommonQueries.childWaiting`); not a rename of `findAll`.
- `restoreStepOutput` (`run.repository.ts:294`) — guarded copy-back (cancelled-guard + version-still-present guard) into the live output slot; real logic.
- `getStaleCompensatingRuns` (`run.repository.ts:398`) — compensation-phase stale sweep query.
- `WorkflowDefinitionRepository` verbs (`definition.model.ts:224`) — `getLatestVersion` / `getActiveDefinitions` (raw `$group`/`$replaceRoot` aggregate, not expressible via `getAll`) / `updateVersion` (recomputes semver fields). Real logic.
All route through inherited `Repository` methods (`getAll`/`getOne`/`count`/`exists`/`findOneAndUpdate`/`aggregatePipeline`/`updateMany`) so plugin hooks fire. No `findByX`/`listX` aliases introduced.

### R2 — Peer-dep declaration (§11 intro + line 11 "Declare `@classytic/repo-core` explicitly in `peerDependencies`")
**Verdict: VIOLATION (minor) — FLAG.** `package.json:120-122`.
v2.4 ADDED `@classytic/{mongokit,primitives,repo-core}` to `dependencies`. They are ALSO in `peerDependencies` (correct) and `devDependencies` (correct, for local resolution). The rule's intent: shared `@classytic/*` singletons (mongokit Repository base class, primitives event/state-machine, repo-core error/pagination contracts) must be **peer** deps so the host installs ONE copy and types unify. Declaring them in `dependencies` risks npm installing a second nested copy for consumers, defeating singleton unification (two `Repository` identities, two `HttpError` shapes). repo-core/primitives subpaths ARE imported (`errors`, `pagination`, `update`, `events`, `context`, `state-machine`), so the peer entries are required and correct. **Recommendation:** drop the three from `dependencies` (keep peer + dev). FLAGGED rather than auto-fixed because it is a published-package dependency-resolution decision with release-versioning implications the owner should make deliberately. `luxon`/`semver` in `dependencies` are correct (true runtime libs, not shared singletons).

### R3 — Errors thrown via repo-core `HttpError` / `createError` (the `@classytic/repo-core/errors` rule, line 98)
**Verdict: COMPLIANT (and exemplary).** `utils/errors.ts:155`.
`WorkflowError implements HttpError` from `@classytic/repo-core/errors`, carrying `status` + hierarchical `code` (`workflow.not_found`) + `meta`, with a `legacyCode` slot preserving the screaming-snake enum for back-compat. This is exactly the rule's "extend `HttpError` if you need a domain-typed throwable" guidance, done as a non-breaking minor. The local `ErrorCode`/`ErrorCodeHierarchical`/`ERROR_STATUS_MAP` are the package's own code taxonomy (allowed — codes are domain-extended hierarchically), not a parallel error-class hierarchy. v2.4 added saga literals consistently. COMPLIANT.

### R4 — mongokit `claim()` for state-machine CAS, no hand-rolled `findOneAndUpdate` where a primitive exists (§ field-grade primitives)
**Verdict: COMPLIANT.**
- Run-status transitions use `repo.claim()` / `assertAndClaim(RUN_MACHINE, …)`: `recoverCompensation` (`saga.ts`), `markStaleAsFailed`/`markAsDeadLettered` (`run.repository.ts`), `recoverStale`/`executeRetry`/`handleShortDelayOrSchedule` (engine/registries). All correct `from→to` + `where:` compound guards — the canonical `claim` shape.
- The per-step **compensation** memoization CAS (`compensateOneStep`, `saga.ts`) intentionally uses a numeric-index-guarded `updateOne(findOneAndUpdate)` NOT `claim()`. This is correct and documented: mongokit `claim()` cannot forward `arrayFilters`/positional `steps.<i>.compensation.status` guards. Justified deviation, not a hand-roll-where-a-primitive-exists violation.
- `restoreStepOutput` copy-back is a guarded `updateOne` (conditional `steps.<i>.outputHistory.version` predicate) — again array-subdoc-guarded, no `claim()` primitive covers it. COMPLIANT.

### R5 — `repo.cursor()` for streaming reads, not `Model.find().cursor()` (§ cursor primitive)
**Verdict: COMPLIANT.** `run.repository.ts:431` `cursorStaleRunning` routes through inherited `this.cursor(...)` so `before:cursor` hooks (tenant scope when not bypassed) fire. Not new in v2.4 but adjacent; correct. The new sweeps (`getChildWaitingRuns`, `getStaleCompensatingRuns`) use `queryLean` → inherited `getAll` (bounded page), consistent with the existing `getReadyToResume`/`getReadyForRetry` pattern.

### R6 — `updateMany` is a Repository primitive (no `batchOperationsPlugin`) (§ landmark)
**Verdict: COMPLIANT.** `definition.model.ts:312-326` `deactivate`/`deactivateOldVersions` call inherited `this.updateMany(filter, {$set})`. No bulk-ops plugin added. Correct.

### R7 — No needless `ObjectId → string` (§6)
**Verdict: COMPLIANT / N/A.** Run `_id` is a `randomUUID()` **string** by design, so there is no ObjectId→string coercion to avoid. No v2.4 code adds a `.toString()` on a mongokit-accepted id. `String(_id)` appears only in error/log message construction (allowed by §6).

### R8 — §2 No service layer / `WorkflowDefinitionRepository` shape (Slice 2)
**Verdict: COMPLIANT, with a FLAG on the back-compat shim.** `definition.model.ts`.
The class correctly `extends Repository<WorkflowDefinitionDoc>` (rule §1 "repositories ARE the API surface"); no wrapping service. The exported `workflowDefinitionRepository` plain object (`:343`) forwards to a default instance — superficially the "proxy" anti-pattern, BUT it is explicitly `@deprecated` and exists ONLY to preserve the pre-v2.4 plain-object export so existing callers don't break (the legacy `update()` name maps to the new `updateVersion()`). This is a legitimate migration shim, not new ceremony. **FLAG:** schedule its removal at the next major; new callers should use `new WorkflowDefinitionRepository()`. Note: this model uses the legacy `mongoose.models.WorkflowDefinition` hot-reload guard rather than the §21 `forceRecreate`/collision-throw pattern — pre-existing and intentionally unopinionated (documented in-file as host-extensible); not a v2.4 regression.

### R9 — P10 optional fields `T | undefined` under `exactOptionalPropertyTypes`
**Verdict: N/A (honestly).** `tsconfig.json` sets `strict: true` but does **NOT** enable `exactOptionalPropertyTypes`. P10 is explicitly conditioned on `exactOptionalPropertyTypes: true` ("mandatory — see tsconfig section") for domain packages. streamline does not opt in, so `foo?: Bar` (without `| undefined`) is legal here and typechecks clean. The v2.4 additions (`StepCompensationState`, `StepOutputVersion`, `WaitingFor.nextReconcileAt`, `compensationConfigs`, `outputHistory?`) use plain `?:`. Consistent with the package's existing tsconfig. **Note for owner:** if streamline ever flips on `exactOptionalPropertyTypes`, these would need `| undefined` audits — but that is a pre-existing package-wide decision, not a v2.4 violation.

### R10 — §5 Use mongokit types, never `any`
**Verdict: COMPLIANT.** v2.4 repo code uses `PluginType`, `MongoOperatorUpdate`, `Repository<…>['claim']`/`['findAll']` parameter-type extractions, and repo-core `OffsetPaginationResult`/`KeysetPaginationResult`. No new `any`. The `as Parameters<…>` casts are typed bridges, not `any`.

### R11 — §4 Return raw docs, no envelopes
**Verdict: COMPLIANT.** New repo methods return `LeanWorkflowRun[]` / `{ modifiedCount }` / `WorkflowRun` / `boolean` — raw shapes, no `{success,data}` wrappers.

### R12 — `{w:'majority',j:true}` / atomic CAS not weakened (HARD CONSTRAINT)
**Verdict: COMPLIANT — verified.** `run.model.ts:157` `writeConcern: { w: 'majority', j: true }` is intact (diff only ADDED enum/index entries around it; never touched the write concern). The idempotency partial-unique index correctly ADDS `'compensating'` to the active `$in` set (a mid-rollback run must keep blocking duplicate keys) and EXCLUDES the terminal `compensated`/`compensation_failed` — semantically correct, not a weakening. All claim/CAS guards preserved through the extraction (free functions call the same `repository.claim`/`assertAndClaim` with identical `from/to/where/patch/{bypassTenant}`).

### R13 — Barrel files / re-exports hurt tree-shaking (line 13) vs Slice-2 `src/index.ts` additions
**Verdict: COMPLIANT (justified exception).** `index.ts:60`, `:96`.
v2.4 added `WorkflowDefinitionRepository` and `OutputHistoryPush` to `src/index.ts`. Per the task's own framing and the rule's intent: the line-13 rule targets **internal** re-export barrels that defeat tree-shaking. `src/index.ts` is the package's **single published public entry** declared in `package.json#exports["."]` — the legitimate, sole barrel. `"sideEffects": false` + tsdown ESM output keep it tree-shakeable. The two additions are new public API for already-public subsystems (the definition store, the update-builder types). **Do NOT** collapse it. COMPLIANT; the public API was preserved by the extraction (see R14).

### R14 — Public API preservation (HARD CONSTRAINT, not a PACKAGE_RULE but audited)
**Verdict: COMPLIANT.** The de-bloat moved `hookRegistry`/`workflowRegistry` to `execution/registries.ts` but engine.ts **re-exports** them (`export { hookRegistry, workflowRegistry } from './registries.js'`), so `src/index.ts`'s `export { hookRegistry, workflowRegistry } from './execution/engine.js'` (line 255) is unchanged and the published path is identical. `package.json#exports` (`.`, `./fastify`, `./telemetry`) untouched. Zero public surface change.

---

## Pre-existing (out of scope — NOT fixed)

These predate 76f8f51 or are package-wide stances unrelated to the v2.4 diff; listed for awareness only, deliberately left untouched:

- **No `multiTenantPlugin` / `injectTenantField` adoption** — streamline ships its own `tenantFilterPlugin`. Pre-existing infra design choice (predates v2.4). Diverges from §9/§11/P11 but is justified (tenant lives in run context, not a host-owned column).
- **`WorkflowDefinitionModel` hot-reload guard** uses `mongoose.models[...]` rather than §21's `forceRecreate`/`XxxModelCollisionError`. Pre-existing; the model is intentionally unopinionated/host-extensible.
- **`exactOptionalPropertyTypes` not enabled** — package-wide tsconfig stance (pre-existing). See R9.
- **`@deprecated workflowDefinitionRepository` plain-object delegate** — back-compat shim (see R8); remove at next major.
- No `/schemas` Zod subpath / `packageEventDefinitions[]` / Arc `defineResource` wiring — streamline is engine-shaped, not Arc-resource-shaped. Pre-existing architecture.

---

## Verification

- `npm run typecheck` — clean.
- `npm run check` (biome ci) — clean (after the R1 format fix).
- Test results: see the delivery report (unit/integration/e2e). Only the documented pre-existing flaky `strict-concurrency-scenarios.test.ts` "admits EXACTLY limit" may flap; it fails identically on the pre-refactor baseline.
