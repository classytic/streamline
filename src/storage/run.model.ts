import mongoose, { Schema } from 'mongoose';
import type { WorkflowRun, StepState, SchedulingInfo, RecurrencePattern } from '../core/types.js';

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
    endedAt: Date,
    output: Schema.Types.Mixed,
    // Use Mixed for waitingFor and error so they can be completely removed
    waitingFor: { type: Schema.Types.Mixed, required: false },
    error: { type: Schema.Types.Mixed, required: false },
    retryAfter: Date, // Exponential backoff timestamp
  },
  { _id: false }
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
  { _id: false }
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
  { _id: false }
);

const WorkflowRunSchema = new Schema<WorkflowRun>(
  {
    _id: { type: String, required: true },
    workflowId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['draft', 'running', 'waiting', 'done', 'failed', 'cancelled'],
      required: true,
      index: true,
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
    userId: { type: String, index: true },
    tags: [String],
    meta: Schema.Types.Mixed,
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
  }
);

// Core indexes for workflow execution
WorkflowRunSchema.index({ workflowId: 1, status: 1 });
WorkflowRunSchema.index({ status: 1, updatedAt: -1 });
WorkflowRunSchema.index({ userId: 1, createdAt: -1 });
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

// Critical index for scheduled workflow polling (timezone-aware scheduling)
// REQUIRED for scheduled workflows: Supports efficient polling by execution time
// Query pattern: status='draft' AND executionTime <= now AND paused != true
WorkflowRunSchema.index({
  status: 1,
  'scheduling.executionTime': 1,
  paused: 1,
});

// Compound indexes for keyset pagination used by repository getAll/scheduler queries.
// Without these, MongoKit emits warnings and MongoDB does full collection scans.
WorkflowRunSchema.index({ status: 1, paused: 1, updatedAt: -1, _id: -1 });
WorkflowRunSchema.index({ status: 1, paused: 1, updatedAt: 1, _id: 1 });

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

/**
 * Document type for WorkflowRunModel
 * Used for typing Mongoose query filters and operations
 */
export type WorkflowRunDocument = WorkflowRun;
