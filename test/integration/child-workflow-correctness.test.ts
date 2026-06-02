/**
 * Regression suite for two crash-durability defects in childWorkflow waits
 * (v2.4.0 adversarial review). Both are MISSED by the existing
 * child-workflow-reconciliation suite because that suite only exercises the
 * post-`$set` shape (childRunId already persisted), never the narrow window
 * BEFORE the separate childRunId write.
 *
 * FINDING #1 — double-spawn (duplicate workflow). First entry started the
 *   child with NO idempotencyKey, then persisted childRunId in a SEPARATE
 *   write. A crash between those two writes → re-entry sees `!childRunId` and
 *   starts a SECOND child. FIX: start with a deterministic idempotencyKey
 *   (`${parentRunId}:${parentStepId}:childWorkflow`) so the partial-unique
 *   index returns the race-winner instead of inserting a duplicate.
 *
 * FINDING #2 — wedge-forever (lost run). `handleWait` persisted the
 *   childWorkflow `waiting` step WITHOUT `nextReconcileAt`; the child-waiting
 *   sweep only matches `waitingFor.nextReconcileAt <= now`, and that field was
 *   otherwise stamped only INSIDE the handler. A crash between the wait-write
 *   and the handler → no sweep ever reclaims the run → dead-wait forever. FIX:
 *   `handleWait` stamps an initial `nextReconcileAt = now` for childWorkflow /
 *   branchJoin waits so the run is always reclaimable.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createContainer, createWorkflow, WorkflowRunModel } from '../../src/index.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import { cleanupTestDB, setupTestDB, teardownTestDB, waitUntil } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

let wfCounter = 0;
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${++wfCounter}`;

/**
 * Persist the PRE-`$set` crash shape: a parent `waiting` on a childWorkflow
 * step with NO childRunId yet (the child was never started, or started but the
 * separate childRunId write never landed). `nextReconcileAt` is in the past so
 * the sweep considers it due.
 */
async function persistPreStartParent(opts: {
  parentRunId: string;
  parentWorkflowId: string;
  allStepIds: string[];
  stepId: string;
  childWorkflowId: string;
  childInput: unknown;
}): Promise<void> {
  const now = new Date();
  const steps: StepState[] = opts.allStepIds.map((id) => {
    if (id === opts.stepId) {
      return {
        stepId: id,
        status: 'waiting',
        attempts: 1,
        startedAt: now,
        waitingFor: {
          type: 'childWorkflow',
          reason: `Waiting for child workflow: ${opts.childWorkflowId}`,
          nextReconcileAt: new Date(now.getTime() - 60_000),
          data: {
            childWorkflowId: opts.childWorkflowId,
            childInput: opts.childInput,
            parentRunId: opts.parentRunId,
            parentStepId: opts.stepId,
            // childRunId DELIBERATELY ABSENT — this is the pre-$set window.
          },
        },
      } as StepState;
    }
    return { stepId: id, status: 'pending', attempts: 0 } as StepState;
  });

  await WorkflowRunModel.create({
    _id: opts.parentRunId,
    workflowId: opts.parentWorkflowId,
    status: 'waiting',
    steps,
    currentStepId: opts.stepId,
    context: {},
    input: {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  } as unknown as WorkflowRun);
}

describe('childWorkflow double-spawn (Finding #1)', () => {
  it('sequential re-entry before the childRunId $set spawns the child EXACTLY once', async () => {
    const container = createContainer();
    const childWfId = uniqueId('ds-child');
    const parentWfId = uniqueId('ds-parent');
    const stepId = 'delegate';

    let childStarts = 0;
    const child = createWorkflow(childWfId, {
      steps: {
        work: async () => {
          childStarts++;
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true };
        },
      },
      container,
      // autoExecute default (true): the started child runs immediately and
      // stays active (200ms) across the two near-instant sequential re-entries,
      // so the second start() observes an ACTIVE run for the idempotency key.
    });

    const parent = createWorkflow<{ got?: unknown }>(parentWfId, {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, { v: 1 }),
        finish: async (ctx) => {
          await ctx.set('got', ctx.getOutput(stepId));
          return 'done';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    // Crash-recovery shape: parent is parked on the childWorkflow wait with NO
    // childRunId yet — the child was started but the SEPARATE childRunId $set
    // never landed (crash in that window). Drive the reconcile path twice,
    // SEQUENTIALLY: the FIRST re-entry sees `!childRunId` and starts the child;
    // pre-fix the second re-entry ALSO sees `!childRunId` (the first never got
    // to persist it in this crash shape) and starts a SECOND child. The
    // deterministic idempotency key makes the second start() return the
    // already-active first child instead of inserting a duplicate.
    const parentRunId = uniqueId('ds-parent-run');
    await persistPreStartParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'finish'],
      stepId,
      childWorkflowId: childWfId,
      childInput: { v: 1 },
    });

    // First re-entry — starts the child, then $sets childRunId. To faithfully
    // model the crash (the $set never landed), strip childRunId back out so the
    // second re-entry re-enters the `!childRunId` branch.
    await parent.engine.resume(parentRunId);
    await WorkflowRunModel.updateOne(
      { _id: parentRunId },
      { $unset: { [`steps.0.waitingFor.data.childRunId`]: '' } },
    );

    // Second re-entry — pre-fix this spawns a 2nd child; post-fix the
    // idempotency key returns the existing active child.
    await parent.engine.resume(parentRunId);

    // EXACTLY ONE child run exists for this parent step.
    const childRuns = await WorkflowRunModel.find({ workflowId: childWfId }).lean();
    expect(childRuns).toHaveLength(1);
    // And the child handler ran exactly once.
    expect(childStarts).toBe(1);

    // Drain background work: the single child finishes and resumes the parent.
    // Awaiting it prevents a post-teardown "Client must be connected" write.
    await waitUntil(async () => {
      const r = await parent.get(parentRunId);
      return r?.status === 'done';
    }, 10_000);

    parent.shutdown();
    child.shutdown();
  });
});

