/**
 * Integration suite for declarative parallel STEPS + durable join
 * (`ctx.joinBranches`) — the dag-parallel feature.
 *
 * The join is durable SUGAR over child workflows: each branch is a real child
 * run, the parent parks in a `branchJoin` wait, and resumes once the policy
 * quorum is met. Crash recovery reuses the SAME reconciliation spine as
 * childWorkflow: a `CommonQueries.branchJoinWaiting` sweep +
 * `getBranchJoinWaitingRuns` + a scheduler poll branch + reconcile-on-re-entry.
 *
 * Crash simulation mirrors `child-workflow-reconciliation.test.ts`: we persist
 * the parent's `branchJoin` waiting step by hand (partial-completion shape),
 * run children on their own engines (no parent listener attached — exactly a
 * fresh process after a crash), then invoke the reconciliation verb
 * (`engine.resume(runId)`, the same one the scheduler's sweep calls).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, createWorkflow, WorkflowRunModel } from '../../src/index.js';
import type { JoinResult, StepState, WorkflowRun } from '../../src/core/types.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { cleanupTestDB, setupTestDB, teardownTestDB, waitUntil } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

let wfCounter = 0;
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${++wfCounter}`;

/**
 * Persist a parent run that is `waiting` on a branchJoin step. `branches` may
 * carry `childRunId` (already-started, post-crash shape) or omit it (never
 * started). `nextReconcileAt` is in the past so the sweep considers it due.
 */
