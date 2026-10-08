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
  ErrorCodeHierarchical,
  type Workflow,
  type WorkflowConfig,
} from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

interface JobInput {
  jobId: string;
}
type JobContext = { jobId: string };

const counters = () => env.container.concurrencyCounterRepository;

function makeStrictWorkflow(
  name: string,
  limit: number,
  handler: () => Promise<unknown> = async () => 'ok',
): Workflow<JobContext, JobInput> {
  return env.workflow<JobContext, JobInput>(name, {
    steps: { run: handler },
    concurrency: {
      key: (input) => input.jobId,
      limit,
      strict: true,
    },
  });
}

describe('Strict concurrency — atomic claim, reject when full', () => {
  it('admits up to `limit` starts, rejects the (limit+1)th with ConcurrencyLimitReachedError', async () => {
    const wf = makeStrictWorkflow('strict-reject', 2);

    // Script: 3 starts, same key, sequential.
    const r1 = await wf.start({ jobId: 'job-1' });
    const r2 = await wf.start({ jobId: 'job-1' });

    expect(r1.status).toBe('running');
    expect(r2.status).toBe('running');

    // Third start hits the limit — strict mode REJECTS, not queues.
    await expect(wf.start({ jobId: 'job-1' })).rejects.toThrow(ConcurrencyLimitReachedError);

    // Counter doc reflects the 2 in-flight runs. Read raw — `env.counter()`
    // returns only count/rev, and this asserts the stored `limit` too.
    const counter = await counters().Model.findById(`${wf.engine.definition.id}:job-1`).lean();
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
        workflowId: wf.engine.definition.id,
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

    const docs = await counters().Model.find({ workflowId: wf.engine.definition.id }).lean();
    expect(docs).toHaveLength(3);
    for (const ctr of docs) {
      expect(ctr.count).toBe(1);
    }
  });
});

describe('Strict concurrency — counter lifecycle', () => {
  it('decrements counter on workflow:completed', async () => {
    const wf = makeStrictWorkflow('strict-release-completed', 1);

    const run = await wf.start({ jobId: 'job-1' });
    expect(run.status).toBe('running');

    // Drive the run to completion.
    await wf.execute(run._id);
    const final = await env.until(run._id, 'done');
    expect(final.status).toBe('done');

    // The bus listener is async — wait for the release to land.
    await env.eventually(async () => expect((await env.counter(wf, 'job-1'))?.count).toBe(0));

    // Slot freed — next start succeeds.
    const next = await wf.start({ jobId: 'job-1' });
    expect(next.status).toBe('running');
  });

  it('decrements counter on workflow:failed', async () => {
    const wf = makeStrictWorkflow('strict-release-failed', 1, async () => {
      throw new Error('boom');
    });

    const run = await wf.start({ jobId: 'job-1' });
    await wf.execute(run._id).catch(() => undefined);
    const final = await env.until(run._id, 'failed');
    expect(final.status).toBe('failed');

    await env.eventually(async () => expect((await env.counter(wf, 'job-1'))?.count).toBe(0));

    // Slot freed.
    const next = await wf.start({ jobId: 'job-1' });
    expect(next.status).toBe('running');
  });

  it('decrements counter on workflow:cancelled', async () => {
    const wf = makeStrictWorkflow('strict-release-cancelled', 1);

    const run = await wf.start({ jobId: 'job-1' });
    await wf.cancel(run._id);

    await env.eventually(async () => expect((await env.counter(wf, 'job-1'))?.count).toBe(0));
  });

  it('releaseSlot is idempotent — never drops below zero on duplicate fires', async () => {
    // Direct test of the repo primitive — counter at 1, two releases, ends at 0.
    const counterId = 'idempotent-release:k1';
    await counters().claimSlot(counterId, 5, 'idempotent-release', 'k1');
    expect((await env.counter('idempotent-release', 'k1'))?.count).toBe(1);

    await counters().releaseSlot(counterId);
    expect((await env.counter('idempotent-release', 'k1'))?.count).toBe(0);

    // Second release — must NOT push count to -1.
    await counters().releaseSlot(counterId);
    expect((await env.counter('idempotent-release', 'k1'))?.count).toBe(0);
  });
});

describe('Strict concurrency — race safety vs best-effort', () => {
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
    expect((await env.counter(wf, 'race-key'))?.count).toBe(2);
  });
});

