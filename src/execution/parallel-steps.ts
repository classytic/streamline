import { assertAndClaim } from '@classytic/primitives/state-machine';
import { TIMING } from '../config/constants.js';
import type { StreamlineContainer } from '../core/container.js';
import { RUN_MACHINE } from '../core/status.js';
import type {
  BranchPlan,
  JoinBranchResult,
  JoinPolicy,
  JoinResult,
  StepState,
  WorkflowRun,
} from '../core/types.js';
import { workflowRegistry } from './registries.js';

/**
 * Declarative parallel STEPS + durable join (`ctx.joinBranches`).
 *
 * This is the durable fan-out/fan-in spine, modelled EXACTLY on
 * `./child-workflow.ts`: a parent step parks in a `branchJoin` wait, N child
 * workflow runs fan out (each a durable document), and the parent resumes once
 * the policy quorum is met. It reuses the same crash-recovery machinery —
 * `nextReconcileAt` cadence gate, a `CommonQueries.branchJoinWaiting` sweep
 * query, a scheduler poll branch, and reconcile-on-re-entry — so a crash
 * mid-fan-out or mid-join is reclaimed by the poller, not dead-waited.
 *
 * GATING: nothing here runs unless a step throws `WaitSignal('branchJoin')`.
 * A workflow that never calls `ctx.joinBranches` produces no `branchJoin`
 * waitingFor, so `getNextStep` / the engine's linear traversal are byte-for-
 * byte unchanged — this is purely additive sugar over child workflows.
 */

/** Minimal engine view the branch-join helpers need (mirrors ChildWorkflowEngine). */
export interface BranchJoinEngine<TContext> {
  readonly container: StreamlineContainer;
  get(runId: string): Promise<WorkflowRun<TContext> | null>;
  resume(runId: string, payload?: unknown): Promise<WorkflowRun<TContext>>;
  /**
   * Fail the branchJoin step (and the run), then drive saga compensation of
   * prior completed steps. Used for `policy:'all'` when a branch failed.
   * Returns true when this caller won the claim (others no-op).
   */
  failBranchJoinStep(runId: string, error: { message: string; code?: string }): Promise<boolean>;
}

interface BranchJoinData {
  branches: BranchPlan[];
  policy: JoinPolicy;
  cancelLosers: boolean;
  parentRunId: string;
  parentStepId: string;
}

function findCurrentStep<TContext>(run: WorkflowRun<TContext>): StepState | undefined {
  return run.steps.find((s) => s.stepId === run.currentStepId);
}

/**
 * Resolve a done child run's output. Prefer the run-level `output`, but fall
 * back to the LAST `done` step's output: the engine writes a step's output
 * atomically with its `done` status, whereas the run-level `output` copy is a
 * separate write that can briefly lag behind the run-level `status:done`
 * (the engine emits `workflow:completed` before that write lands). Reading the
 * last completed step's output closes that window so a branch result is never
 * the child's bare `context`. Final fallback is `context` for workflows that
 * return nothing and carry their result there.
 */
function childOutput(child: WorkflowRun<unknown>): unknown {
  if (child.output !== undefined) return child.output;
  for (let i = child.steps.length - 1; i >= 0; i--) {
    const s = child.steps[i];
    if (s.status === 'done' && s.output !== undefined) return s.output;
  }
  return child.context;
}

/** Deterministic per-branch child idempotency key — closes the double-spawn window. */
function branchIdempotencyKey(
  parentRunId: string,
  parentStepId: string,
  branchKey: string,
): string {
  return `${parentRunId}:${parentStepId}:${branchKey}`;
}

/**
 * Evaluate whether the policy quorum is met given the current child statuses,
 * and build the (durable, re-readable) JoinResult. Pure status math over a
 * frozen 4-value enum — never a configurable predicate.
 *
 * Quorum:
 *   - `all`        → every branch terminal (we then `satisfied` iff all done)
 *   - `any`        → at least one branch `done` (success) OR all terminal
 *   - `race`       → at least one branch terminal
 *   - `allSettled` → every branch terminal
 */
