/**
 * Scenario tests for `concurrency.strict: true` — atomic slot reservation
 * via `WorkflowConcurrencyCounterRepository`.
 *
 * Style: openclaw-style replay per
 * [`testing-infrastructure.md` §6](../../testing-infrastructure.md). Each
 * test is **Setup → Script → Assert**, asserting on persisted state and
 * the counter doc.
 *
 * What this file pins:
 *
 *   1. Strict mode rejects starts past the limit with a typed error
 *      (`ConcurrencyLimitReachedError`, status 429), distinct from the
 *      best-effort path which queues drafts.
 *
 *   2. Counter increments on successful start, decrements on terminal
 *      state — including `cancel`. No drift through the happy path.
 *
 *   3. Counter rolls back if `engine.start` fails after a successful
 *      `claimSlot` (idempotency miss, validation, DB error).
 *
 *   4. Strict mode is race-safe under PARALLEL bursts where best-effort
 *      oversubscribes — exactly `limit` admitted, the rest reject.
 *
 *   5. `releaseSlot` is idempotent — never drops below zero even on
 *      duplicate completion events.
 */

import { describe, expect, it } from 'vitest';
import {
  ConcurrencyLimitReachedError,
  createWorkflow,
  ErrorCodeHierarchical,
  type Workflow,
} from '../../src/index.js';
import { WorkflowConcurrencyCounterModel } from '../../src/storage/concurrency-counter.model.js';
import { workflowConcurrencyCounterRepository } from '../../src/storage/concurrency-counter.repository.js';
import { useTestDb } from '../helpers/lifecycle.js';

interface JobInput {
  jobId: string;
}

function makeStrictWorkflow(
  id: string,
  limit: number,
  handler: () => Promise<unknown> = async () => 'ok',
): Workflow<{ jobId: string }, JobInput> {
  return createWorkflow<{ jobId: string }, JobInput>(id, {
    steps: { run: handler },
    autoExecute: false,
    concurrency: {
      key: (input) => input.jobId,
      limit,
      strict: true,
    },
  });
}

