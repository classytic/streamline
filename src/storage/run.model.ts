import mongoose, { Schema } from 'mongoose';
import type {
  RecurrencePattern,
  SchedulingInfo,
  StepLogEntry,
  StepState,
  WorkflowRun,
} from '../core/types.js';

const StepStateSchema = new Schema<StepState>(
  {
    stepId: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'waiting', 'done', 'failed', 'skipped'],
      required: true,
    },
    attempts: { type: Number, default: 0 },
    startedAt: Date,
    completedAt: Date,
    endedAt: Date,
    durationMs: Number,
    output: Schema.Types.Mixed,
    // Use Mixed for waitingFor and error so they can be completely removed
    waitingFor: { type: Schema.Types.Mixed, required: false },
    error: { type: Schema.Types.Mixed, required: false },
    retryAfter: Date, // Exponential backoff timestamp
    // Durable saga compensation memoization (v2.4). Mixed subdoc mirrors the
    // `waitingFor`/`error` pattern so it can be entirely absent on non-saga
    // runs (no migration, no schema growth). Written DB-first AFTER the
    // onCompensate handler resolves; `status` is the per-step idempotency CAS
    // target (pending → done via numeric-index guarded updateOne).
    compensation: { type: Schema.Types.Mixed, required: false },
    // Opt-in versioned output history (ring buffer). `default: undefined`
    // keeps the field ABSENT on legacy/disabled runs — no migration, no
    // schema growth when `Step.outputHistory.keep` is 0/undefined. Mixed
    // array mirrors the `output` / `stepLogs` pattern; bounded at write time
    // via `$slice:-keep`, never indexed (read by `_id`).
    outputHistory: { type: [Schema.Types.Mixed], default: undefined },
    pinnedVersion: { type: Number, required: false },
    // Queryable latest-wins progress snapshot (v2.7). Mixed subdoc mirrors the
    // `waitingFor`/`error` pattern — entirely absent on steps that never call
    // `ctx.reportProgress()` (no migration, no schema growth). Written with
    // throttled, latest-wins persistence; bounded ~1KB at write time.
    lastProgress: { type: Schema.Types.Mixed, required: false },
    // Durable `ctx.dedupe` memoization cache (v2.7). Mixed map; entirely
    // absent on steps that never call `ctx.dedupe`. Bounded ~10KB at write
    // time; NEVER overlaps `output`.
    dedupeCache: { type: Schema.Types.Mixed, required: false },
    // Host-recorded per-step cost (v2.7). Absent unless a host/middleware
    // writes it (typically a `taskMiddleware.after` hook). Summed by
    // `engine.getRunMetrics`; never interpreted by the engine.
    cost: { type: Number, required: false },
  },
  { _id: false },
);

const StepLogEntrySchema = new Schema<StepLogEntry>(
  {
    stepId: { type: String, required: true },
    message: { type: String, required: true },
    data: Schema.Types.Mixed,
    attempt: { type: Number, required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false },
);

const RecurrencePatternSchema = new Schema<RecurrencePattern>(
  {
    pattern: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'custom'],
      required: true,
    },
    daysOfWeek: [Number], // 0=Sunday, 6=Saturday
    dayOfMonth: Number, // 1-31
    cronExpression: String,
    until: Date,
    count: Number,
    occurrences: { type: Number, default: 0 },
  },
  { _id: false },
);

const SchedulingInfoSchema = new Schema<SchedulingInfo>(
  {
    scheduledFor: { type: String, required: true }, // User's local time string (e.g., "2024-03-10T09:00:00")
    timezone: { type: String, required: true },
    localTimeDisplay: { type: String, required: true },
    executionTime: { type: Date, required: true, index: true }, // Critical: scheduler uses this
    isDSTTransition: { type: Boolean, default: false },
    dstNote: String,
    recurrence: RecurrencePatternSchema,
  },
  { _id: false },
);