describe('Strict concurrency — reconcile() drift repair (v2.4.0 hardening #5)', () => {
  it('resets a leaked counter (higher than truth) down to the true active-run count', async () => {
    // Two real active runs hold slots; simulate a +3 leak (workers that died
    // between claimSlot and repository.create), then reconcile back to truth.
    const wf = makeStrictWorkflow('reconcile-leak', 10);
    const wfId = wf.engine.definition.id;
    await wf.start({ jobId: 'k1' });
    await wf.start({ jobId: 'k1' });

    const counterId = `${wfId}:k1`;
    // Inflate the counter to simulate leaked slots.
    await counters().Model.updateOne({ _id: counterId }, { $set: { count: 5 } });
    expect((await env.counter(wf, 'k1'))?.count).toBe(5);

    // Single-bucket reconcile returns the corrected count.
    const corrected = await counters().reconcile(wfId, 'k1', { settleMs: 0 });
    expect(corrected).toBe(2);
    expect((await env.counter(wf, 'k1'))?.count).toBe(2);
  });

  it('leaves an already-correct counter unchanged (idempotent)', async () => {
    const wf = makeStrictWorkflow('reconcile-noop', 10);
    const wfId = wf.engine.definition.id;
    await wf.start({ jobId: 'k1' });

    expect((await env.counter(wf, 'k1'))?.count).toBe(1);

    const corrected = await counters().reconcile(wfId, 'k1');
    expect(corrected).toBe(1);
    expect((await env.counter(wf, 'k1'))?.count).toBe(1);

    // Re-running is idempotent.
    expect(await counters().reconcile(wfId, 'k1')).toBe(1);
    expect((await env.counter(wf, 'k1'))?.count).toBe(1);
  });

  it('whole-workflow reconcile repairs every bucket and returns the summed count', async () => {
    const wf = makeStrictWorkflow('reconcile-all', 10);
    const wfId = wf.engine.definition.id;
    await wf.start({ jobId: 'a' }); // 1 active in bucket a
    await wf.start({ jobId: 'b' });
    await wf.start({ jobId: 'b' }); // 2 active in bucket b

    // Leak both buckets.
    await counters().Model.updateOne({ _id: `${wfId}:a` }, { $set: { count: 9 } });
    await counters().Model.updateOne({ _id: `${wfId}:b` }, { $set: { count: 7 } });

    const total = await counters().reconcile(wfId, undefined, { settleMs: 0 });
    expect(total).toBe(3); // 1 + 2

    expect((await env.counter(wf, 'a'))?.count).toBe(1);
    expect((await env.counter(wf, 'b'))?.count).toBe(2);
  });
});

describe('Strict concurrency — release is exactly-once per run (durable)', () => {
  it('two live versions of one workflow release a finished run ONCE', async () => {
    // v1 and v2 on one bus both pass the workflowId guard; a process-local
    // dedupe could not see the other engine's release.
    const config: WorkflowConfig<JobContext, JobInput> = {
      steps: { run: async () => 'ok' },
      concurrency: { key: (input) => input.jobId, limit: 5, strict: true },
    };
    const v1 = env.workflow<JobContext, JobInput>('strict-two-versions', {
      ...config,
      version: '1.0.0',
    });
    env.redefine(v1, { ...config, version: '1.1.0' });

    const finishing = await v1.start({ jobId: 'k' });
    await v1.start({ jobId: 'k' }); // still holds its slot
    expect((await env.counter(v1, 'k'))?.count).toBe(2);

    await v1.execute(finishing._id);
    await env.eventually(async () => expect((await env.counter(v1, 'k'))?.count).toBe(1), {
      timeout: 2000,
    });
    await new Promise((r) => setTimeout(r, 100)); // deliberate window: let any second release land

    expect((await env.counter(v1, 'k'))?.count).toBe(1);
  });

  it('a re-emitted terminal event does not release a slot it no longer holds', async () => {
    const wf = env.workflow<JobContext, JobInput>('strict-reemit', {
      steps: { run: async () => 'ok' },
      concurrency: { key: (input) => input.jobId, limit: 5, strict: true },
    });
    const done = await wf.start({ jobId: 'k' });
    await wf.start({ jobId: 'k' });
    await wf.execute(done._id);
    await env.eventually(async () => expect((await env.counter(wf, 'k'))?.count).toBe(1), {
      timeout: 2000,
    });

    // Replays after recovery / a transport redelivery.
    wf.container.eventBus.emit('workflow:completed', { runId: done._id, data: 'ok' });
    wf.container.eventBus.emit('workflow:completed', { runId: done._id, data: 'ok' });
    await new Promise((r) => setTimeout(r, 150)); // deliberate window: a wrong release would land here

    expect((await env.counter(wf, 'k'))?.count).toBe(1);
    const stored = await env.runs.get(done._id);
    expect((stored?.meta as Record<string, unknown>)?.concurrencySlotReleasedAt).toBeInstanceOf(
      Date,
    );
  });

  it('a version without handlers does not free the slot of a run its pinned saga version will compensate', async () => {
    let duringCompensation: number | undefined;
    let workflowId = '';
    const v1 = env.workflow<JobContext, JobInput>('strict-saga-versions', {
      version: '1.0.0',
      steps: {
        charge: {
          handler: async () => 'charged',
          onCompensate: async () => {
            await new Promise((r) => setTimeout(r, 150));
            duringCompensation = (await env.counter(workflowId, 'k'))?.count;
          },
        },
        boom: {
          handler: async () => {
            throw new Error('boom');
          },
          retries: 1,
        },
      },
      concurrency: { key: (input) => input.jobId, limit: 5, strict: true },
    });
    workflowId = v1.engine.definition.id;
    const run = await v1.start({ jobId: 'k' });

    // v1.1 has no compensation handlers: on its own it would release on `failed`.
    env.redefine<JobContext, JobInput>(v1, {
      version: '1.1.0',
      steps: { charge: async () => 'charged', boom: async () => 'ok' },
      concurrency: { key: (input) => input.jobId, limit: 5, strict: true },
    });

    const final = await v1.execute(run._id);
    expect(final.status).toBe('compensated');
    // Mid-rollback the slot was still held (sampled inside onCompensate, after
    // giving a wrong early release on `failed` time to land).
    expect(duringCompensation).toBe(1);
    await env.eventually(async () => expect((await env.counter(v1, 'k'))?.count).toBe(0), {
      timeout: 2000,
    });
    const stored = await env.runs.get(run._id);
    expect((stored?.meta as Record<string, unknown>)?.concurrencySlotReleasedAt).toBeInstanceOf(
      Date,
    );
  });
});