describe('childWorkflow wedge-forever (Finding #2)', () => {
  it('the wait-write itself stamps nextReconcileAt so the sweep can reclaim a crashed-handler run', async () => {
    const container = createContainer();
    // Child workflow id that is NEVER registered. handleChildWorkflowWait's
    // first-entry then early-returns (engine-not-found) WITHOUT reaching its
    // own nextReconcileAt $set — so the ONLY nextReconcileAt on the persisted
    // wait is the one `handleWait` seeded. This isolates the fix: pre-fix the
    // wait carries NO nextReconcileAt and the sweep can never select it
    // (dead-wait forever); post-fix the seed makes it immediately selectable.
    const unregisteredChildId = uniqueId('wf-never-registered');
    const parentWfId = uniqueId('wf-parent');
    const stepId = 'delegate';

    const parent = createWorkflow(parentWfId, {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(unregisteredChildId, {}),
        finish: async () => 'ok',
      },
      container,
      autoExecute: false,
    });

    const parentRun = await parent.start({});
    await parent.execute(parentRun._id); // parks waiting; handler early-returns

    const parked = await parent.get(parentRun._id);
    expect(parked?.status).toBe('waiting');

    // The wait-write (handleWait) must have stamped an initial nextReconcileAt
    // (≈ now). The handler never reached its own bump (child not registered).
    const persisted = await WorkflowRunModel.findById(parentRun._id).lean();
    const waitingFor = persisted?.steps?.[0]?.waitingFor as { nextReconcileAt?: Date } | undefined;
    expect(waitingFor?.nextReconcileAt).toBeDefined();

    // The child-waiting sweep (the ONLY reclaim path after a crashed handler)
    // must therefore be able to SELECT this run with `nextReconcileAt <= now`.
    // Pre-fix, with no nextReconcileAt, the $lte filter never matched → the run
    // dead-waited forever.
    const due = await workflowRunRepository.getChildWaitingRuns(new Date(Date.now() + 1_000), 100, {
      bypassTenant: true,
    });
    expect(due.map((r) => r._id)).toContain(parentRun._id);

    parent.shutdown();
  });
});

describe('childWorkflow adopt-terminal (convergence follow-up — terminal-child re-spawn window)', () => {
  it('first-entry adopts an ALREADY-TERMINAL child by deterministic key instead of spawning a 2nd', async () => {
    const container = createContainer();
    const childWfId = uniqueId('adopt-child');
    const parentWfId = uniqueId('adopt-parent');
    const stepId = 'delegate';

    let childStarts = 0;
    const child = createWorkflow(childWfId, {
      steps: {
        work: async () => {
          childStarts++;
          return { ok: true };
        },
      },
      container,
      autoExecute: false,
    });

    const parent = createWorkflow<{ got?: unknown }>(parentWfId, {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, { v: 1 }),
        finish: async (ctx) => {
          await ctx.set('got', ctx.getOutput(stepId));
          return 'done';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    const parentRunId = uniqueId('adopt-parent-run');
    const childKey = `${parentRunId}:${stepId}:childWorkflow`;

    // Seed an ALREADY-TERMINAL child carrying the deterministic key — the shape
    // after a crash post-start / pre-childRunId-write where the child ALSO
    // finished before recovery re-entered. `findActiveByIdempotencyKey` excludes
    // terminal states, so a plain start() would spawn a SECOND child; the
    // adopt-by-any-status lookup must reuse this one.
    const terminalChildId = uniqueId('adopt-child-run');
    await WorkflowRunModel.create({
      _id: terminalChildId,
      workflowId: childWfId,
      status: 'done',
      idempotencyKey: childKey,
      output: { ok: true, adopted: true },
      steps: [
        { stepId: 'work', status: 'done', attempts: 1, output: { ok: true, adopted: true } },
      ],
      currentStepId: 'work',
      context: {},
      input: { v: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      endedAt: new Date(),
    } as unknown as WorkflowRun);

    await persistPreStartParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'finish'],
      stepId,
      childWorkflowId: childWfId,
      childInput: { v: 1 },
    });

    // First re-entry: must ADOPT the terminal child (not spawn a 2nd).
    await parent.engine.resume(parentRunId);

    const childRuns = await WorkflowRunModel.find({ workflowId: childWfId }).lean();
    expect(childRuns).toHaveLength(1); // adopted, not duplicated
    expect(childRuns[0]?._id).toBe(terminalChildId);
    expect(childStarts).toBe(0); // the seeded terminal child's handler never re-ran

    // Re-entry reconciles the (terminal) adopted child → parent resumes with its output.
    await parent.engine.resume(parentRunId);
    await waitUntil(async () => (await parent.get(parentRunId))?.status === 'done', 10_000);
    const finalParent = await parent.get(parentRunId);
    expect(finalParent?.status).toBe('done');
    expect((finalParent?.context as { got?: { adopted?: boolean } })?.got?.adopted).toBe(true);

    parent.shutdown();
    child.shutdown();
  });
});
