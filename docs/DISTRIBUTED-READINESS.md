# Distributed Readiness — Limitations & Operating Guidance

> **Read this before running streamline as a multi-worker, multi-tenant, or
> high-load system.** streamline is a Mongo-backed durable workflow engine with
> strong **single-cluster** correctness. It is **multi-worker-capable**, but it
> is deliberately **not** "Temporal-grade distributed by default." This document
> states the boundaries plainly so you can configure for your scale instead of
> discovering them in production.

## What streamline guarantees (the strong parts)

- **Durable, crash-recoverable execution** — run state is persisted to MongoDB
  with `{ w: 'majority', j: true }`; steps resume from the exact failed step
  after a process crash; stale `running`/`compensating`/childWorkflow/branchJoin
  waits are reclaimed by the scheduler sweep.
- **Atomic claims** — every state transition is a CAS (`assertAndClaim` /
  numeric-index-guarded `updateOne`), so concurrent workers can't double-drive a
  run or double-resume a step (hardened in v2.4: resume is now a true
  waiting-step CAS).
- **Per-workflow scheduler scoping (v2.4)** — each engine's scheduler only picks
  up runs for its own `workflowId` (query-scoped + a routing guard), so in an app
  with multiple registered workflows one engine can no longer claim or
  mis-execute another workflow's runs.
- **Durable saga compensation, parallel/join, child workflows, idempotency keys**
  — all crash-recoverable; see CHANGELOG 2.4.0.

## Limitations & how to operate around them

### 1. In-memory resume timers default ON

For fast resume, a sub-~24.8-day `ctx.sleep()` / timer wait schedules an
in-process `setTimeout` (unref'd). With **many thousands of concurrently
sleeping runs**, that's many process timers. MongoDB polling is always the
durable backstop and fires regardless.

- **High-scale guidance:** set `scheduler: { inMemoryTimers: false }` (per
  workflow or engine) to skip the per-wait timer and rely purely on DB polling —
  bounded timers, slightly higher resume latency (one poll interval).
- Default stays `true` (fast resume) for typical workloads.

### 2. Large payloads can still hit the 16 MB BSON limit

`context`, `input`, `output`, per-step `checkpoint`, and `outputHistory` are
stored **inline on the run document**. v2.4 bounds what the engine controls:
`stepLogs` is a ring buffer (`maxStepLogs`, default 1000) and `outputHistory` is
`keep`-bounded. But the engine **cannot bound arbitrary user-supplied
context/output/checkpoint values**.

- **Guidance:** never store large blobs (images, files, big JSON) in workflow
  state. Persist them in object storage / media-kit / your DB and keep only a
  **handle/reference** in `context`/`output`. Treat the run document as control
  state, not a data store.

### 3. `concurrency.limit` is best-effort unless `strict: true`

Without `strict: true`, the limit is a count-then-create gate with a small
TOCTOU window — a burst can admit slightly over the limit. This is by design
(cheap, no counter doc).

- **Guidance:** for a hard cap use `concurrency: { limit, strict: true }` — an
  atomic counter (`incrementIfBelow`) enforces it exactly. Accept the extra
  counter write + the need to reconcile on leaks (below).

### 4. Strict concurrency counters are global by `(workflowId, concurrencyKey)` — NOT tenant-scoped

A strict counter is keyed on `(workflowId, concurrencyKey)`. In a multi-tenant
deployment this is a **global** cap across all tenants of that workflow.

- **Guidance:** to get a per-tenant cap, **include the tenant in your
  `concurrencyKey`** (e.g. `` `${organizationId}:render` ``).
- If a counter drifts (e.g. a worker is SIGKILL'd between claim and run),
  repair it with the v2.4 primitive:
  `await concurrencyCounterRepo.reconcile(workflowId, concurrencyKey?)` — it
  recounts the true slot-holding runs (`running | waiting | compensating`) and
  resets the counter. Run it on a schedule or after an incident.

### 5. External adapters are bring-your-own

The engine ships in-process eventing + Mongo durability. It does **not** bundle:

- a **cross-process signal store** for `ctx.waitFor(event)` wake across
  processes — pluggable via the `SignalStore` interface (wire Redis/Kafka
  yourself);
- a **monitoring dashboard / dead-letter UI / metrics exporter** — consume the
  event bus (`step:*`, `workflow:*`, `scheduler:*`) and OpenTelemetry hooks into
  your own stack;
- integrations beyond **Fastify** (the only first-party `src/integrations`
  adapter today).

### 6. Honest positioning

streamline is **multi-worker-capable after v2.4**, with correct per-workflow
scheduler ownership, atomic claims, and crash recovery. It is **not** a
Temporal/Restate replacement: there is **no explicit worker-lease/ownership
protocol**, **no sharded/partitioned task queue**, and **no global-FIFO matching
service**. Recovery is scheduler-push (a polling engine re-drives stale runs),
not worker-pull off a queue.

For a high-scale distributed deployment, plan to: scope concurrency keys by
tenant (§4), run with `inMemoryTimers: false` (§1), wire an external signal
store (§5), keep payloads small (§2), and add your own monitoring (§5). Within
those bounds it is a solid, durable, single-cluster engine.
