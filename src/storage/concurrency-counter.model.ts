/**
 * Strict concurrency counter — atomic per-`(workflowId, key)` slot tracker.
 *
 * Used only when a workflow declares `concurrency.strict: true`. The
 * best-effort `concurrency.limit` path uses `countActiveByConcurrencyKey`
 * (count-then-create, briefly oversubscribable under bursts); strict mode
 * uses this counter doc with `findOneAndUpdate` + `$inc` so the gate is
 * race-safe across parallel workers and processes.
 *
 * Composite `_id`: `<workflowId>:<concurrencyKey>` — flat string so
 * Mongo's `_id` index is the only structure needed. No secondary indexes
 * required for the hot path (claimSlot / releaseSlot are both `_id`
 * lookups).
 *
 * Drift recovery (the leak risk):
 *   - If a worker dies AFTER `claimSlot` but BEFORE `repository.create`
 *     persists the run, the counter is +1 with no corresponding run.
 *   - The `WorkflowConcurrencyCounterRepository.reconcile()` admin
 *     method re-counts active runs per bucket and resets the counter to
 *     the truth. Run from a daily cron or on-demand.
 *   - Bounded by parallelism × MTBF; in practice negligible.
 */

import mongoose, { Schema } from 'mongoose';

/** Document shape. */
export interface WorkflowConcurrencyCounter {
  /** `<workflowId>:<concurrencyKey>` — composite primary key. */
  _id: string;
  /** Workflow definition id. Stored for index-free lookups + reconciliation. */
  workflowId: string;
  /** The bucket key this counter tracks. */
  concurrencyKey: string;
  /** Current count of active (claimed-but-not-released) runs in the bucket. */
  count: number;
  /** Configured limit at the time of first claim. Stored for diagnostics. */
  limit: number;
  /** When the counter was first created (first start in this bucket). */
  createdAt: Date;
  /** Last claim or release. */
  updatedAt: Date;
}

const WorkflowConcurrencyCounterSchema = new Schema<WorkflowConcurrencyCounter>(
  {
    _id: { type: String, required: true },
    workflowId: { type: String, required: true },
    concurrencyKey: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    limit: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    collection: 'workflow_concurrency_counters',
    timestamps: false,
    /**
     * Majority write concern — same correctness rationale as
     * `WorkflowRunModel`. Counter writes that lose to a primary crash
     * would silently drift the active-count.
     */
    writeConcern: { w: 'majority', j: true },
  },
);

// Reconciliation queries scan by workflowId; one secondary index is enough.
WorkflowConcurrencyCounterSchema.index({ workflowId: 1, concurrencyKey: 1 });

let WorkflowConcurrencyCounterModel: mongoose.Model<WorkflowConcurrencyCounter>;
if (mongoose.models.WorkflowConcurrencyCounter) {
  WorkflowConcurrencyCounterModel = mongoose.models
    .WorkflowConcurrencyCounter as mongoose.Model<WorkflowConcurrencyCounter>;
} else {
  WorkflowConcurrencyCounterModel = mongoose.model<WorkflowConcurrencyCounter>(
    'WorkflowConcurrencyCounter',
    WorkflowConcurrencyCounterSchema,
  );
}

export { WorkflowConcurrencyCounterModel };

/** Build the composite `_id` from workflowId + concurrencyKey. */
export function makeCounterId(workflowId: string, concurrencyKey: string): string {
  return `${workflowId}:${concurrencyKey}`;
}