const WorkflowRunSchema = new Schema<WorkflowRun>(
  {
    _id: { type: String, required: true },
    // No field-level index — every workflowId query rides a workflowId-leading
    // compound ({workflowId, concurrencyKey, status}, the scheduler compound);
    // a bare single is a redundant prefix (P11.1, fleet index audit 2026-07).
    workflowId: { type: String, required: true },
    status: {
      type: String,
      // Durable saga (v2.4) adds 'compensating' | 'compensated' |
      // 'compensation_failed'. Additive at runtime — existing runs are
      // unaffected.
      enum: [
        'draft',
        'running',
        'waiting',
        'done',
        'failed',
        'cancelled',
        'compensating',
        'compensated',
        'compensation_failed',
      ],
      required: true,
      // No field-level index — {status, updatedAt} + {status, priority,
      // updatedAt} compounds serve every status-prefix query (P11.1).
    },
    steps: [StepStateSchema],
    currentStepId: String,
    context: { type: Schema.Types.Mixed, default: {} },
    input: Schema.Types.Mixed,
    output: Schema.Types.Mixed,
    error: { type: Schema.Types.Mixed, required: false }, // Workflow-level error (e.g., data corruption)
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    startedAt: Date,
    endedAt: Date,
    lastHeartbeat: Date, // For detecting stale running workflows
    paused: { type: Boolean, default: false }, // User-initiated pause - scheduler skips paused workflows
    scheduling: SchedulingInfoSchema, // Optional: timezone-aware scheduling metadata
    stepLogs: { type: [StepLogEntrySchema], default: undefined }, // Persisted step-level logs from ctx.log()
    idempotencyKey: String, // Dedup key — non-terminal runs block duplicates
    priority: { type: Number, default: 0 }, // Higher = picked up sooner by scheduler
    concurrencyKey: String, // Grouping key for concurrency limits
    // No field-level index — {userId, createdAt} compound covers the prefix (P11.1).
    userId: { type: String },
    tags: [String],
    meta: Schema.Types.Mixed,
    // Operator cancellation reason (v2.7). Absent unless
    // `engine.cancel(runId, { reason })` was called with a reason.
    cancellationReason: { type: String, required: false },
    /**
     * Pinned definition version (semver). The engine snapshots
     * `WorkflowDefinition.version` at create-time so a run resumed weeks
     * later still uses the step graph it started under. The engine
     * resolves this through a version-keyed registry (`workflowRegistry.lookupVersion`)
     * before re-execution; missing → falls back to the active definition.
     */
    definitionVersion: String,
    /**
     * How many times the stale-recovery / sweeper paths have touched this
     * run. Once it hits `RetentionOptions.maxStaleRecoveries`, the next
     * sweep marks the run failed with `error.code === 'dead_lettered'`
     * instead of recycling it forever.
     */
    recoveryAttempts: { type: Number, default: 0 },
  },
  {
    collection: 'workflow_runs',
    timestamps: false,
    /**
     * Majority write concern ensures data survives replica set failovers.
     * Without this, acknowledged writes can vanish on primary crash.
     *
     * - w: 'majority' — acknowledged by a majority of replica set members
     * - j: true — written to the on-disk journal before acknowledging
     *
     * For standalone dev instances, Mongoose/MongoDB gracefully degrades.
     */
    writeConcern: { w: 'majority', j: true },
  },
);

// Core indexes for workflow execution.
// NOTE: no bare {workflowId, status} — the scheduler compound
// {workflowId, status, steps.status, steps.waitingFor.resumeAt} below serves
// the same prefix (P11.1; the audit's highest-traffic redundant index rode it).
WorkflowRunSchema.index({ status: 1, updatedAt: -1 });

// Idempotency: compound index for "find active run by key" query
WorkflowRunSchema.index({ idempotencyKey: 1, status: 1 }, { sparse: true });

