import { TIMING } from '../config/constants.js';
import type { StreamlineContainer } from '../core/container.js';
import type { StepState, WorkflowRun } from '../core/types.js';
import type { WorkflowEngine } from './engine.js';
import { workflowRegistry } from './registries.js';

/**
 * Minimal view of `WorkflowEngine` the child-workflow wait helpers need.
 * Extracted so `handleChildWorkflowWait` / `registerChildCompletionListeners`
 * can live in a focused module while reaching exactly the engine collaborators
 * they used as private methods — no behavior change, just a relocation.
 */
export interface ChildWorkflowEngine<TContext> {
  readonly container: StreamlineContainer;
  get(runId: string): Promise<WorkflowRun<TContext> | null>;
  resume(runId: string, payload?: unknown): Promise<WorkflowRun<TContext>>;
}

function findCurrentStep<TContext>(run: WorkflowRun<TContext>): StepState | undefined {
  return run.steps.find((s) => s.stepId === run.currentStepId);
}

/**
 * Handle a `childWorkflow` wait — crash-durable.
 *
 * Two entry shapes share this method:
 *
 *   1. **First entry** (`childRunId` not yet set) — auto-start the child,
 *      persist its `childRunId`, register the in-process completion
 *      listeners, and stamp `nextReconcileAt` so the scheduler can reclaim
 *      the wait if this process dies before the listener fires.
 *
 *   2. **Re-entry / reconciliation** (`childRunId` already set) — the
 *      previous handler's in-memory listeners may be gone (process crash/
 *      restart) or the scheduler's child-waiting sweep re-drove the wait.
 *      Look the child up: if it's terminal, resume the parent directly
 *      (done → child output; failed → `{ __childFailed, error }`), exactly
 *      like the listeners would have. If the child is still active,
 *      re-register the listeners (so same-process completion still fires)
 *      and bump `nextReconcileAt` so the poller revisits later.
 *
 * Idempotency / race-safety: every resume path goes through
 * `engine.resume(runId, …)`, whose `waiting → running` atomic claim
 * (`resumeStep` / the RUN_MACHINE-guarded executor write) lets exactly one
 * caller win. A concurrent in-memory listener, a second polling worker, and
 * this reconciliation can all fire — the losers no-op when the step is no
 * longer `waiting`.
 *
 * Scoped to `childWorkflow`; the `nextReconcileAt` cadence + the generic
 * `withChildWaiting` query are shaped so later slices can extend the same
 * machinery to `gate` / `branchJoin` waits.
 */
export async function handleChildWorkflowWait<TContext>(
  engine: ChildWorkflowEngine<TContext>,
  runId: string,
  run: WorkflowRun<TContext>,
): Promise<void> {
  const stepState = findCurrentStep(run);
  const data = stepState?.waitingFor?.data as
    | {
        childWorkflowId: string;
        childInput: unknown;
        parentRunId: string;
        parentStepId: string;
        childRunId?: string;
      }
    | undefined;

  if (!data?.childWorkflowId) return;

  const childEngine = workflowRegistry.getEngine(data.childWorkflowId);
  if (!childEngine) {
    // Child engine not found — emit guidance. (Same message as before.)
    engine.container.eventBus.emit('engine:error', {
      runId,
      error: new Error(
        `Child workflow '${data.childWorkflowId}' not registered. ` +
          `Ensure the child workflow is created with createWorkflow() before the parent starts. ` +
          `Or resume the parent manually when the child completes.`,
      ),
      context: 'child-workflow-not-found',
    });
    return;
  }

  const stepIndex = run.steps.findIndex((s) => s.stepId === run.currentStepId);

  // ---- First entry: no child started yet ----
  if (!data.childRunId) {
    // Deterministic idempotency key — a crash AFTER start() but BEFORE the
    // separate $set of childRunId would otherwise re-spawn a 2nd child on
    // re-entry. The key makes the child's partial-unique index return the
    // race-winner instead of inserting a duplicate (mirrors branchJoin's
    // `branchIdempotencyKey` in ./parallel-steps.ts).
    const childIdempotencyKey = `${data.parentRunId}:${data.parentStepId}:childWorkflow`;
    // ADOPT an existing child for this deterministic key if one exists in ANY
    // status. Covers the crash-after-start-before-childRunId-write window where
    // the child may ALREADY be terminal: start()'s active-only idempotency dedup
    // would miss a terminal child and spawn a 2nd one (double execution). The
    // sparse {idempotencyKey,status} index keeps this lookup cheap. A terminal
    // adopted child is reconciled by the re-entry/sweep path (childRunId is set
    // below + nextReconcileAt seeded), so the parent still resumes correctly.
    const existingChild = await childEngine.container.repository.getOne(
      { idempotencyKey: childIdempotencyKey },
      { bypassTenant: true },
    );
    const childRun =
      existingChild ??
      (await childEngine.start(data.childInput, {
        idempotencyKey: childIdempotencyKey,
        bypassTenant: true,
      }));

    // Persist childRunId AND the initial reconcile cadence in one write so
    // a crash immediately after start still leaves a poll-reclaimable wait.
    if (stepIndex !== -1) {
      await engine.container.repository.updateOne(
        { _id: runId },
        {
          $set: {
            [`steps.${stepIndex}.waitingFor.data.childRunId`]: childRun._id,
            [`steps.${stepIndex}.waitingFor.nextReconcileAt`]: new Date(
              Date.now() + TIMING.CHILD_RECONCILE_INTERVAL_MS,
            ),
          },
        },
        { bypassTenant: true },
      );
    }

    registerChildCompletionListeners(engine, runId, childRun._id, childEngine);
    return;
  }

  // ---- Re-entry: child already started, reconcile its state ----
  const childRunId = data.childRunId;
  const child = await childEngine.get(childRunId);

  if (child && (child.status === 'done' || child.status === 'failed')) {
    // Terminal child — resume the parent exactly like the listeners would.
    // The waiting→running claim inside resume() guards against a concurrent
    // listener / poller double-resuming.
    try {
      if (child.status === 'done') {
        const output = child.output ?? child.context;
        await engine.resume(runId, output);
      } else {
        await engine.resume(runId, { __childFailed: true, error: child.error });
      }
    } catch {
      // Lost the resume race (already resumed/cancelled) — no-op.
    }
    return;
  }

  // Child still active (or not yet readable): re-arm the in-process
  // listeners so same-process completion fires, and push the reconcile
  // cadence forward so the poller revisits later instead of every cycle.
  registerChildCompletionListeners(engine, runId, childRunId, childEngine);

  if (stepIndex !== -1) {
    await engine.container.repository.updateOne(
      { _id: runId },
      {
        $set: {
          [`steps.${stepIndex}.waitingFor.nextReconcileAt`]: new Date(
            Date.now() + TIMING.CHILD_RECONCILE_INTERVAL_MS,
          ),
        },
      },
      { bypassTenant: true },
    );
  }
}

