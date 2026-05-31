/**
 * Integration regression suite for crash-durable childWorkflow reconciliation.
 *
 * THE BUG (data-loss): a run suspended on `ctx.startChildWorkflow()` →
 * `WaitSignal('childWorkflow')` is woken ONLY by in-process event-bus
 * listeners registered in the engine. After a process crash/restart those
 * listeners are gone. The parent is `status:'waiting'` with a step
 * `waitingFor.type:'childWorkflow'` and `waitingFor.data.childRunId` set —
 * but no scheduler sweep reclaimed it (no `resumeAt`/`retryAfter`, not
 * `running`) and the engine's childWorkflow branch only acted when
 * `!childRunId`. The parent dead-waited forever.
 *
 * THE FIX: `CommonQueries.childWaiting` + `getChildWaitingRuns` + the
 * scheduler's child-waiting sweep call `engine.resume(runId)` (no payload),
 * which now RECONCILES against the child run instead of completing the step
 * with `undefined`. If the child is terminal → resume parent with its output
 * (done) or `{ __childFailed, error }` (failed). If still active → re-arm
 * listeners + bump `nextReconcileAt`.
 *
 * Crash simulation: we never let the parent engine auto-start the child (that
 * path registers the in-process listeners). Instead we manually persist the
 * parent's `waiting` childWorkflow step (with `childRunId` + a due
 * `nextReconcileAt`) and run the child on a SEPARATE engine. No listener is
 * watching, exactly like a fresh process after a crash. Then we invoke the
 * reconciliation path (`engine.resume`, the same verb the scheduler's sweep
 * calls) and assert the parent resumes to completion with the child output.
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
 * Persist a parent run that is `waiting` on a childWorkflow step whose child
 * has ALREADY been started (childRunId set) — i.e. the post-crash shape the
 * old code could never recover. `nextReconcileAt` is in the past so the
 * reconcile sweep considers it due.
 */