/**
 * Idempotency race-safety (PACKAGE_RULES §32).
 *
 * Partial unique index closes the TOCTOU window between the lookup in
 * `engine.start()` and the `repository.create()` call. Two concurrent
 * workers with the same key both pass the lookup (no row yet); the second
 * insert hits MongoDB's E11000 duplicate-key error. `WorkflowRunRepository`
 * catches it and returns the winning run.
 *
 * `partialFilterExpression` excludes terminal statuses, so the key is
 * reusable after `done` / `failed` / `cancelled` — same documented semantic
 * as before, now actually race-safe.
 *
 * Durable saga (v2.4): `'compensating'` is included in the active `$in` set —
 * a run mid-rollback is still ACTIVE and must keep blocking a duplicate
 * idempotency key (a second start of the same logical operation while the
 * first is still compensating would be unsafe). The terminal compensation
 * outcomes `'compensated'` / `'compensation_failed'` are deliberately EXCLUDED
 * (like `done`/`failed`/`cancelled`), so the key becomes reusable once the
 * saga fully settles.
 *
 * `idempotencyKey: { $type: 'string' }` is the standard guard against
 * `null` collisions when other docs lack the field (PACKAGE_RULES §35).
 *
 * ⚠️ Production deployment — clean active duplicates first.
 *
 * Existing deployments may carry duplicate `idempotencyKey` values across
 * non-terminal runs (the pre-fix race could produce them). MongoDB will
 * REFUSE to build this index if duplicates exist:
 *
 *     IndexBuildFailed: E11000 duplicate key error
 *
 * Pre-deploy migration — run once against the production replica set
 * BEFORE rolling out a streamline version that ships this index:
 *
 * ```js
 * // 1. Find active duplicates so you can audit them.
 * db.workflow_runs.aggregate([
 *   { $match: {
 *     idempotencyKey: { $type: 'string' },
 *     status: { $in: ['draft', 'running', 'waiting'] },
 *   }},
 *   { $group: { _id: '$idempotencyKey', ids: { $push: '$_id' }, n: { $sum: 1 } }},
 *   { $match: { n: { $gt: 1 } }},
 * ]);
 *
 * // 2. For each duplicate group, keep the oldest run, terminate the rest:
 * db.workflow_runs.updateMany(
 *   { _id: { $in: [/* duplicate ids except the keeper *\/] }, status: { $ne: 'cancelled' }},
 *   { $set: { status: 'cancelled', endTime: new Date(),
 *             error: { message: 'Cancelled during idempotency-index migration' }}},
 * );
 * ```
 *
 * Single-tenant new deployments can skip this — no pre-existing data, no
 * duplicates possible.
 */
WorkflowRunSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' },
      // 'compensating' is still active → keeps blocking duplicate keys.
      // Terminal 'compensated'/'compensation_failed' are excluded (key reusable).
      status: { $in: ['draft', 'running', 'waiting', 'compensating'] },
    },
  },
);

// Concurrency: count active runs per workflow + key
WorkflowRunSchema.index({ workflowId: 1, concurrencyKey: 1, status: 1 });

// Priority: scheduler picks highest priority first
WorkflowRunSchema.index({ status: 1, priority: -1, updatedAt: 1 });

// User-scoped history: "list this user's runs, newest first" —
// CommonQueries.byUser (query-builder.ts) and host dashboards filtering
// on the `userId` stamped by SchedulingService.schedule().
WorkflowRunSchema.index({ userId: 1, createdAt: -1 });

// Step-targeted lookups: host-side queries that select runs by an embedded
// step id (multikey) — e.g. "which runs contain step X" operator views and
// webhook/approval resolvers matching a run via its waiting step.
WorkflowRunSchema.index({ 'steps.stepId': 1 });

// Critical index for scheduler polling (prevents full collection scans)
// REQUIRED for production: Supports getReadyToResume() query
WorkflowRunSchema.index({
  status: 1,
  'steps.status': 1,
  'steps.waitingFor.resumeAt': 1,
});

// Critical index for retry polling (prevents full collection scans)
// REQUIRED for production: Supports getReadyForRetry() query
WorkflowRunSchema.index({
  status: 1,
  'steps.status': 1,
  'steps.retryAfter': 1,
});

// Critical index for stale workflow recovery (prevents full collection scans)
// REQUIRED for production: Supports getStaleRunningWorkflows() query
WorkflowRunSchema.index({
  status: 1,
  lastHeartbeat: 1,
});

