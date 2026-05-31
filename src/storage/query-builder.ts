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
  // Durable saga / compensation phase (v2.4).
  COMPENSATING: 'compensating',
  COMPENSATED: 'compensated',
  COMPENSATION_FAILED: 'compensation_failed',
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

  /**
   * Match runs blocked on a crash-recoverable `childWorkflow` wait that are
   * due for reconciliation.
   *
   * Unlike timer waits (which carry a `resumeAt` and are woken by the
   * timer-ready sweep) and event/human/webhook waits (woken by an external
   * hook), a `childWorkflow` wait is normally driven to completion by an
   * in-process event-bus listener. After a crash those listeners are gone,
   * so this builder lets a poller reclaim the orphaned wait.
   *
   * Reconcile-cadence gate: rather than re-reconciling every matching run on
   * every poll, we gate on `waitingFor.nextReconcileAt <= reconcileBefore`.
   * The engine bumps `nextReconcileAt` each time it reconciles a
   * still-active child, so a legitimately-blocked parent is revisited at
   * most once per cadence window instead of being hammered. We chose an
   * explicit `nextReconcileAt` field (set in the `waitingFor` Mixed subdoc,
   * so it persists with no schema change) over reusing `updatedAt` because
   * `updatedAt` is bumped by unrelated writes (heartbeats, pause/resume),
   * which would make the cadence unpredictable.
   *
   * When `reconcileBefore` is omitted the `nextReconcileAt` filter is
   * dropped entirely — matching every childWorkflow wait regardless of
   * cadence (used by existence probes like `hasActiveWorkflows`).
   */
  withChildWaiting(reconcileBefore?: Date) {
    const elemMatch: Record<string, unknown> = {
      status: STEP_STATUS.WAITING,
      'waitingFor.type': 'childWorkflow',
    };
    if (reconcileBefore) {
      elemMatch['waitingFor.nextReconcileAt'] = { $lte: reconcileBefore };
    }
    this.query.steps = { $elemMatch: elemMatch };
    return this;
  }

  // Heartbeat/stale detection
  withStaleHeartbeat(thresholdMs: number) {
    const staleTime = new Date(Date.now() - thresholdMs);
    this.query.$or = [{ lastHeartbeat: { $lt: staleTime } }, { lastHeartbeat: { $exists: false } }];
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

  /**
   * Runs blocked on a `childWorkflow` wait that are due for crash-durable
   * reconciliation. See `withChildWaiting` for the cadence rationale.
   * Pass `reconcileBefore` (typically `now`) to honour the cadence gate;
   * omit it to match every childWorkflow wait (existence probes).
   */
  childWaiting: (reconcileBefore?: Date) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.WAITING)
      .notPaused()
      .withChildWaiting(reconcileBefore)
      .build(),

  staleRunning: (thresholdMs: number) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.RUNNING)
      .notPaused()
      .withStaleHeartbeat(thresholdMs)
      .build(),

  /**
   * Runs left in `compensating` whose heartbeat is stale — a crash mid-saga
   * rollback (durable saga, v2.4). Mirrors `staleRunning` but on the
   * `compensating` status. The recovery path re-enters the compensation phase,
   * which skips any per-step compensation already `done` (effectively-once)
   * and resumes from the next pending step in reverse order, derived from a
   * FRESH read of persisted `StepState`. The compensation phase runs with a
   * real heartbeat so this sweep does not race a live, in-flight rollback —
   * only a genuinely crashed one (stale heartbeat) is reclaimed.
   */
  staleCompensating: (thresholdMs: number) =>
    WorkflowQueryBuilder.create()
      .withStatus(RUN_STATUS.COMPENSATING)
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