async function persistOrphanedParent(opts: {
  parentRunId: string;
  parentWorkflowId: string;
  /** All step ids in definition order. The childWorkflow-waiting step is
   *  `stepId`; everything after it is seeded `pending` — mirroring exactly
   *  what `engine.start()` materialises (all step states up front). */
  allStepIds: string[];
  stepId: string;
  childWorkflowId: string;
  childRunId: string;
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
          // nextReconcileAt in the past → due for reconciliation.
          nextReconcileAt: new Date(now.getTime() - 60_000),
          data: {
            childWorkflowId: opts.childWorkflowId,
            childInput: opts.childInput,
            parentRunId: opts.parentRunId,
            parentStepId: opts.stepId,
            childRunId: opts.childRunId,
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

describe('childWorkflow crash-durable reconciliation', () => {
  it('resumes an orphaned parent (no listener) once the DONE child is reconciled', async () => {
    const container = createContainer();
    const childWfId = uniqueId('recon-child');
    const parentWfId = uniqueId('recon-parent');
    const stepId = 'delegate';

    // Child workflow — produces an output we can assert flowed into the parent.
    const child = createWorkflow<{ doubled: number }>(childWfId, {
      steps: {
        compute: async (ctx) => {
          const input = ctx.input as { value: number };
          return { result: input.value * 2 };
        },
      },
      context: () => ({ doubled: 0 }),
      container,
    });

    // Parent workflow — second step consumes the child output.
    const parent = createWorkflow<{ childResult?: unknown }>(parentWfId, {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, { value: 21 }),
        finish: async (ctx) => {
          await ctx.set('childResult', ctx.getOutput(stepId));
          return 'done';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    // Run the child to completion on its own engine — NO parent listener is
    // attached (we never let the parent auto-start it). This is the crash:
    // the child finished while the parent's in-process listeners were gone.
    const childRun = await child.start({ value: 21 });
    const doneChild = await waitUntil(async () => {
      const r = await child.get(childRun._id);
      return r?.status === 'done';
    }, 10_000);
    expect(doneChild).toBe(true);

    // Manually persist the orphaned parent (the post-crash DB shape).
    const parentRunId = uniqueId('parent-run');
    await persistOrphanedParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'finish'],
      stepId,
      childWorkflowId: childWfId,
      childRunId: childRun._id,
      childInput: { value: 21 },
    });

    // Sanity: the orphaned parent is exactly what CommonQueries.childWaiting
    // selects, and NOTHING else (timer/retry sweeps) would have reclaimed it.
    const due = await workflowRunRepository.getChildWaitingRuns(new Date(), 100, {
      bypassTenant: true,
    });
    expect(due.map((r) => r._id)).toContain(parentRunId);

    // Invoke the reconciliation path — the same verb the scheduler's
    // child-waiting sweep calls (resume with no payload).
    await parent.engine.resume(parentRunId);

    const final = await parent.get(parentRunId);
    expect(final?.status).toBe('done');
    // The child output must have flowed into the parent's second step.
    expect(final?.context.childResult).toEqual({ result: 42 });

    parent.shutdown();
    child.shutdown();
  });

  it('reconciles a FAILED child into the parent as __childFailed', async () => {
    const container = createContainer();
    const childWfId = uniqueId('recon-failchild');
    const parentWfId = uniqueId('recon-failparent');
    const stepId = 'delegate';

    const child = createWorkflow(childWfId, {
      steps: {
        boom: async () => {
          throw new Error('child blew up');
        },
      },
      defaults: { retries: 0 },
      container,
    });

    // Parent's next step inspects the child result; a __childFailed marker
    // makes the parent itself fail (mirrors the in-process fail handler).
    const parent = createWorkflow(parentWfId, {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, {}),
        finish: async (ctx) => {
          const out = ctx.getOutput(stepId) as { __childFailed?: boolean } | undefined;
          if (out?.__childFailed) throw new Error('child failed — propagating');
          return 'ok';
        },
      },
      defaults: { retries: 0 },
      container,
      autoExecute: false,
    });

    const childRun = await child.start({});
    const failed = await waitUntil(async () => {
      const r = await child.get(childRun._id);
      return r?.status === 'failed';
    }, 10_000);
    expect(failed).toBe(true);

    const parentRunId = uniqueId('failparent-run');
    await persistOrphanedParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'finish'],
      stepId,
      childWorkflowId: childWfId,
      childRunId: childRun._id,
      childInput: {},
    });

    await parent.engine.resume(parentRunId);

    const final = await parent.get(parentRunId);
    // The reconciliation delivered { __childFailed: true } as the step output,
    // so the parent's finish step threw → run failed.
    expect(final?.status).toBe('failed');

    parent.shutdown();
    child.shutdown();
  });

  it('leaves the parent WAITING and bumps nextReconcileAt when the child is still active', async () => {
    const container = createContainer();
    const childWfId = uniqueId('recon-slowchild');
    const parentWfId = uniqueId('recon-slowparent');
    const stepId = 'delegate';

    // Child that stays running long enough to be observed mid-flight.
    const child = createWorkflow(childWfId, {
      steps: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 3_000));
          return 'late';
        },
      },
      container,
      autoExecute: false,
    });

    const parent = createWorkflow(parentWfId, {
      steps: {
        [stepId]: async (ctx) => ctx.startChildWorkflow(childWfId, {}),
        finish: async () => 'ok',
      },
      container,
      autoExecute: false,
    });

    // Start the child but DON'T await completion — it's still running.
    const childRun = await child.start({});
    // Kick execution without awaiting (autoExecute:false means start doesn't run it).
    const childExec = child.execute(childRun._id);

    const parentRunId = uniqueId('slowparent-run');
    await persistOrphanedParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'finish'],
      stepId,
      childWorkflowId: childWfId,
      childRunId: childRun._id,
      childInput: {},
    });

    const before = await WorkflowRunModel.findById(parentRunId).lean();
    const beforeReconcileAt = (before?.steps?.[0]?.waitingFor as { nextReconcileAt?: Date })
      ?.nextReconcileAt;

    // Reconcile while the child is still active.
    await parent.engine.resume(parentRunId);

    const after = await parent.get(parentRunId);
    expect(after?.status).toBe('waiting');

    // nextReconcileAt must have been pushed into the future (cadence bump).
    const dbAfter = await WorkflowRunModel.findById(parentRunId).lean();
    const afterReconcileAt = (dbAfter?.steps?.[0]?.waitingFor as { nextReconcileAt?: Date })
      ?.nextReconcileAt;
    expect(afterReconcileAt).toBeDefined();
    expect(new Date(afterReconcileAt as Date).getTime()).toBeGreaterThan(
      new Date(beforeReconcileAt as Date).getTime(),
    );

    // Let the child finish so we don't leak a dangling promise.
    await childExec;
    parent.shutdown();
    child.shutdown();
  });

  it('double-resume safety: in-memory listener + reconciliation poll → exactly one resume', async () => {
    // Here we let the parent engine auto-start the child (registers the
    // in-process listener), THEN also fire the reconciliation poll. The
    // waiting→running claim must make exactly one of them win — the parent
    // completes once, with the correct child output, and never double-runs.
    const container = createContainer();
    const childWfId = uniqueId('dr-child');
    const parentWfId = uniqueId('dr-parent');

    let finishRuns = 0;

    const child = createWorkflow(childWfId, {
      steps: {
        work: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { v: 7 };
        },
      },
      container,
    });

    const parent = createWorkflow<{ got?: unknown }>(parentWfId, {
      steps: {
        delegate: async (ctx) => ctx.startChildWorkflow(childWfId, {}),
        finish: async (ctx) => {
          finishRuns++;
          await ctx.set('got', ctx.getOutput('delegate'));
          return 'done';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    const parentRun = await parent.start({});
    await parent.execute(parentRun._id);

    // Parent is now waiting with the in-process listener armed and childRunId
    // persisted. Force a reconciliation poll concurrently with the listener.
    // Make the step due for reconcile so resume() doesn't no-op on cadence.
    await parent.engine.resume(parentRun._id).catch(() => {
      /* lost the race — expected and fine */
    });

    const completed = await waitUntil(async () => {
      const r = await parent.get(parentRun._id);
      return r?.status === 'done';
    }, 10_000);
    expect(completed).toBe(true);

    const final = await parent.get(parentRun._id);
    expect(final?.status).toBe('done');
    expect(final?.context.got).toEqual({ v: 7 });
    // The finish step ran EXACTLY once despite two resume drivers.
    expect(finishRuns).toBe(1);

    parent.shutdown();
    child.shutdown();
  });
});