async function persistOrphanedJoinParent(opts: {
  parentRunId: string;
  parentWorkflowId: string;
  allStepIds: string[];
  stepId: string;
  branches: Array<{ key: string; workflowId: string; input: unknown; childRunId?: string }>;
  policy?: 'all' | 'any' | 'race' | 'allSettled';
  cancelLosers?: boolean;
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
          type: 'branchJoin',
          reason: `Waiting for ${opts.branches.length} parallel branches`,
          nextReconcileAt: new Date(now.getTime() - 60_000),
          data: {
            branches: opts.branches,
            policy: opts.policy ?? 'all',
            cancelLosers: opts.cancelLosers ?? true,
            parentRunId: opts.parentRunId,
            parentStepId: opts.stepId,
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

describe('declarative parallel + durable join', () => {
  it('runs branches CONCURRENTLY and joins all results in order (join:all happy path)', async () => {
    const container = createContainer();
    const branchWfId = uniqueId('pj-branch');
    const parentWfId = uniqueId('pj-parent');

    const overlap = { firstStart: 0, lastStart: 0, firstEnd: Number.MAX_SAFE_INTEGER };

    // Branch child: records concurrency timing, sleeps, returns its input * 10.
    const branch = createWorkflow(branchWfId, {
      steps: {
        work: async (ctx) => {
          const input = ctx.input as { n: number };
          const t = Date.now();
          if (!overlap.firstStart) overlap.firstStart = t;
          overlap.lastStart = t;
          await new Promise((r) => setTimeout(r, 300));
          overlap.firstEnd = Math.min(overlap.firstEnd, Date.now());
          return { value: input.n * 10 };
        },
      },
      container,
    });

    const parent = createWorkflow<{ joined?: JoinResult }>(parentWfId, {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'a', workflowId: branchWfId, input: { n: 1 } },
              { key: 'b', workflowId: branchWfId, input: { n: 2 } },
              { key: 'c', workflowId: branchWfId, input: { n: 3 } },
            ],
            { policy: 'all' },
          ),
        collect: async (ctx) => {
          await ctx.set('joined', ctx.getOutput<JoinResult>('fanout'));
          return 'ok';
        },
      },
      context: () => ({}),
      container,
    });

    const run = await parent.start({});
    const done = await waitUntil(async () => {
      const r = await parent.get(run._id);
      return r?.status === 'done';
    }, 15_000);
    expect(done).toBe(true);

    // Concurrency: all three started before the first one finished.
    expect(overlap.lastStart).toBeLessThan(overlap.firstEnd);

    const final = await parent.get(run._id);
    const join = final?.context.joined as JoinResult;
    expect(join.policy).toBe('all');
    expect(join.satisfied).toBe(true);
    // Results in branch order, each done.
    expect(join.branches.map((b) => b.key)).toEqual(['a', 'b', 'c']);
    expect(join.branches.every((b) => b.status === 'done')).toBe(true);
    expect(join.branches.map((b) => (b.output as { value: number }).value)).toEqual([10, 20, 30]);

    parent.shutdown();
    branch.shutdown();
  });

  it('join:all — one branch fails → step fails → prior completed step compensates (saga)', async () => {
    const container = createContainer();
    const goodWfId = uniqueId('pj-good');
    const badWfId = uniqueId('pj-bad');
    const parentWfId = uniqueId('pj-sagaparent');

    const good = createWorkflow(goodWfId, {
      steps: { ok: async () => ({ ok: true }) },
      container,
    });
    const bad = createWorkflow(badWfId, {
      steps: {
        boom: async () => {
          throw new Error('branch blew up');
        },
      },
      defaults: { retries: 0 },
      container,
    });

    let compensated = 0;

    // A prior DONE step with onCompensate, then the join step which fails
    // under policy:'all'. The run goes `failed` → saga walks the prior `done`
    // step and runs its onCompensate. (Standard saga: the failing step itself
    // is not compensated; prior completed work is rolled back.)
    const parent = createWorkflow(parentWfId, {
      steps: {
        prepare: {
          handler: async () => ({ reserved: true }),
          onCompensate: async () => {
            compensated++;
          },
        },
        fanout: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'good', workflowId: goodWfId, input: {} },
              { key: 'bad', workflowId: badWfId, input: {} },
            ],
            { policy: 'all' },
          ),
        after: async () => 'unreached',
      },
      container,
      defaults: { retries: 0 },
    });

    const run = await parent.start({});
    const settled = await waitUntil(async () => {
      const r = await parent.get(run._id);
      return r?.status === 'compensated' || r?.status === 'compensation_failed';
    }, 15_000);
    expect(settled).toBe(true);

    const final = await parent.get(run._id);
    // The join step failed; the prior `prepare` step was compensated.
    expect(final?.steps.find((s) => s.stepId === 'fanout')?.status).toBe('failed');
    expect(compensated).toBe(1);

    parent.shutdown();
    good.shutdown();
    bad.shutdown();
  });

  it('join:any — first success resolves the join; result reflects a winner', async () => {
    const container = createContainer();
    const fastWfId = uniqueId('pj-fast');
    const parentWfId = uniqueId('pj-anyparent');

    const branch = createWorkflow(fastWfId, {
      steps: {
        work: async (ctx) => {
          const input = ctx.input as { delay: number; tag: string };
          await new Promise((r) => setTimeout(r, input.delay));
          return { tag: input.tag };
        },
      },
      container,
    });

    const parent = createWorkflow<{ join?: JoinResult }>(parentWfId, {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'slow', workflowId: fastWfId, input: { delay: 1000, tag: 'slow' } },
              { key: 'fast', workflowId: fastWfId, input: { delay: 50, tag: 'fast' } },
            ],
            { policy: 'any', cancelLosers: true },
          ),
        collect: async (ctx) => {
          await ctx.set('join', ctx.getOutput<JoinResult>('fanout'));
          return 'ok';
        },
      },
      context: () => ({}),
      container,
    });

    const run = await parent.start({});
    const done = await waitUntil(async () => {
      const r = await parent.get(run._id);
      return r?.status === 'done';
    }, 15_000);
    expect(done).toBe(true);

    const final = await parent.get(run._id);
    const join = final?.context.join as JoinResult;
    expect(join.policy).toBe('any');
    expect(join.satisfied).toBe(true);
    // At least one DONE branch — the fast one is the winner.
    const winners = join.branches.filter((b) => b.status === 'done');
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(winners.some((b) => (b.output as { tag: string }).tag === 'fast')).toBe(true);

    parent.shutdown();
    branch.shutdown();
  });

  it('join:allSettled — collects ALL outcomes; a branch failure does NOT fail the step', async () => {
    const container = createContainer();
    const okWfId = uniqueId('pj-ssok');
    const failWfId = uniqueId('pj-ssfail');
    const parentWfId = uniqueId('pj-ssparent');

    const ok = createWorkflow(okWfId, {
      steps: { run: async () => ({ ok: 1 }) },
      container,
    });
    const fail = createWorkflow(failWfId, {
      steps: {
        run: async () => {
          throw new Error('settled failure');
        },
      },
      defaults: { retries: 0 },
      container,
    });

    const parent = createWorkflow<{ join?: JoinResult }>(parentWfId, {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'ok', workflowId: okWfId, input: {} },
              { key: 'fail', workflowId: failWfId, input: {} },
            ],
            { policy: 'allSettled' },
          ),
        collect: async (ctx) => {
          await ctx.set('join', ctx.getOutput<JoinResult>('fanout'));
          return 'ok';
        },
      },
      context: () => ({}),
      container,
    });

    const run = await parent.start({});
    const done = await waitUntil(async () => {
      const r = await parent.get(run._id);
      return r?.status === 'done';
    }, 15_000);
    expect(done).toBe(true);

    const final = await parent.get(run._id);
    const join = final?.context.join as JoinResult;
    expect(join.policy).toBe('allSettled');
    // allSettled is always satisfied once every branch is terminal.
    expect(join.satisfied).toBe(true);
    expect(join.branches.map((b) => b.key).sort()).toEqual(['fail', 'ok']);
    expect(join.branches.find((b) => b.key === 'ok')?.status).toBe('done');
    expect(join.branches.find((b) => b.key === 'fail')?.status).toBe('failed');

    parent.shutdown();
    ok.shutdown();
    fail.shutdown();
  });

  it('crash MID-PARALLEL: only incomplete branches re-run; completed ones are not; join completes', async () => {
    const container = createContainer();
    const branchWfId = uniqueId('pj-crashbranch');
    const parentWfId = uniqueId('pj-crashparent');
    const stepId = 'fanout';

    let runCount = 0;
    // Branch workflow auto-executes (the engine's reconcile starts each branch
    // and relies on it running to completion). Only the PARENT is held back so
    // the test drives reconciliation explicitly.
    const branch = createWorkflow(branchWfId, {
      steps: {
        work: async (ctx) => {
          runCount++;
          const input = ctx.input as { n: number };
          return { value: input.n };
        },
      },
      container,
    });

    // Branch 'a' was ALREADY completed before the crash. Branch 'b' never
    // started (no childRunId). On reconcile, ONLY 'b' should run.
    const childA = await branch.start({ n: 100 });
    const doneA = await waitUntil(async () => {
      const r = await branch.get(childA._id);
      return r?.status === 'done';
    }, 10_000);
    expect(doneA).toBe(true);
    expect(runCount).toBe(1); // only 'a' has run so far

    const parent = createWorkflow<{ join?: JoinResult }>(parentWfId, {
      steps: {
        [stepId]: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'a', workflowId: branchWfId, input: { n: 100 } },
              { key: 'b', workflowId: branchWfId, input: { n: 200 } },
            ],
            { policy: 'all' },
          ),
        collect: async (ctx) => {
          await ctx.set('join', ctx.getOutput<JoinResult>(stepId));
          return 'ok';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    const parentRunId = uniqueId('pj-crash-run');
    await persistOrphanedJoinParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'collect'],
      stepId,
      branches: [
        { key: 'a', workflowId: branchWfId, input: { n: 100 }, childRunId: childA._id },
        { key: 'b', workflowId: branchWfId, input: { n: 200 } }, // never started
      ],
      policy: 'all',
    });

    // Sweep selects exactly this orphaned parent.
    const due = await workflowRunRepository.getBranchJoinWaitingRuns(new Date(), 100, {
      bypassTenant: true,
    });
    expect(due.map((r) => r._id)).toContain(parentRunId);

    // Reconcile (the verb the scheduler's branch-join sweep calls). First pass
    // starts the missing 'b' child; subsequent passes resolve the quorum.
    await parent.engine.resume(parentRunId);

    const completed = await waitUntil(async () => {
      // re-drive reconciliation until the join resolves (mirrors the poller)
      const r = await parent.get(parentRunId);
      if (r?.status === 'waiting') await parent.engine.resume(parentRunId).catch(() => {});
      const rr = await parent.get(parentRunId);
      return rr?.status === 'done';
    }, 15_000);
    expect(completed).toBe(true);

    // 'a' was NOT re-run (still 1 from before) + 'b' ran once = 2 total.
    expect(runCount).toBe(2);

    const final = await parent.get(parentRunId);
    const join = final?.context.join as JoinResult;
    expect(join.satisfied).toBe(true);
    expect(join.branches.map((b) => b.key)).toEqual(['a', 'b']);
    expect(join.branches.map((b) => (b.output as { value: number }).value)).toEqual([100, 200]);

    parent.shutdown();
    branch.shutdown();
  });

  it('crash WHILE WAITING on the join: reconciliation reclaims and resumes (spine reuse)', async () => {
    const container = createContainer();
    const branchWfId = uniqueId('pj-waitbranch');
    const parentWfId = uniqueId('pj-waitparent');
    const stepId = 'fanout';

    // Both branches already completed (on their own engines, no parent
    // listener attached) — the parent is parked on the join with stale
    // listeners, exactly the post-crash shape.
    const branch = createWorkflow(branchWfId, {
      steps: {
        work: async (ctx) => ({ value: (ctx.input as { n: number }).n }),
      },
      container,
    });

    const childA = await branch.start({ n: 7 });
    const childB = await branch.start({ n: 8 });
    const bothDone = await waitUntil(async () => {
      const a = await branch.get(childA._id);
      const b = await branch.get(childB._id);
      return a?.status === 'done' && b?.status === 'done';
    }, 10_000);
    expect(bothDone).toBe(true);

    const parent = createWorkflow<{ join?: JoinResult }>(parentWfId, {
      steps: {
        [stepId]: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'a', workflowId: branchWfId, input: { n: 7 } },
              { key: 'b', workflowId: branchWfId, input: { n: 8 } },
            ],
            { policy: 'all' },
          ),
        collect: async (ctx) => {
          await ctx.set('join', ctx.getOutput<JoinResult>(stepId));
          return 'ok';
        },
      },
      context: () => ({}),
      container,
      autoExecute: false,
    });

    const parentRunId = uniqueId('pj-wait-run');
    await persistOrphanedJoinParent({
      parentRunId,
      parentWorkflowId: parentWfId,
      allStepIds: [stepId, 'collect'],
      stepId,
      branches: [
        { key: 'a', workflowId: branchWfId, input: { n: 7 }, childRunId: childA._id },
        { key: 'b', workflowId: branchWfId, input: { n: 8 }, childRunId: childB._id },
      ],
      policy: 'all',
    });

    // No listener watching. The reconciliation poll re-reads both terminal
    // children, sees the quorum met, and resumes the parent to completion.
    await parent.engine.resume(parentRunId);

    const final = await parent.get(parentRunId);
    expect(final?.status).toBe('done');
    const join = final?.context.join as JoinResult;
    expect(join.satisfied).toBe(true);
    expect(join.branches.map((b) => (b.output as { value: number }).value)).toEqual([7, 8]);

    parent.shutdown();
    branch.shutdown();
  });

  it('rejects a CROSS-CONTAINER branch target LOUDLY at fan-out (no silent forever-park)', async () => {
    // Regression for the silent-hang DX trap: a branch whose engine lives on a
    // DIFFERENT container than the parent emits completion on a bus the parent
    // never subscribed to AND writes to a repository the parent's reconcile
    // can't read — so the join would park forever with no error/log. The guard
    // must fail the join at fan-out instead, and never start the branch child.
    const parentContainer = createContainer();
    const otherContainer = createContainer();
    const branchWfId = uniqueId('pj-xcontainer-branch');
    const parentWfId = uniqueId('pj-xcontainer-parent');

    let branchRan = 0;
    const branch = createWorkflow(branchWfId, {
      steps: {
        work: async () => {
          branchRan++;
          return { ok: true };
        },
      },
      container: otherContainer, // <-- different container than the parent
    });

    const parent = createWorkflow(parentWfId, {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches([{ key: 'a', workflowId: branchWfId, input: {} }], { policy: 'all' }),
        after: async () => 'unreached',
      },
      container: parentContainer,
      defaults: { retries: 0 },
    });

    const run = await parent.start({});
    const failed = await waitUntil(async () => {
      const r = await parent.get(run._id);
      return r?.status === 'failed' || r?.status === 'compensated';
    }, 10_000);
    expect(failed).toBe(true);

    const final = await parent.get(run._id);
    const fanout = final?.steps.find((s) => s.stepId === 'fanout');
    expect(fanout?.status).toBe('failed');
    expect((fanout?.error as { code?: string } | undefined)?.code).toBe(
      'BRANCH_JOIN_CROSS_CONTAINER',
    );
    // The guard runs BEFORE the start loop — the branch child is never spawned.
    expect(branchRan).toBe(0);

    parent.shutdown();
    branch.shutdown();
  });
});
