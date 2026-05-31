/**
 * Unit tests for the crash-durable childWorkflow reconciliation query.
 *
 * Pure filter-shape assertions — no DB. Proves:
 *   - `WorkflowQueryBuilder.withChildWaiting()` builds the right $elemMatch.
 *   - `CommonQueries.childWaiting()` composes status + notPaused + the
 *     childWorkflow elemMatch, with the reconcile-cadence gate.
 *
 * The regression these guard: a parent suspended on a childWorkflow wait has
 * no `resumeAt`/`retryAfter` and isn't `running`, so it matches NONE of the
 * existing scheduler queries — it dead-waits after a crash. This query is the
 * sweep that reclaims it.
 */

import { describe, expect, it } from 'vitest';
import { CommonQueries, WorkflowQueryBuilder } from '../../src/storage/query-builder.js';

describe('WorkflowQueryBuilder.withChildWaiting', () => {
  it('builds an $elemMatch on a waiting childWorkflow step (no cadence gate when reconcileBefore omitted)', () => {
    const query = WorkflowQueryBuilder.create().withChildWaiting().build();

    expect(query).toEqual({
      steps: {
        $elemMatch: {
          status: 'waiting',
          'waitingFor.type': 'childWorkflow',
        },
      },
    });
    // No nextReconcileAt clause when reconcileBefore is absent.
    expect(query.steps.$elemMatch['waitingFor.nextReconcileAt']).toBeUndefined();
  });

  it('adds the reconcile-cadence gate when reconcileBefore is supplied', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const query = WorkflowQueryBuilder.create().withChildWaiting(now).build();

    expect(query).toEqual({
      steps: {
        $elemMatch: {
          status: 'waiting',
          'waitingFor.type': 'childWorkflow',
          'waitingFor.nextReconcileAt': { $lte: now },
        },
      },
    });
  });
});

describe('CommonQueries.childWaiting', () => {
  it('composes status=waiting + notPaused + the gated childWorkflow elemMatch', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const query = CommonQueries.childWaiting(now);

    expect(query).toEqual({
      status: 'waiting',
      paused: { $ne: true },
      steps: {
        $elemMatch: {
          status: 'waiting',
          'waitingFor.type': 'childWorkflow',
          'waitingFor.nextReconcileAt': { $lte: now },
        },
      },
    });
  });

  it('omits the cadence gate when called without an argument (existence probe shape)', () => {
    const query = CommonQueries.childWaiting();

    expect(query).toEqual({
      status: 'waiting',
      paused: { $ne: true },
      steps: {
        $elemMatch: {
          status: 'waiting',
          'waitingFor.type': 'childWorkflow',
        },
      },
    });
  });

  it('does NOT match timer waits — distinct from readyToResume', () => {
    const child = CommonQueries.childWaiting(new Date());
    const timer = CommonQueries.readyToResume(new Date());

    expect(child.steps.$elemMatch['waitingFor.type']).toBe('childWorkflow');
    expect(timer.steps.$elemMatch['waitingFor.type']).toBe('timer');
    // The childWaiting query intentionally has no resumeAt clause — that's the
    // whole reason timer-ready never reclaims a childWorkflow wait.
    expect(child.steps.$elemMatch['waitingFor.resumeAt']).toBeUndefined();
  });
});