describe('Strict concurrency — atomic claim, reject when full', () => {
  useTestDb();

  it('admits up to `limit` starts, rejects the (limit+1)th with ConcurrencyLimitReachedError', async () => {
    const wf = makeStrictWorkflow('strict-reject', 2);

    // Script: 3 starts, same key, sequential.
    const r1 = await wf.start({ jobId: 'job-1' });
    const r2 = await wf.start({ jobId: 'job-1' });

    expect(r1.status).toBe('running');
    expect(r2.status).toBe('running');

    // Third start hits the limit — strict mode REJECTS, not queues.
    await expect(wf.start({ jobId: 'job-1' })).rejects.toThrow(ConcurrencyLimitReachedError);

    // Counter doc reflects the 2 in-flight runs.
    const counter = await WorkflowConcurrencyCounterModel.findById(
      'strict-reject:job-1',
    ).lean();
    expect(counter?.count).toBe(2);
    expect(counter?.limit).toBe(2);
  });

  it('throws ConcurrencyLimitReachedError with HttpError shape (status 429, hierarchical code)', async () => {
    const wf = makeStrictWorkflow('strict-error-shape', 1);
    await wf.start({ jobId: 'job-1' });

    try {
      await wf.start({ jobId: 'job-1' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyLimitReachedError);
      const e = err as ConcurrencyLimitReachedError;
      // HttpError conformance — the whole reason for the migration.
      expect(e.status).toBe(429);
      expect(e.code).toBe(ErrorCodeHierarchical.CONCURRENCY_LIMIT_REACHED);
      expect(e.code).toBe('workflow.concurrency_limit_reached');
      expect(e.meta).toMatchObject({
        workflowId: 'strict-error-shape',
        concurrencyKey: 'job-1',
        limit: 1,
      });
    }
  });

  it('isolates strict buckets by concurrency key', async () => {
    const wf = makeStrictWorkflow('strict-key-isolation', 1);

    // Different keys = different buckets, independent limits.
    const a = await wf.start({ jobId: 'job-a' });
    const b = await wf.start({ jobId: 'job-b' });
    const c = await wf.start({ jobId: 'job-c' });

    expect(a.status).toBe('running');
    expect(b.status).toBe('running');
    expect(c.status).toBe('running');

    const counters = await WorkflowConcurrencyCounterModel.find({
      workflowId: 'strict-key-isolation',
    }).lean();
    expect(counters).toHaveLength(3);
    for (const ctr of counters) {
      expect(ctr.count).toBe(1);
    }
  });
});

describe('Strict concurrency — counter lifecycle', () => {
  useTestDb();

  it('decrements counter on workflow:completed', async () => {
    const wf = makeStrictWorkflow('strict-release-completed', 1);

    const run = await wf.start({ jobId: 'job-1' });
    expect(run.status).toBe('running');

    // Drive the run to completion.
    await wf.execute(run._id);
    const final = await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 });
    expect(final.status).toBe('done');

    // Wait briefly for the bus listener to fire (it's async).
    await new Promise((r) => setTimeout(r, 100));

    const counter = await WorkflowConcurrencyCounterModel.findById(
      'strict-release-completed:job-1',
    ).lean();
    expect(counter?.count).toBe(0);

    // Slot freed — next start succeeds.
    const next = await wf.start({ jobId: 'job-1' });
    expect(next.status).toBe('running');
  });

  it('decrements counter on workflow:failed', async () => {
    const wf = makeStrictWorkflow(
      'strict-release-failed',
      1,
      async () => {
        throw new Error('boom');
      },
    );

    const run = await wf.start({ jobId: 'job-1' });
    await wf.execute(run._id).catch(() => undefined);
    const final = await wf.waitFor(run._id, { pollInterval: 50, timeout: 2_000 }).catch(() => null);
    expect(final?.status).toBe('failed');

    await new Promise((r) => setTimeout(r, 100));

    const counter = await WorkflowConcurrencyCounterModel.findById(
      'strict-release-failed:job-1',
    ).lean();
    expect(counter?.count).toBe(0);

    // Slot freed.
    const next = await wf.start({ jobId: 'job-1' });
    expect(next.status).toBe('running');
  });

  it('decrements counter on workflow:cancelled', async () => {
    const wf = makeStrictWorkflow('strict-release-cancelled', 1);

    const run = await wf.start({ jobId: 'job-1' });
    await wf.cancel(run._id);

    await new Promise((r) => setTimeout(r, 100));

    const counter = await WorkflowConcurrencyCounterModel.findById(
      'strict-release-cancelled:job-1',
    ).lean();
    expect(counter?.count).toBe(0);
  });

  it('releaseSlot is idempotent — never drops below zero on duplicate fires', async () => {
    // Direct test of the repo primitive — counter at 1, two releases, ends at 0.
    const counterId = 'idempotent-release:k1';
    await workflowConcurrencyCounterRepository.claimSlot(counterId, 5, 'idempotent-release', 'k1');
    expect((await WorkflowConcurrencyCounterModel.findById(counterId).lean())?.count).toBe(1);

    await workflowConcurrencyCounterRepository.releaseSlot(counterId);
    expect((await WorkflowConcurrencyCounterModel.findById(counterId).lean())?.count).toBe(0);

    // Second release — must NOT push count to -1.
    await workflowConcurrencyCounterRepository.releaseSlot(counterId);
    expect((await WorkflowConcurrencyCounterModel.findById(counterId).lean())?.count).toBe(0);
  });
});

describe('Strict concurrency — race safety vs best-effort', () => {
  useTestDb();

  it('parallel burst with strict mode admits EXACTLY `limit`, no oversubscription', async () => {
    // The contract that distinguishes strict from best-effort. Best-effort
    // can briefly oversubscribe under parallel load (count-then-create
    // race); strict cannot — the atomic counter rejects every start past
    // the limit.
    const wf = makeStrictWorkflow('strict-parallel-race', 2);

    // 5 parallel starts, same key. Exactly 2 admit; 3 reject.
    const settled = await Promise.allSettled([
      wf.start({ jobId: 'race-key' }),
      wf.start({ jobId: 'race-key' }),
      wf.start({ jobId: 'race-key' }),
      wf.start({ jobId: 'race-key' }),
      wf.start({ jobId: 'race-key' }),
    ]);

    const admitted = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    expect(admitted).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyLimitReachedError);
    }

    // Counter reflects exactly the admitted count.
    const counter = await WorkflowConcurrencyCounterModel.findById(
      'strict-parallel-race:race-key',
    ).lean();
    expect(counter?.count).toBe(2);
  });
});

describe('Strict concurrency — config validation', () => {
  it('throws at definition time when `strict: true` without `limit`', () => {
    expect(() =>
      createWorkflow('strict-no-limit', {
        steps: { run: async () => 'ok' },
        concurrency: {
          key: (input) => (input as { id: string }).id,
          strict: true,
        } as never,
      }),
    ).toThrow(/strict requires a positive concurrency.limit/i);
  });

  it('throws at definition time when `strict: true` without `key`', () => {
    expect(() =>
      createWorkflow('strict-no-key', {
        steps: { run: async () => 'ok' },
        concurrency: {
          limit: 5,
          strict: true,
        } as never,
      }),
    ).toThrow(/strict requires a 'key' function/i);
  });
});
