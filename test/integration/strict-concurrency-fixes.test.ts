/**
 * Regression suite for three strict-concurrency / saga slot-accounting defects
 * (v2.4.0 adversarial review).
 *
 * FINDING #5 — slot leak on idempotency-deduped start. With strict concurrency
 *   + an idempotencyKey, `define.start()` claimed a slot (+1) BEFORE
 *   `engine.start`, which short-circuits to the already-active run WITHOUT
 *   throwing — so the catch-based releaseSlot never fired and the slot leaked.
 *   For limit:1 the bucket wedged after the first duplicate submit. FIX:
 *   idempotency-active-run pre-check BEFORE claimSlot.
 *
 * FINDING #6 — saga slot release timing + compensation-terminal release +
 *   multi-engine double-release. A saga run emits `workflow:failed` then enters
 *   `compensating` (still slot-holding); releasing on `failed` oversubscribes a
 *   strict cap. FIX: don't release on `failed` when the run will compensate;
 *   release on `compensated`/`compensation_failed`; release is idempotent per
 *   run; the listener is guarded on `run.workflowId === this.definition.id` so
 *   a shared-bus second engine doesn't double-decrement.
 *
 * FINDING #7 — `compensating` excluded from countActiveByConcurrencyKey, so a
 *   best-effort bucket full of compensating runs over-promoted a queued draft.
 *   FIX: include `compensating` in the active `$in`.
 */

import { describe, expect, it } from 'vitest';
import {
  ConcurrencyLimitReachedError,
  createContainer,
  createWorkflow,
  WorkflowRunModel,
} from '../../src/index.js';
import { WorkflowConcurrencyCounterModel } from '../../src/storage/concurrency-counter.model.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { useTestDb } from '../helpers/lifecycle.js';

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Finding #5 — idempotency dedup must not leak a strict slot', () => {
  useTestDb();

  it('limit:1 + same idempotencyKey twice → one active run, counter===1, bucket not wedged', async () => {
    const wfId = uid('strict-idem');
    const wf = createWorkflow(wfId, {
      steps: {
        // Park on a wait so the run stays ACTIVE (holds its slot) for the test.
        hold: async (ctx) => ctx.waitFor('release'),
      },
      concurrency: { strict: true, limit: 1, key: () => 'bucket' },
    });

    const idem = 'same-key';
    const r1 = await wf.start({}, { idempotencyKey: idem });
    const r2 = await wf.start({}, { idempotencyKey: idem });

    // Dedup worked — same logical run.
    expect(r2._id).toBe(r1._id);

    const counterId = `${wfId}:bucket`;
    const counter = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    // Exactly ONE slot held. Pre-fix the deduped 2nd start leaked +1 → count 2.
    expect(counter?.count).toBe(1);

    // Terminate the run (cancel → terminal); the slot must drop to 0.
    await wf.cancel(r1._id);
    await sleep(100); // let the release listener fire

    const after = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    expect(after?.count).toBe(0);

    // A fresh start succeeds — proves the bucket is not permanently wedged.
    const r3 = await wf.start({}, { idempotencyKey: 'different-key' });
    expect(r3.status).toBe('running');

    wf.shutdown();
  });
});

