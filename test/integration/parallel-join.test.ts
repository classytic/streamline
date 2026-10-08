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

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { JoinResult, StepState } from '../../src/core/types.js';
import type { WorkflowLike } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/**
 * Persist a parent run that is `waiting` on a branchJoin step. `branches` may
 * carry `childRunId` (already-started, post-crash shape) or omit it (never
 * started). `nextReconcileAt` is in the past so the sweep considers it due.
 * Returns the run id.
 */
async function persistOrphanedJoinParent(
  parent: WorkflowLike,
  opts: {
    stepId: string;
    branches: Array<{ key: string; workflowId: string; input: unknown; childRunId?: string }>;
    policy?: 'all' | 'any' | 'race' | 'allSettled';
    cancelLosers?: boolean;
  },
): Promise<string> {
  const now = new Date();
  // The wait data names its own parent run, so the id is chosen up front.
  const parentRunId = `pj-run-${randomUUID()}`;
  const steps: StepState[] = parent.engine.definition.steps.map(({ id }) => {
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
            parentRunId,
            parentStepId: opts.stepId,
          },
        },
      } as StepState;
    }
    return { stepId: id, status: 'pending', attempts: 0 };
  });

  await env.runs.insert(parent, {
    _id: parentRunId,
    status: 'waiting',
    steps,
    currentStepId: opts.stepId,
    startedAt: now,
  });
  return parentRunId;
}