describe('Strict concurrency — reconcile() on a live bucket', () => {
  it('does not lower a counter touched within settleMs (claim whose run is not persisted yet)', async () => {
    const wf = makeStrictWorkflow('reconcile-settle', 10);
    const wfId = wf.engine.definition.id;
    await wf.start({ jobId: 'k1' });
    // A claim with no run yet — indistinguishable from a leak, but fresh.
    await counters().claimSlot(`${wfId}:k1`, 10, wfId, 'k1');

    expect(await counters().reconcile(wfId, 'k1')).toBe(2);
    expect((await env.counter(wf, 'k1'))?.count).toBe(2);

    // Once quiet, the same recount repairs it.
    expect(await counters().reconcile(wfId, 'k1', { settleMs: 0 })).toBe(1);
  });

  it('raises an under-counted bucket immediately, and every claim/release bumps rev', async () => {
    const wf = makeStrictWorkflow('reconcile-raise', 10);
    const wfId = wf.engine.definition.id;
    await wf.start({ jobId: 'k1' });
    await wf.start({ jobId: 'k1' });
    const id = `${wfId}:k1`;
    expect((await env.counter(wf, 'k1'))?.rev).toBe(2);

    await counters().Model.updateOne({ _id: id }, { $set: { count: 0 } });
    expect(await counters().reconcile(wfId, 'k1')).toBe(2);
    const after = await env.counter(wf, 'k1');
    expect(after?.count).toBe(2);
    expect(after?.rev).toBe(3);
  });

  it('recreates a lost counter doc from the active runs', async () => {
    const wf = makeStrictWorkflow('reconcile-lost', 10);
    const wfId = wf.engine.definition.id;
    await wf.start({ jobId: 'k1' });
    await counters().Model.deleteOne({ _id: `${wfId}:k1` });

    expect(await counters().reconcile(wfId, 'k1')).toBe(1);
    expect((await env.counter(wf, 'k1'))?.count).toBe(1);
  });
});

describe('Strict concurrency — config validation', () => {
  it('throws at definition time when `strict: true` without `limit`', () => {
    expect(() =>
      env.workflow<JobContext, JobInput>('strict-no-limit', {
        steps: { run: async () => 'ok' },
        concurrency: {
          key: (input: JobInput) => input.jobId,
          strict: true,
        } as never,
      }),
    ).toThrow(/strict requires a positive concurrency.limit/i);
  });

  it('throws at definition time when `strict: true` without `key`', () => {
    expect(() =>
      env.workflow('strict-no-key', {
        steps: { run: async () => 'ok' },
        concurrency: {
          limit: 5,
          strict: true,
        } as never,
      }),
    ).toThrow(/strict requires a 'key' function/i);
  });
});