function evaluateQuorum(
  branchResults: JoinBranchResult[],
  policy: JoinPolicy,
): { quorumMet: boolean; result: JoinResult } {
  const terminal = (b: JoinBranchResult) => b.status !== undefined;
  const allTerminal = branchResults.every(terminal);
  const anyDone = branchResults.some((b) => b.status === 'done');
  const anyTerminal = branchResults.some(terminal);

  let quorumMet: boolean;
  switch (policy) {
    case 'all':
      quorumMet = allTerminal;
      break;
    case 'any':
      // Resolve as soon as one succeeds; if everything terminates with no
      // success, resolve too (so the join doesn't hang) — satisfied=false.
      quorumMet = anyDone || allTerminal;
      break;
    case 'race':
      quorumMet = anyTerminal;
      break;
    case 'allSettled':
      quorumMet = allTerminal;
      break;
  }

  // `satisfied` is pure status math over the resolved branch set.
  let satisfied: boolean;
  switch (policy) {
    case 'all':
      satisfied = branchResults.every((b) => b.status === 'done');
      break;
    case 'any':
      satisfied = anyDone;
      break;
    case 'race':
      satisfied = branchResults.some((b) => b.status === 'done');
      break;
    case 'allSettled':
      satisfied = true;
      break;
  }

  // Only terminal branches belong in the resolved result. For all/allSettled
  // every branch is terminal at quorum; for race/any still-running losers are
  // dropped (and cancelled by the caller when cancelLosers), so the result
  // never carries an undefined-status placeholder. Source order is preserved.
  const resolvedBranches = branchResults.filter(terminal);

  return { quorumMet, result: { policy, satisfied, branches: resolvedBranches } };
}

/**
 * Read each started branch's child run and project it to a JoinBranchResult.
 * Branches without a `childRunId` (never started, or started-then-crashed
 * before the $set) are reported as not-yet-terminal so the quorum waits and
 * the missing child is (re)started on the next reconcile pass.
 */
async function readBranchResults<TContext>(
  engine: BranchJoinEngine<TContext>,
  branches: BranchPlan[],
): Promise<{ results: JoinBranchResult[]; pending: BranchPlan[] }> {
  const results: JoinBranchResult[] = [];
  const pending: BranchPlan[] = [];

  for (const b of branches) {
    if (!b.childRunId) {
      pending.push(b);
      // Placeholder so order is preserved; treated as non-terminal.
      results.push({ key: b.key, workflowId: b.workflowId, status: undefined as never });
      continue;
    }
    // Read the AUTHORITATIVE persisted child run (bypass the engine cache).
    // `moveToNextStep` emits `workflow:completed` BEFORE its atomic
    // status+output write lands, so a listener-driven read of the cache can
    // observe `status:done` with `output` not yet set. The DB write is a
    // single atomic updateOne (status + output together), so a DB read that
    // shows `done` always carries the committed output. A read that still
    // shows `running` is treated as non-terminal and revisited next reconcile.
    const child = (await engine.container.repository.getById(b.childRunId, {
      bypassTenant: true,
    })) as WorkflowRun<unknown> | null;
    if (
      child &&
      (child.status === 'done' || child.status === 'failed' || child.status === 'cancelled')
    ) {
      results.push({
        key: b.key,
        workflowId: b.workflowId,
        childRunId: b.childRunId,
        status: child.status,
        output: child.status === 'done' ? childOutput(child) : undefined,
        error: child.status === 'failed' ? child.error : undefined,
      });
    } else {
      // Started but still active (or not yet readable) — non-terminal.
      results.push({
        key: b.key,
        workflowId: b.workflowId,
        childRunId: b.childRunId,
        status: undefined as never,
      });
    }
  }

  return { results, pending };
}

/**
 * Handle a `branchJoin` wait — crash-durable. Mirrors `handleChildWorkflowWait`:
 *
 *   1. **First entry / missing children** — for each branch with no
 *      `childRunId`, look up its child engine, start it with a DETERMINISTIC
 *      idempotency key (so a crash before the $set can't double-spawn), and
 *      persist the `childRunId` back. Stamp `nextReconcileAt` so the scheduler
 *      can reclaim the wait if this process dies before the listeners fire.
 *
 *   2. **Re-entry / reconciliation** — re-read ALL child statuses, evaluate
 *      the policy quorum. If met → resume the parent with the JoinResult
 *      (which becomes the step output) and, for any/race + cancelLosers,
 *      cancel still-running losers AFTER the durable resume. If not met →
 *      re-arm the in-process listeners and bump `nextReconcileAt`.
 *
 * Race-safety: every resume goes through `engine.resume`, whose waiting→running
 * atomic claim lets exactly one caller (listener, this reconcile, another
 * worker) win; losers no-op.
 */