describe('declarative parallel + durable join', () => {
  it('branch listeners never pile up on reconcile, and leave the bus when the join settles', async () => {
    // Branches park on `go`, so the join stays unmet while we reconcile.
    const branch = env.workflow('pj-gated', {
      steps: { work: async (ctx) => ctx.waitFor('go') },
      autoExecute: true,
    });
    const parent = env.workflow('pj-gated-parent', {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'a', workflowId: branch.engine.definition.id, input: {} },
              { key: 'b', workflowId: branch.engine.definition.id, input: {} },
            ],
            { policy: 'all' },
          ),
      },
      autoExecute: true,
    });
    const bus = env.container.eventBus;
    const baseline = bus.listenerCount('workflow:completed');

    const run = await parent.start({});
    const waiting = await env.until(run._id, (r) => {
      const data = r.steps[0]?.waitingFor?.data as { branches?: Array<{ childRunId?: string }> };
      return r.status === 'waiting' && (data?.branches ?? []).every((b) => b.childRunId);
    });
    const armed = bus.listenerCount('workflow:completed');
    expect(armed - baseline).toBeGreaterThanOrEqual(2); // one per branch (+ the engine's own)

    // Reconcile polls (the scheduler's branch-join sweep) while quorum is unmet:
    // each used to re-arm a listener for EVERY branch.
    for (let i = 0; i < 3; i++) await parent.engine.resume(run._id);
    expect(bus.listenerCount('workflow:completed')).toBe(armed);

    // Settle the join: every branch listener leaves the bus.
    const joinData = waiting.steps[0]?.waitingFor?.data as {
      branches: Array<{ childRunId: string }>;
    };
    const children = joinData.branches.map((b) => b.childRunId);
    for (const id of children) await branch.signal(id, 'go', 'ok');
    await env.until(run._id, 'done');
    await env.eventually(() => expect(bus.listenerCount('workflow:completed')).toBe(baseline));
  });

  it('runs branches CONCURRENTLY and joins all results in order (join:all happy path)', async () => {
    const overlap = { firstStart: 0, lastStart: 0, firstEnd: Number.MAX_SAFE_INTEGER };

    // Branch child: records concurrency timing, sleeps, returns its input * 10.
    const branch = env.workflow('pj-branch', {
      steps: {
        work: async (ctx) => {
          const input = ctx.input as { n: number };
          const t = Date.now();
          if (!overlap.firstStart) overlap.firstStart = t;
          overlap.lastStart = t;
          // Simulated work — the overlap measurement needs each branch to take time.
          await new Promise((r) => setTimeout(r, 300));
          overlap.firstEnd = Math.min(overlap.firstEnd, Date.now());
          return { value: input.n * 10 };
        },
      },
      autoExecute: true,
    });
    const branchWfId = branch.engine.definition.id;

    const parent = env.workflow<{ joined?: JoinResult }>('pj-parent', {
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
      autoExecute: true,
    });

    const run = await parent.start({});
    await env.until(run._id, 'done', { timeout: 15_000 });

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
  });

  it('join:all — one branch fails → step fails → prior completed step compensates (saga)', async () => {
    const good = env.workflow('pj-good', {
      steps: { ok: async () => ({ ok: true }) },
      autoExecute: true,
    });
    const bad = env.workflow('pj-bad', {
      steps: {
        boom: async () => {
          throw new Error('branch blew up');
        },
      },
      defaults: { retries: 0 },
      autoExecute: true,
    });

    let compensated = 0;

    // A prior DONE step with onCompensate, then the join step which fails
    // under policy:'all'. The run goes `failed` → saga walks the prior `done`
    // step and runs its onCompensate. (Standard saga: the failing step itself
    // is not compensated; prior completed work is rolled back.)
    const parent = env.workflow('pj-sagaparent', {
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
              { key: 'good', workflowId: good.engine.definition.id, input: {} },
              { key: 'bad', workflowId: bad.engine.definition.id, input: {} },
            ],
            { policy: 'all' },
          ),
        after: async () => 'unreached',
      },
      defaults: { retries: 0 },
      autoExecute: true,
    });

    const run = await parent.start({});
    const final = await env.until(
      run._id,
      (r) => r.status === 'compensated' || r.status === 'compensation_failed',
      { timeout: 15_000 },
    );

    // The join step failed; the prior `prepare` step was compensated.
    expect(final.steps.find((s) => s.stepId === 'fanout')?.status).toBe('failed');
    expect(compensated).toBe(1);
  });

  it('join:any — first success resolves the join; result reflects a winner', async () => {
    const branch = env.workflow('pj-fast', {
      steps: {
        work: async (ctx) => {
          const input = ctx.input as { delay: number; tag: string };
          // Simulated work of differing length — decides which branch wins.
          await new Promise((r) => setTimeout(r, input.delay));
          return { tag: input.tag };
        },
      },
      autoExecute: true,
    });
    const fastWfId = branch.engine.definition.id;

    const parent = env.workflow<{ join?: JoinResult }>('pj-anyparent', {
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
      autoExecute: true,
    });

    const run = await parent.start({});
    await env.until(run._id, 'done', { timeout: 15_000 });

    const final = await parent.get(run._id);
    const join = final?.context.join as JoinResult;
    expect(join.policy).toBe('any');
    expect(join.satisfied).toBe(true);
    // At least one DONE branch — the fast one is the winner.
    const winners = join.branches.filter((b) => b.status === 'done');
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(winners.some((b) => (b.output as { tag: string }).tag === 'fast')).toBe(true);
  });

  it('join:allSettled — collects ALL outcomes; a branch failure does NOT fail the step', async () => {
    const ok = env.workflow('pj-ssok', {
      steps: { run: async () => ({ ok: 1 }) },
      autoExecute: true,
    });
    const fail = env.workflow('pj-ssfail', {
      steps: {
        run: async () => {
          throw new Error('settled failure');
        },
      },
      defaults: { retries: 0 },
      autoExecute: true,
    });

    const parent = env.workflow<{ join?: JoinResult }>('pj-ssparent', {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches(
            [
              { key: 'ok', workflowId: ok.engine.definition.id, input: {} },
              { key: 'fail', workflowId: fail.engine.definition.id, input: {} },
            ],
            { policy: 'allSettled' },
          ),
        collect: async (ctx) => {
          await ctx.set('join', ctx.getOutput<JoinResult>('fanout'));
          return 'ok';
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await parent.start({});
    await env.until(run._id, 'done', { timeout: 15_000 });

    const final = await parent.get(run._id);
    const join = final?.context.join as JoinResult;
    expect(join.policy).toBe('allSettled');
    // allSettled is always satisfied once every branch is terminal.
    expect(join.satisfied).toBe(true);
    expect(join.branches.map((b) => b.key).sort()).toEqual(['fail', 'ok']);
    expect(join.branches.find((b) => b.key === 'ok')?.status).toBe('done');
    expect(join.branches.find((b) => b.key === 'fail')?.status).toBe('failed');
  });

  it('crash MID-PARALLEL: only incomplete branches re-run; completed ones are not; join completes', async () => {
    const stepId = 'fanout';

    let runCount = 0;
    // Branch workflow auto-executes (the engine's reconcile starts each branch
    // and relies on it running to completion). Only the PARENT is held back so
    // the test drives reconciliation explicitly.
    const branch = env.workflow('pj-crashbranch', {
      steps: {
        work: async (ctx) => {
          runCount++;
          const input = ctx.input as { n: number };
          return { value: input.n };
        },
      },
      autoExecute: true,
    });
    const branchWfId = branch.engine.definition.id;

    // Branch 'a' was ALREADY completed before the crash. Branch 'b' never
    // started (no childRunId). On reconcile, ONLY 'b' should run.
    const childA = await branch.start({ n: 100 });
    await env.until(childA._id, 'done', { timeout: 10_000 });
    expect(runCount).toBe(1); // only 'a' has run so far

    const parent = env.workflow<{ join?: JoinResult }>('pj-crashparent', {
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
    });

    const parentRunId = await persistOrphanedJoinParent(parent, {
      stepId,
      branches: [
        { key: 'a', workflowId: branchWfId, input: { n: 100 }, childRunId: childA._id },
        { key: 'b', workflowId: branchWfId, input: { n: 200 } }, // never started
      ],
      policy: 'all',
    });

    // Sweep selects exactly this orphaned parent.
    const due = await env.container.repository.getBranchJoinWaitingRuns(new Date(), 100, {
      bypassTenant: true,
    });
    expect(due.map((r) => r._id)).toContain(parentRunId);

    // Reconcile (the verb the scheduler's branch-join sweep calls). First pass
    // starts the missing 'b' child; subsequent passes resolve the quorum.
    await parent.engine.resume(parentRunId);

    // Re-drive reconciliation until the join resolves (mirrors the poller).
    await env.eventually(
      async () => {
        const r = await parent.get(parentRunId);
        if (r?.status === 'waiting') await parent.engine.resume(parentRunId).catch(() => {});
        expect((await parent.get(parentRunId))?.status).toBe('done');
      },
      { timeout: 15_000, interval: 100 },
    );

    // 'a' was NOT re-run (still 1 from before) + 'b' ran once = 2 total.
    expect(runCount).toBe(2);

    const final = await parent.get(parentRunId);
    const join = final?.context.join as JoinResult;
    expect(join.satisfied).toBe(true);
    expect(join.branches.map((b) => b.key)).toEqual(['a', 'b']);
    expect(join.branches.map((b) => (b.output as { value: number }).value)).toEqual([100, 200]);
  });

  it('crash WHILE WAITING on the join: reconciliation reclaims and resumes (spine reuse)', async () => {
    const stepId = 'fanout';

    // Both branches already completed (on their own engines, no parent
    // listener attached) — the parent is parked on the join with stale
    // listeners, exactly the post-crash shape.
    const branch = env.workflow('pj-waitbranch', {
      steps: {
        work: async (ctx) => ({ value: (ctx.input as { n: number }).n }),
      },
      autoExecute: true,
    });
    const branchWfId = branch.engine.definition.id;

    const childA = await branch.start({ n: 7 });
    const childB = await branch.start({ n: 8 });
    await env.until(childA._id, 'done', { timeout: 10_000 });
    await env.until(childB._id, 'done', { timeout: 10_000 });

    const parent = env.workflow<{ join?: JoinResult }>('pj-waitparent', {
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
    });

    const parentRunId = await persistOrphanedJoinParent(parent, {
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
  });

  it('rejects a CROSS-CONTAINER branch target LOUDLY at fan-out (no silent forever-park)', async () => {
    // Regression for the silent-hang DX trap: a branch whose engine lives on a
    // DIFFERENT container than the parent emits completion on a bus the parent
    // never subscribed to AND writes to a repository the parent's reconcile
    // can't read — so the join would park forever with no error/log. The guard
    // must fail the join at fan-out instead, and never start the branch child.
    const otherContainer = env.createContainer();
    let branchRan = 0;
    const branch = env.workflow('pj-xcontainer-branch', {
      steps: {
        work: async () => {
          branchRan++;
          return { ok: true };
        },
      },
      container: otherContainer, // <-- different container than the parent
      autoExecute: true,
    });

    const parent = env.workflow('pj-xcontainer-parent', {
      steps: {
        fanout: async (ctx) =>
          ctx.joinBranches([{ key: 'a', workflowId: branch.engine.definition.id, input: {} }], {
            policy: 'all',
          }),
        after: async () => 'unreached',
      },
      defaults: { retries: 0 },
      autoExecute: true,
    });

    const run = await parent.start({});
    await env.until(run._id, (r) => r.status === 'failed' || r.status === 'compensated', {
      timeout: 10_000,
    });

    const final = await parent.get(run._id);
    const fanout = final?.steps.find((s) => s.stepId === 'fanout');
    expect(fanout?.status).toBe('failed');
    expect((fanout?.error as { code?: string } | undefined)?.code).toBe(
      'BRANCH_JOIN_CROSS_CONTAINER',
    );
    // The guard runs BEFORE the start loop — the branch child is never spawned.
    expect(branchRan).toBe(0);
  });
});