/**
 * Register in-process event-bus listeners that resume the parent when the
 * child run completes/fails. Extracted from the inline `childWorkflow`
 * branch so both the first-entry and reconciliation paths share one
 * implementation.
 *
 * Buses to subscribe on:
 *   1. parent's container bus — same-container children fire here
 *   2. child's container bus  — cross-container children fire here
 *      (the executor emits against the child engine's own container)
 * Subscribe to both; dedupe by a local `resumed` flag so only one fires
 * when the buses are the same.
 *
 * These listeners are a fast-path optimisation, NOT the durability
 * guarantee — after a crash they're gone, and the scheduler's child-waiting
 * reconciliation sweep (`handleChildWorkflowWait` re-entry) reclaims the
 * wait. The `resume()` atomic claim makes listener + poll mutually
 * exclusive.
 */
export function registerChildCompletionListeners<TContext>(
  engine: ChildWorkflowEngine<TContext>,
  runId: string,
  childRunId: string,
  childEngine: WorkflowEngine<unknown>,
): void {
  const sameContainer = childEngine.container.eventBus === engine.container.eventBus;
  let resumed = false;

  const cleanup = () => {
    engine.container.eventBus.off('workflow:completed', childCompletionHandler);
    engine.container.eventBus.off('workflow:failed', childFailHandler);
    if (!sameContainer) {
      childEngine.container.eventBus.off('workflow:completed', childCompletionHandler);
      childEngine.container.eventBus.off('workflow:failed', childFailHandler);
    }
  };

  const childCompletionHandler = async (payload: { runId?: string; data?: unknown }) => {
    if (!payload.runId || payload.runId !== childRunId) return;
    if (resumed) return;
    resumed = true;
    try {
      const completedChild = await childEngine.get(childRunId);
      const output = completedChild?.output ?? completedChild?.context;
      await engine.resume(runId, output);
    } catch {
      // Parent may have been cancelled or already resumed (poll won the race)
    }
    cleanup();
  };

  const childFailHandler = async (payload: { runId?: string; data?: unknown }) => {
    if (!payload.runId || payload.runId !== childRunId) return;
    if (resumed) return;
    resumed = true;
    try {
      const failedChild = await childEngine.get(childRunId);
      await engine.resume(runId, { __childFailed: true, error: failedChild?.error });
    } catch {
      // Parent may have been cancelled or already resumed
    }
    cleanup();
  };

  engine.container.eventBus.on('workflow:completed', childCompletionHandler);
  engine.container.eventBus.on('workflow:failed', childFailHandler);
  if (!sameContainer) {
    childEngine.container.eventBus.on('workflow:completed', childCompletionHandler);
    childEngine.container.eventBus.on('workflow:failed', childFailHandler);
  }
}