export async function handleBranchJoinWait<TContext>(
  engine: BranchJoinEngine<TContext>,
  runId: string,
  run: WorkflowRun<TContext>,
): Promise<void> {
  const stepState = findCurrentStep(run);
  const data = stepState?.waitingFor?.data as BranchJoinData | undefined;
  if (!data?.branches?.length) return;

  const stepIndex = run.steps.findIndex((s) => s.stepId === run.currentStepId);

  // ---- Start any branch that has no childRunId yet (first entry / recovery) ----
  let startedAny = false;
  for (let j = 0; j < data.branches.length; j++) {
    const branch = data.branches[j];
    if (branch.childRunId) continue;

    const childEngine = workflowRegistry.getEngine(branch.workflowId);
    if (!childEngine) {
      engine.container.eventBus.emit('engine:error', {
        runId,
        error: new Error(
          `Branch workflow '${branch.workflowId}' not registered. ` +
            `Ensure every joinBranches() target is created with createWorkflow() before the parent starts.`,
        ),
        context: 'branch-join-not-found',
      });
      continue;
    }

    // Deterministic idempotency key — a re-entry after a mid-fan-out crash
    // hits the partial-unique index and reuses the existing child instead of
    // double-spawning (E11000 returns the race-winner via start()).
    const idempotencyKey = branchIdempotencyKey(data.parentRunId, data.parentStepId, branch.key);
    const childRun = await childEngine.start(branch.input, {
      idempotencyKey,
      bypassTenant: true,
      meta: {
        parentRunId: data.parentRunId,
        parentStepId: data.parentStepId,
        branchKey: branch.key,
      },
    });

    branch.childRunId = childRun._id;
    startedAny = true;

    if (stepIndex !== -1) {
      await engine.container.repository.updateOne(
        { _id: runId },
        {
          $set: {
            [`steps.${stepIndex}.waitingFor.data.branches.${j}.childRunId`]: childRun._id,
            [`steps.${stepIndex}.waitingFor.nextReconcileAt`]: new Date(
              Date.now() + TIMING.CHILD_RECONCILE_INTERVAL_MS,
            ),
          },
        },
        { bypassTenant: true },
      );
    }

    registerBranchCompletionListeners(engine, runId, childRun._id);
  }

  // ---- Evaluate quorum against current child statuses ----
  const { results } = await readBranchResults(engine, data.branches);
  const { quorumMet, result } = evaluateQuorum(results, data.policy);

  if (quorumMet) {
    // join:'all' with a failed branch → FAIL the step so the run goes
    // `failed` and existing saga compensation rolls back prior completed
    // steps. The fail path is claim-guarded (waiting→running→failed) so a
    // concurrent driver no-ops. Cancel any still-running branch children so a
    // failed fan-out doesn't leave orphans burning compute.
    if (data.policy === 'all' && !result.satisfied) {
      const failedBranch = result.branches.find((b) => b.status === 'failed');
      const won = await engine.failBranchJoinStep(runId, {
        message: failedBranch?.error?.message ?? 'branchJoin: a branch failed under policy "all"',
        code: 'BRANCH_JOIN_FAILED',
      });
      if (won) await cancelLosers(data.branches);
      return;
    }

    // Resume the parent with the JoinResult as the step output. The
    // waiting→running claim inside resume() makes a concurrent listener / a
    // second poller a no-op (race-safe). Loser strictly discards.
    let resumed = false;
    try {
      await engine.resume(runId, result);
      resumed = true;
    } catch {
      // Lost the resume race (already resumed/cancelled) — no-op.
    }

    // Cancel still-running losers ONLY AFTER the parent durably resumed
    // (cancelling first then crashing would drop the winner's result).
    if (resumed && data.cancelLosers && (data.policy === 'any' || data.policy === 'race')) {
      await cancelLosers(data.branches);
    }
    return;
  }

  // ---- Quorum not met: re-arm listeners + push the reconcile cadence ----
  if (!startedAny) {
    for (const b of data.branches) {
      if (b.childRunId) registerBranchCompletionListeners(engine, runId, b.childRunId);
    }
  }

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

/** Cancel any still-active branch child (tolerant of already-terminal: no-op). */
async function cancelLosers(branches: BranchPlan[]): Promise<void> {
  for (const b of branches) {
    if (!b.childRunId) continue;
    const childEngine = workflowRegistry.getEngine(b.workflowId);
    if (!childEngine) continue;
    try {
      const child = await childEngine.get(b.childRunId);
      if (
        child &&
        child.status !== 'done' &&
        child.status !== 'failed' &&
        child.status !== 'cancelled'
      ) {
        await childEngine.cancel(b.childRunId);
      }
    } catch {
      // Best-effort loser cleanup — already terminal / cancelled is fine.
    }
  }
}

/**
 * Durable, race-safe fail-write for a `branchJoin` step under `policy:'all'`
 * when a branch failed. Extracted from the engine so engine.ts stays a thin
 * delegate (the engine method only adds the saga-compensation + listener
 * teardown that touch its private state).
 *
 * Atomicity: CAS the run `waiting → running` first (only one driver wins — a
 * concurrent listener/poller that would resume the same step loses and
 * no-ops), then write step `failed` + run `failed` via a narrow `$set`
 * (mongoose-9 subdoc-safe), and emit the standard `step:failed` /
 * `workflow:failed` events. Returns false when the claim was lost.
 */
export async function writeBranchJoinFailure<TContext>(
  engine: BranchJoinEngine<TContext>,
  runId: string,
  error: { message: string; code?: string },
): Promise<boolean> {
  const now = new Date();
  const repo = engine.container.repository;

  const claimed = await assertAndClaim(RUN_MACHINE, repo, runId, {
    from: 'waiting',
    to: 'running',
    patch: { lastHeartbeat: now, updatedAt: now },
    options: { bypassTenant: true },
  });
  engine.container.cache.delete(runId);
  if (!claimed) return false;

  const run = await engine.get(runId);
  if (!run) return true;
  const stepId = run.currentStepId;
  const stepIndex = run.steps.findIndex((s) => s.stepId === stepId);

  const errorPayload = { message: error.message, code: error.code, retriable: false };
  const set: Record<string, unknown> = {
    status: 'failed',
    endedAt: now,
    updatedAt: now,
    error: { message: error.message, code: error.code },
  };
  const unset: Record<string, unknown> = {};
  if (stepIndex !== -1) {
    set[`steps.${stepIndex}.status`] = 'failed';
    set[`steps.${stepIndex}.endedAt`] = now;
    set[`steps.${stepIndex}.error`] = errorPayload;
    unset[`steps.${stepIndex}.waitingFor`] = '';
  }

  await repo.updateOne(
    { _id: runId },
    Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
    { bypassTenant: true },
  );
  engine.container.cache.delete(runId);

  if (stepId) {
    engine.container.eventBus.emit('step:failed', {
      runId,
      stepId,
      error: new Error(error.message),
    });
  }
  engine.container.eventBus.emit('workflow:failed', { runId, error: new Error(error.message) });
  return true;
}

/**
 * Walk the branch plan in a `branchJoin` parent's `waitingFor.data` and cancel
 * every non-terminal child. Called from the engine's `cancel()` so cancelling
 * a parent does not orphan running branch children (which burn compute).
 */
export async function cancelBranchChildren<TContext>(run: WorkflowRun<TContext>): Promise<void> {
  const step = findCurrentStep(run);
  const data = step?.waitingFor?.data as BranchJoinData | undefined;
  if (step?.waitingFor?.type !== 'branchJoin' || !data?.branches?.length) return;
  await cancelLosers(data.branches);
}

/**
 * Register in-process listeners that re-drive the join when ANY branch child
 * completes/fails. The handler simply re-enters reconciliation (re-read all
 * children + re-evaluate quorum) — the quorum logic, not the listener, is the
 * correctness path. Listeners are a same-process fast path; after a crash the
 * scheduler's branch-join sweep reclaims the wait.
 *
 * Subscribed on the parent's container bus AND the global bus so a child that
 * completes on either fires the re-drive; deduped by the resume claim.
 */
export function registerBranchCompletionListeners<TContext>(
  engine: BranchJoinEngine<TContext>,
  runId: string,
  childRunId: string,
): void {
  const reDrive = async (payload: { runId?: string }) => {
    if (!payload.runId || payload.runId !== childRunId) return;
    try {
      const current = await engine.get(runId);
      if (!current) return;
      const step = current.steps.find((s) => s.stepId === current.currentStepId);
      if (current.status !== 'waiting' || step?.waitingFor?.type !== 'branchJoin') {
        cleanup();
        return;
      }
      await handleBranchJoinWait(engine, runId, current);
    } catch {
      // Parent may have resumed/cancelled — listener no-ops.
    }
  };

  const cleanup = () => {
    engine.container.eventBus.off('workflow:completed', reDrive);
    engine.container.eventBus.off('workflow:failed', reDrive);
    engine.container.eventBus.off('workflow:cancelled', reDrive);
  };

  engine.container.eventBus.on('workflow:completed', reDrive);
  engine.container.eventBus.on('workflow:failed', reDrive);
  engine.container.eventBus.on('workflow:cancelled', reDrive);
}