describe('Finding #6 — saga slot held through compensation, released exactly once', () => {
  useTestDb();

  it('limit:1 saga: B cannot start while A compensates; slot released once at compensation-terminal', async () => {
    const wfId = uid('strict-saga');
    const compensateStarted = { at: 0 };
    let releaseFinished = false;

    const wf = createWorkflow(wfId, {
      steps: {
        a: {
          handler: async () => 'a',
          onCompensate: async () => {
            compensateStarted.at = Date.now();
            // Block long enough to observe the slot is HELD during rollback.
            await sleep(500);
          },
        },
        b: {
          handler: async () => {
            throw new Error('boom');
          },
          retries: 0, // fail immediately → no retry-waiting detour before compensation
        },
      },
      concurrency: { strict: true, limit: 1, key: () => 'bucket' },
      autoExecute: false,
    });

    const counterId = `${wfId}:bucket`;

    // Start A and drive it: step a done, step b throws → failed → compensating.
    const runA = await wf.start({}, { idempotencyKey: 'A' });
    const execA = wf.execute(runA._id); // resolves only after compensation settles

    // While A is compensating, the slot must STILL be held → B rejects.
    await sleep(150);
    const aMid = await WorkflowRunModel.findById(runA._id).lean();
    expect(aMid?.status).toBe('compensating');
    const midCounter = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    // Slot held through compensation. Pre-fix, releasing on `failed` already
    // freed it (count 0) → oversubscription.
    expect(midCounter?.count).toBe(1);

    await expect(wf.start({}, { idempotencyKey: 'B' })).rejects.toThrow(
      ConcurrencyLimitReachedError,
    );

    // Let A's compensation settle.
    const finalA = await execA;
    expect(finalA.status).toBe('compensated');
    await sleep(150); // let the compensated-release listener fire
    releaseFinished = true;

    const endCounter = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    // Released exactly once → 0 (idempotent: not -1, not stuck at 1).
    expect(endCounter?.count).toBe(0);
    expect(releaseFinished).toBe(true);

    // Now B can start — slot freed.
    const runB = await wf.start({}, { idempotencyKey: 'B' });
    expect(runB.status).toBe('running');

    wf.shutdown();
  });

  it('shared-bus two-engine completion decrements the counter exactly once (H3 guard)', async () => {
    // Two DIFFERENT workflows share ONE container (one event bus). Each engine's
    // release listener receives the OTHER's terminal events too; the workflowId
    // guard ensures only the owning engine releases its run's slot.
    const container = createContainer();
    const wfIdA = uid('shared-A');
    const wfIdB = uid('shared-B');

    const wfA = createWorkflow(wfIdA, {
      steps: { only: async () => 'a' },
      concurrency: { strict: true, limit: 5, key: () => 'k' },
      container,
      autoExecute: false,
    });
    const wfB = createWorkflow(wfIdB, {
      steps: { only: async () => 'b' },
      concurrency: { strict: true, limit: 5, key: () => 'k' },
      container,
      autoExecute: false,
    });

    const counterIdA = `${wfIdA}:k`;

    // TWO active runs of wfA hold the bucket at count 2. (Completing just one
    // and asserting 0 would NOT isolate the H3 bug — releaseSlot's `count > 0`
    // guard clamps a double-release at 0. Holding a second run means a spurious
    // second decrement is OBSERVABLE: 2 → expected 1, bug → 0.)
    const runA1 = await wfA.start({});
    const runA2 = await wfA.start({});
    void runA2;
    expect((await WorkflowConcurrencyCounterModel.findById(counterIdA).lean())?.count).toBe(2);

    // Complete A1. Both engines' listeners fire on the shared bus. Only wfA's
    // (workflowId match) should decrement counterIdA, 2 → 1. Pre-H3-guard, wfB's
    // listener ALSO reads A1's run, sees its counterId, and decrements again
    // (2 → 1 → 0) — a phantom release that under-counts the still-active runA2.
    await wfA.execute(runA1._id);
    await wfA.waitFor(runA1._id, { pollInterval: 50, timeout: 3_000 });
    await sleep(150);

    const counterA = await WorkflowConcurrencyCounterModel.findById(counterIdA).lean();
    // Exactly ONE decrement for the one completed run → 1 (runA2 still holds).
    expect(counterA?.count).toBe(1);

    wfA.shutdown();
    wfB.shutdown();
  });
});

