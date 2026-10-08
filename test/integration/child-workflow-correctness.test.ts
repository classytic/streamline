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

import { describe, expect, it } from 'vitest';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import type { WorkflowLike } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/**
 * Persist the PRE-`$set` crash shape: a parent `waiting` on a childWorkflow
 * step with NO childRunId yet (the child was never started, or started but the
 * separate childRunId write never landed). `nextReconcileAt` is in the past so
 * the sweep considers it due.
 */
async function persistPreStartParent(
  parent: WorkflowLike,
  opts: { stepId: string; childWorkflowId: string; childInput: unknown },
): Promise<WorkflowRun> {
  const now = new Date();
  const parentRunId = `${parent.engine.definition.id}-run`; // the workflow id is unique per env
  const steps: StepState[] = parent.engine.definition.steps.map(({ id }) => {
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
            parentRunId,
            parentStepId: opts.stepId,
            // childRunId DELIBERATELY ABSENT — this is the pre-$set window.
          },
        },
      } as StepState;
    }
    return { stepId: id, status: 'pending', attempts: 0 } as StepState;
  });

  return env.runs.insert(parent, {
    _id: parentRunId,
    status: 'waiting',
    steps,
    currentStepId: opts.stepId,
    startedAt: now,
  });
}

describe('childWorkflow double-spawn (Finding #1)', () => {
  it('sequential re-entry before the childRunId $set spawns the child EXACTLY once', async () => {
    const stepId = 'delegate';

    let childStarts = 0;
    const child = env.workflow('ds-child', {
      steps: {
        work: async () => {
          childStarts++;
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true };
        },
      },
      // autoExecute (true): the started child runs immediately and stays
      // active (200ms) across the two near-instant sequential re-entries, so
      // the second start() observes an ACTIVE run for the idempotency key.
      autoExecute: true,
    });
    const childWfId = child.engine.definition.id;

    const parent = env.workflow<{ got?: unknown }>('ds-parent', {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, { v: 1 }),
        finish: async (ctx) => {
          await ctx.set('got', ctx.getOutput(stepId));
          return 'done';
        },
      },
      context: () => ({}),
    });

    // Crash-recovery shape: parent is parked on the childWorkflow wait with NO
    // childRunId yet — the child was started but the SEPARATE childRunId $set
    // never landed (crash in that window). Drive the reconcile path twice,
    // SEQUENTIALLY: the FIRST re-entry sees `!childRunId` and starts the child;
    // pre-fix the second re-entry ALSO sees `!childRunId` (the first never got
    // to persist it in this crash shape) and starts a SECOND child. The
    // deterministic idempotency key makes the second start() return the
    // already-active first child instead of inserting a duplicate.
    const { _id: parentRunId } = await persistPreStartParent(parent, {
      stepId,
      childWorkflowId: childWfId,
      childInput: { v: 1 },
    });

    // First re-entry — starts the child, then $sets childRunId. To faithfully
    // model the crash (the $set never landed), strip childRunId back out so the
    // second re-entry re-enters the `!childRunId` branch.
    await parent.engine.resume(parentRunId);
    await env.runs.update(parentRunId, {
      $unset: { [`steps.0.waitingFor.data.childRunId`]: '' },
    });

    // Second re-entry — pre-fix this spawns a 2nd child; post-fix the
    // idempotency key returns the existing active child.
    await parent.engine.resume(parentRunId);

    // EXACTLY ONE child run exists for this parent step.
    const childRuns = await env.runModel.find({ workflowId: childWfId }).lean();
    expect(childRuns).toHaveLength(1);
    // And the child handler ran exactly once.
    expect(childStarts).toBe(1);

    // Drain background work: the single child finishes and resumes the parent.
    // Awaiting it prevents a post-teardown "Client must be connected" write.
    await env.until(parentRunId, 'done', { timeout: 10_000 });
  });
});

