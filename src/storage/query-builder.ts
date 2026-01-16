/**
 * Type-safe MongoDB query builder for workflow operations.
 * Provides fluent API for constructing common workflow queries.
 */

import type { FilterQuery } from '@classytic/mongokit';
import type { RunStatus, StepStatus } from '../core/types.js';

// ============================================================================
// Status Constants (for autocomplete and typo prevention)
// ============================================================================

export const RUN_STATUS = {
  DRAFT: 'draft',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const satisfies Record<string, RunStatus>;

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const satisfies Record<string, StepStatus>;

// ============================================================================
// Query Builder
// ============================================================================

export class WorkflowQueryBuilder {
  private query: FilterQuery = {};

  static create() {
    return new WorkflowQueryBuilder();
  }

  // Status filters
  withStatus(status: RunStatus | RunStatus[]) {
    this.query.status = Array.isArray(status) ? { $in: status } : status;
    return this;
  }

  notPaused() {
    this.query.paused = { $ne: true };
    return this;
  }

  isPaused() {
    this.query.paused = true;
    return this;
  }

  // Identity filters
  withWorkflowId(workflowId: string) {
    this.query.workflowId = workflowId;
    return this;
  }

  withRunId(runId: string) {
    this.query._id = runId;
    return this;
  }

  withUserId(userId: string) {
    this.query.userId = userId;
    return this;
  }

  withTags(tags: string | string[]) {
    this.query.tags = Array.isArray(tags) ? { $all: tags } : tags;
    return this;
  }

  // Step-based filters
  withStepReady(stepStatus: StepStatus, field: string, beforeTime: Date) {
    this.query.steps = {
      $elemMatch: {
        status: stepStatus,
        [field]: { $lte: beforeTime },
      },
    };
    return this;
  }

  withRetryReady(now = new Date()) {
    return this.withStepReady(STEP_STATUS.PENDING, 'retryAfter', now);
  }

  withTimerReady(now = new Date()) {
    this.query.steps = {
      $elemMatch: {
        status: STEP_STATUS.WAITING,
        'waitingFor.type': 'timer',
        'waitingFor.resumeAt': { $lte: now },
      },
    };
    return this;
  }

  // Heartbeat/stale detection
  withStaleHeartbeat(thresholdMs: number) {
    const staleTime = new Date(Date.now() - thresholdMs);
    this.query.$or = [
      { lastHeartbeat: { $lt: staleTime } },
      { lastHeartbeat: { $exists: false } },
    ];
    return this;
  }

  // Scheduling filters
  withScheduledBefore(time: Date) {
    this.query['scheduling.executionTime'] = { $lte: time };
    return this;
  }

  withScheduledAfter(time: Date) {
    this.query['scheduling.executionTime'] = { $gte: time };
    return this;
  }

  // Date range filters
  createdBefore(date: Date) {
    const existing = (this.query.createdAt ?? {}) as Record<string, unknown>;
    this.query.createdAt = { ...existing, $lte: date };
    return this;
  }

  createdAfter(date: Date) {
    const existing = (this.query.createdAt ?? {}) as Record<string, unknown>;
    this.query.createdAt = { ...existing, $gte: date };
    return this;
  }

  // Custom conditions
  where(conditions: Record<string, unknown>) {
    Object.assign(this.query, conditions);
    return this;
  }

  // Build
  build(): FilterQuery {
    return this.query;
  }
}

// ============================================================================
// Pre-built Queries
// ============================================================================

export const CommonQueries = {
  active: () =>
    WorkflowQueryBuilder.create()
      .withStatus([RUN_STATUS.RUNNING, RUN_STATUS.WAITING])
      .notPaused()
      .build(),

  readyForRetry: (now?: Date) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.WAITING)
      .notPaused()
      .withRetryReady(now)
      .build(),

  readyToResume: (now?: Date) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.WAITING)
      .notPaused()
      .withTimerReady(now)
      .build(),

  staleRunning: (thresholdMs: number) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.RUNNING)
      .notPaused()
      .withStaleHeartbeat(thresholdMs)
      .build(),

  scheduledReady: (now?: Date) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.DRAFT)
      .notPaused()
      .withScheduledBefore(now ?? new Date())
      .build(),

  byUser: (userId: string, status?: RunStatus | RunStatus[]) => {
    const builder = WorkflowQueryBuilder.create().withUserId(userId);
    return status ? builder.withStatus(status).build() : builder.build();
  },

  failed: () => WorkflowQueryBuilder.create().withStatus(RUN_STATUS.FAILED).build(),

  completed: () => WorkflowQueryBuilder.create().withStatus(RUN_STATUS.DONE).build(),
};