describe('Finding #7 — compensating runs count toward the best-effort active cap', () => {
  useTestDb();

  it('a bucket full of compensating runs does NOT admit a draft over the limit', async () => {
    const wfId = uid('besteffort-comp');
    const key = 'bucket';

    // Seed a `compensating` run directly (the crash/rollback shape).
    await WorkflowRunModel.create({
      _id: uid('comp-run'),
      workflowId: wfId,
      status: 'compensating',
      concurrencyKey: key,
      steps: [{ stepId: 'a', status: 'done', attempts: 1 }],
      currentStepId: 'a',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
    } as never);

    // Pre-fix this counted 0 active (compensating excluded) → admitted.
    const active = await workflowRunRepository.countActiveByConcurrencyKey(wfId, key, {
      bypassTenant: true,
    });
    expect(active).toBe(1);

    // Best-effort (non-strict) limit:1 workflow → a new start must be queued as
    // a DRAFT, not admitted as running, because the bucket is full.
    const wf = createWorkflow(wfId, {
      steps: { a: async () => 'a' },
      concurrency: { limit: 1, key: () => key },
      autoExecute: false,
    });

    const queued = await wf.start({});
    expect(queued.status).toBe('draft');

    wf.shutdown();
  });
});

describe('Follow-up review — idempotency allowlist + shutdown listener teardown', () => {
  useTestDb();

  it('P2a: a SETTLED saga run (compensated) does not block a new start with the same idempotencyKey', async () => {
    const wfId = uid('idem-settled');
    const settledId = uid('settled');
    // Seed a settled (compensated) saga run carrying an idempotencyKey.
    await WorkflowRunModel.create({
      _id: settledId,
      workflowId: wfId,
      status: 'compensated',
      idempotencyKey: 'order-42',
      steps: [{ stepId: 'a', status: 'done', attempts: 1 }],
      currentStepId: 'a',
      context: {},
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      endedAt: new Date(),
    } as never);

    // Pre-fix: findActiveByIdempotencyKey used $nin:['done','failed','cancelled'],
    // so 'compensated' counted as ACTIVE → returned the settled run as a dedup hit.
    const active = await workflowRunRepository.findActiveByIdempotencyKey('order-42', {
      bypassTenant: true,
    });
    expect(active).toBeNull(); // compensated is reusable, not active

    // A fresh start with the same key must create a NEW run, not return the settled one.
    const wf = createWorkflow(wfId, { steps: { a: async () => 'a' }, autoExecute: false });
    const fresh = await wf.start({}, { idempotencyKey: 'order-42' });
    expect(fresh._id).not.toBe(settledId);
    wf.shutdown();
  });

  it('P1: shutdown() removes the slot-release listeners — a recreated same-workflowId engine on a shared bus is not double-released by the old one', async () => {
    const container = createContainer();
    const wfId = uid('recreate-leak');
    const key = 'k';
    const make = () =>
      createWorkflow(wfId, {
        steps: { only: async () => 'x' },
        concurrency: { strict: true, limit: 5, key: () => key },
        container,
        autoExecute: false,
      });

    // E1 registers its 5 slot-release listeners on the shared bus, then is torn down.
    const e1 = make();
    e1.shutdown(); // must remove e1's listeners

    // E2: same workflowId, same shared bus. Hold the bucket at 2 (so a phantom
    // second decrement is observable past releaseSlot's count>0 clamp).
    const e2 = make();
    const counterId = `${wfId}:${key}`;
    const r1 = await e2.start({});
    void (await e2.start({}));
    expect((await WorkflowConcurrencyCounterModel.findById(counterId).lean())?.count).toBe(2);

    // Complete r1. Only E2's listener should fire (2→1). If e1's listeners leaked,
    // they ALSO match workflowId and decrement again (2→1→0).
    await e2.execute(r1._id);
    await e2.waitFor(r1._id, { pollInterval: 50, timeout: 3_000 });
    await sleep(150);

    const counter = await WorkflowConcurrencyCounterModel.findById(counterId).lean();
    expect(counter?.count).toBe(1); // exactly one decrement; pre-fix → 0

    e2.shutdown();
  });
});