// Critical index for crash-durable child-workflow reconciliation.
// REQUIRED for production: Supports getChildWaitingRuns() query
// (CommonQueries.childWaiting in query-builder.ts). Selects
// status='waiting' runs with a step in status='waiting' whose
// waitingFor.type='childWorkflow', gated on the reconcile cadence
// (waitingFor.nextReconcileAt <= now). Without it the poller does a full
// collection scan every cadence window.
WorkflowRunSchema.index({
  status: 1,
  'steps.status': 1,
  'steps.waitingFor.type': 1,
  'steps.waitingFor.nextReconcileAt': 1,
});

// Critical index for scheduled workflow polling (timezone-aware scheduling)
// REQUIRED for scheduled workflows: Supports efficient polling by execution time
// Query pattern: status='draft' AND executionTime <= now AND paused != true
WorkflowRunSchema.index({
  status: 1,
  'scheduling.executionTime': 1,
  paused: 1,
});

/**
 * WORKFLOW-SCOPED SCHEDULER PICKUP INDEXES (v2.4.0 distributed-correctness fix).
 *
 * Each WorkflowEngine owns its own SmartScheduler, now scoped to the engine's
 * own `workflowId` so engine B never picks up engine A's run. That scoping adds
 * a leading `workflowId` equality predicate to every pickup query. These
 * compound indexes carry that `workflowId` prefix so the scoped sweeps stay
 * index-backed (an index whose prefix doesn't match the query's leading
 * equality term can't be used, so the unscoped indexes above are insufficient
 * once `workflowId` is the leading filter term).
 *
 * Each mirrors an unscoped pickup index above, prefixed with `workflowId`:
 *   - readyToResume  : status + steps.status + steps.waitingFor.resumeAt
 *   - readyForRetry  : status + steps.status + steps.retryAfter
 *   - staleRunning / staleCompensating : status + lastHeartbeat
 *   - childWaiting / branchJoinWaiting : status + steps.status
 *                       + steps.waitingFor.type + steps.waitingFor.nextReconcileAt
 *   - scheduledReady : status + scheduling.executionTime + paused
 * The existing `{ workflowId:1, status:1 }` and
 * `{ workflowId:1, concurrencyKey:1, status:1 }` indexes already back the
 * scoped waiting/concurrency-draft existence probes and concurrency-draft list.
 */
WorkflowRunSchema.index({
  workflowId: 1,
  status: 1,
  'steps.status': 1,
  'steps.waitingFor.resumeAt': 1,
});
WorkflowRunSchema.index({
  workflowId: 1,
  status: 1,
  'steps.status': 1,
  'steps.retryAfter': 1,
});
WorkflowRunSchema.index({
  workflowId: 1,
  status: 1,
  lastHeartbeat: 1,
});
WorkflowRunSchema.index({
  workflowId: 1,
  status: 1,
  'steps.status': 1,
  'steps.waitingFor.type': 1,
  'steps.waitingFor.nextReconcileAt': 1,
});
WorkflowRunSchema.index({
  workflowId: 1,
  status: 1,
  'scheduling.executionTime': 1,
  paused: 1,
});

// Compound indexes for keyset pagination used by repository getAll/scheduler queries.
// Without these, MongoKit emits warnings and MongoDB does full collection scans.
WorkflowRunSchema.index({ status: 1, paused: 1, updatedAt: -1, _id: -1 });
WorkflowRunSchema.index({ status: 1, paused: 1, updatedAt: 1, _id: 1 });

// Workflow-SCOPED keyset variant (v2.4.0 engine scoping). The scheduler sweeps
// (getReadyForRetry / getReadyToResume / getChildWaitingRuns / getStaleRunning /
// scheduledReady) are scoped to the engine's own `workflowId`, so their keyset
// query filters `{ status, paused, workflowId }` and sorts `updatedAt: 1`. The
// unscoped pair above can't back that (a `workflowId` equality term not in the
// index prefix bars its use), so MongoKit warned + Mongo full-scanned on EVERY
// poll tick. This mirrors 347-348 with `workflowId` in the prefix — the exact
// index MongoKit's keyset detector asks for. The `notPaused()` sweeps all sort
// ascending, so one asc variant suffices.
WorkflowRunSchema.index({ status: 1, paused: 1, workflowId: 1, updatedAt: 1, _id: 1 });