describe('childWorkflow wedge-forever (Finding #2)', () => {
  it('the wait-write itself stamps nextReconcileAt so the sweep can reclaim a crashed-handler run', async () => {
    // Child workflow id that is NEVER registered. handleChildWorkflowWait's
    // first-entry then early-returns (engine-not-found) WITHOUT reaching its
    // own nextReconcileAt $set — so the ONLY nextReconcileAt on the persisted
    // wait is the one `handleWait` seeded. This isolates the fix: pre-fix the
    // wait carries NO nextReconcileAt and the sweep can never select it
    // (dead-wait forever); post-fix the seed makes it immediately selectable.
    const unregisteredChildId = `wf-never-registered-${Date.now()}`;
    const stepId = 'delegate';

    const parent = env.workflow('wf-parent', {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(unregisteredChildId, {}),
        finish: async () => 'ok',
      },
    });

    const parentRun = await parent.start({});
    await parent.execute(parentRun._id); // parks waiting; handler early-returns

    const parked = await parent.get(parentRun._id);
    expect(parked?.status).toBe('waiting');

    // The wait-write (handleWait) must have stamped an initial nextReconcileAt
    // (≈ now). The handler never reached its own bump (child not registered).
    const persisted = await env.runs.get(parentRun._id);
    const waitingFor = persisted?.steps?.[0]?.waitingFor as { nextReconcileAt?: Date } | undefined;
    expect(waitingFor?.nextReconcileAt).toBeDefined();

    // The child-waiting sweep (the ONLY reclaim path after a crashed handler)
    // must therefore be able to SELECT this run with `nextReconcileAt <= now`.
    // Pre-fix, with no nextReconcileAt, the $lte filter never matched → the run
    // dead-waited forever.
    const due = await env.container.repository.getChildWaitingRuns(
      new Date(Date.now() + 1_000),
      100,
      { bypassTenant: true },
    );
    expect(due.map((r) => r._id)).toContain(parentRun._id);
  });
});

describe('childWorkflow adopt-terminal (convergence follow-up — terminal-child re-spawn window)', () => {
  it('first-entry adopts an ALREADY-TERMINAL child by deterministic key instead of spawning a 2nd', async () => {
    const stepId = 'delegate';

    let childStarts = 0;
    const child = env.workflow('adopt-child', {
      steps: {
        work: async () => {
          childStarts++;
          return { ok: true };
        },
      },
    });
    const childWfId = child.engine.definition.id;

    const parent = env.workflow<{ got?: unknown }>('adopt-parent', {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, { v: 1 }),
        finish: async (ctx) => {
          await ctx.set('got', ctx.getOutput(stepId));
          return 'done';
        },
      },
      context: () => ({}),
    });

    const { _id: parentRunId } = await persistPreStartParent(parent, {
      stepId,
      childWorkflowId: childWfId,
      childInput: { v: 1 },
    });
    const childKey = `${parentRunId}:${stepId}:childWorkflow`;

    // Seed an ALREADY-TERMINAL child carrying the deterministic key — the shape
    // after a crash post-start / pre-childRunId-write where the child ALSO
    // finished before recovery re-entered. `findActiveByIdempotencyKey` excludes
    // terminal states, so a plain start() would spawn a SECOND child; the
    // adopt-by-any-status lookup must reuse this one.
    const now = new Date();
    const { _id: terminalChildId } = await env.runs.insert(child, {
      status: 'done',
      idempotencyKey: childKey,
      output: { ok: true, adopted: true },
      steps: [{ stepId: 'work', status: 'done', attempts: 1, output: { ok: true, adopted: true } }],
      currentStepId: 'work',
      input: { v: 1 },
      startedAt: now,
      endedAt: now,
    });

    // First re-entry: must ADOPT the terminal child (not spawn a 2nd).
    await parent.engine.resume(parentRunId);

    const childRuns = await env.runModel.find({ workflowId: childWfId }).lean();
    expect(childRuns).toHaveLength(1); // adopted, not duplicated
    expect(childRuns[0]?._id).toBe(terminalChildId);
    expect(childStarts).toBe(0); // the seeded terminal child's handler never re-ran

    // Re-entry reconciles the (terminal) adopted child → parent resumes with its output.
    await parent.engine.resume(parentRunId);
    const finalParent = await env.until(parentRunId, 'done', { timeout: 10_000 });
    expect(finalParent.status).toBe('done');
    expect((finalParent.context as { got?: { adopted?: boolean } })?.got?.adopted).toBe(true);
  });
});