// Same prefix + the `steps` multikey position. Used by `readyForRetry` /
// `readyToResume` (CommonQueries.readyForRetry / readyToResume in
// `query-builder.ts`) — both add a `steps.$elemMatch` clause on top of
// `{ status, paused }` and sort by `updatedAt`. Mongokit's keyset
// detector emits a "no matching compound index" warning without this;
// the multikey index lets the planner use a single bounded scan
// instead of fetching every status='waiting' & paused=false doc and
// filtering steps in-memory. The trailing `_id` matches the cursor
// shape mongokit's keyset cursor encodes.
WorkflowRunSchema.index({ status: 1, paused: 1, steps: 1, updatedAt: 1, _id: 1 });

/**
 * MULTI-TENANCY & SCHEDULED WORKFLOWS - COMPOSITE INDEXES
 *
 * For multi-tenant scheduled workflows, add composite indexes with tenantId FIRST.
 * MongoDB can only use indexes if the query matches the prefix pattern.
 *
 * Example: Multi-tenant scheduled workflow polling
 * ```typescript
 * import { WorkflowRunModel } from '@classytic/streamline';
 *
 * // Add composite index: tenantId first, then scheduling fields
 * WorkflowRunModel.collection.createIndex({
 *   'context.tenantId': 1,
 *   status: 1,
 *   'scheduling.executionTime': 1,
 *   paused: 1
 * });
 *
 * // This query will use the index efficiently:
 * const scheduledWorkflows = await WorkflowRunModel.find({
 *   'context.tenantId': 'tenant123',
 *   status: 'draft',
 *   'scheduling.executionTime': { $lte: new Date() },
 *   paused: { $ne: true }
 * }).sort({ 'scheduling.executionTime': 1 }).limit(100);
 * ```
 *
 * Example: List workflows by tenant and time
 * ```typescript
 * WorkflowRunModel.collection.createIndex({
 *   'context.tenantId': 1,
 *   workflowId: 1,
 *   createdAt: -1
 * });
 * ```
 *
 * IMPORTANT: Put tenantId FIRST in all multi-tenant indexes for query efficiency.
 */

/**
 * MULTI-TENANCY & CUSTOM INDEXES
 *
 * The engine is unopinionated about multi-tenancy. Add indexes for YOUR needs:
 *
 * Option 1: Add tenantId to metadata and index it
 * ```typescript
 * import { WorkflowRunModel } from '@classytic/streamline';
 *
 * // Add custom index for tenant-scoped queries
 * WorkflowRunModel.collection.createIndex({ 'meta.tenantId': 1, status: 1 });
 * WorkflowRunModel.collection.createIndex({ 'meta.orgId': 1, createdAt: -1 });
 * ```
 *
 * Option 2: Extend the schema (before first use)
 * ```typescript
 * import { WorkflowRunModel } from '@classytic/streamline';
 *
 * WorkflowRunModel.schema.add({
 *   tenantId: { type: String, index: true }
 * });
 * WorkflowRunModel.schema.index({ tenantId: 1, status: 1 });
 * ```
 *
 * Then query: engine.get(runId) and filter by tenantId in your app layer
 */

/**
 * Export WorkflowRunModel with hot-reload safety
 *
 * The pattern checks if the model already exists before creating a new one.
 * This prevents "OverwriteModelError" in development with hot module replacement.
 */
let WorkflowRunModel: mongoose.Model<WorkflowRun>;

if (mongoose.models.WorkflowRun) {
  // Model already exists - reuse it (for hot reload scenarios)
  WorkflowRunModel = mongoose.models.WorkflowRun as mongoose.Model<WorkflowRun>;
} else {
  // Create new model
  WorkflowRunModel = mongoose.model<WorkflowRun>('WorkflowRun', WorkflowRunSchema);
}

export { WorkflowRunModel };
