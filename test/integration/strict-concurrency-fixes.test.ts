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
import { ConcurrencyLimitReachedError } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Finding #5 — idempotency dedup must not leak a strict slot', () => {
  it('limit:1 + same idempotencyKey twice → one active run, counter===1, bucket not wedged', async () => {
    const wf = env.workflow('strict-idem', {
      steps: {
        // Park on a wait so the run stays ACTIVE (holds its slot) for the test.
        hold: async (ctx) => ctx.waitFor('release'),
      },
      concurrency: { strict: true, limit: 1, key: () => 'bucket' },
      autoExecute: true,
    });

    const idem = 'same-key';
    const r1 = await wf.start({}, { idempotencyKey: idem });
    const r2 = await wf.start({}, { idempotencyKey: idem });

    // Dedup worked — same logical run.
    expect(r2._id).toBe(r1._id);

    // Exactly ONE slot held. Pre-fix the deduped 2nd start leaked +1 → count 2.
    expect((await env.counter(wf, 'bucket'))?.count).toBe(1);

    // Terminate the run (cancel → terminal); the slot must drop to 0 once the
    // release listener fires.
    await wf.cancel(r1._id);
    await env.eventually(async () => expect((await env.counter(wf, 'bucket'))?.count).toBe(0));

    // A fresh start succeeds — proves the bucket is not permanently wedged.
    const r3 = await wf.start({}, { idempotencyKey: 'different-key' });
    expect(r3.status).toBe('running');
  });
});

describe('Finding #6 — saga slot held through compensation, released exactly once', () => {
  it('limit:1 saga: B cannot start while A compensates; slot released once at compensation-terminal', async () => {
    const wf = env.workflow('strict-saga', {
      steps: {
        a: {
          handler: async () => 'a',
          onCompensate: async () => {
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
    });

    // Start A and drive it: step a done, step b throws → failed → compensating.
    const runA = await wf.start({}, { idempotencyKey: 'A' });
    const execA = wf.execute(runA._id); // resolves only after compensation settles

    // While A is compensating, the slot must STILL be held → B rejects.
    const aMid = await env.until(runA._id, 'compensating');
    expect(aMid.status).toBe('compensating');
    // Slot held through compensation. Pre-fix, releasing on `failed` already
    // freed it (count 0) → oversubscription.
    expect((await env.counter(wf, 'bucket'))?.count).toBe(1);

    await expect(wf.start({}, { idempotencyKey: 'B' })).rejects.toThrow(
      ConcurrencyLimitReachedError,
    );

    // Let A's compensation settle.
    const finalA = await execA;
    expect(finalA.status).toBe('compensated');

    // Released exactly once → 0 (idempotent: not -1, not stuck at 1).
    await env.eventually(async () => expect((await env.counter(wf, 'bucket'))?.count).toBe(0));

    // Now B can start — slot freed.
    const runB = await wf.start({}, { idempotencyKey: 'B' });
    expect(runB.status).toBe('running');
  });

  it('shared-bus two-engine completion decrements the counter exactly once (H3 guard)', async () => {
    // Two DIFFERENT workflows share ONE container (one event bus). Each engine's
    // release listener receives the OTHER's terminal events too; the workflowId
    // guard ensures only the owning engine releases its run's slot.
    const wfA = env.workflow('shared-A', {
      steps: { only: async () => 'a' },
      concurrency: { strict: true, limit: 5, key: () => 'k' },
    });
    env.workflow('shared-B', {
      steps: { only: async () => 'b' },
      concurrency: { strict: true, limit: 5, key: () => 'k' },
    });

    // TWO active runs of wfA hold the bucket at count 2. (Completing just one
    // and asserting 0 would NOT isolate the H3 bug — releaseSlot's `count > 0`
    // guard clamps a double-release at 0. Holding a second run means a spurious
    // second decrement is OBSERVABLE: 2 → expected 1, bug → 0.)
    const runA1 = await wfA.start({});
    await wfA.start({});
    expect((await env.counter(wfA, 'k'))?.count).toBe(2);

    // Complete A1. Both engines' listeners fire on the shared bus. Only wfA's
    // (workflowId match) should decrement counterIdA, 2 → 1. Pre-H3-guard, wfB's
    // listener ALSO reads A1's run, sees its counterId, and decrements again
    // (2 → 1 → 0) — a phantom release that under-counts the still-active runA2.
    await wfA.execute(runA1._id);
    await env.until(runA1._id, 'done');
    await env.eventually(async () => expect((await env.counter(wfA, 'k'))?.count).toBe(1));
    await sleep(150); // deliberate window: a phantom second decrement would land here

    // Exactly ONE decrement for the one completed run → 1 (runA2 still holds).
    expect((await env.counter(wfA, 'k'))?.count).toBe(1);
  });
});

describe('Finding #7 — compensating runs count toward the best-effort active cap', () => {
  it('a bucket full of compensating runs does NOT admit a draft over the limit', async () => {
    const key = 'bucket';
    // Best-effort (non-strict) limit:1 workflow.
    const wf = env.workflow('besteffort-comp', {
      steps: { a: async () => 'a' },
      concurrency: { limit: 1, key: () => key },
    });
    const wfId = wf.engine.definition.id;

    // Seed a `compensating` run directly (the crash/rollback shape).
    await env.runs.insert(wf, {
      status: 'compensating',
      concurrencyKey: key,
      steps: [{ stepId: 'a', status: 'done', attempts: 1 }],
      currentStepId: 'a',
      startedAt: new Date(),
    });

    // Pre-fix this counted 0 active (compensating excluded) → admitted.
    const active = await env.container.repository.countActiveByConcurrencyKey(wfId, key, {
      bypassTenant: true,
    });
    expect(active).toBe(1);

    // A new start must be queued as a DRAFT, not admitted as running, because
    // the bucket is full.
    const queued = await wf.start({});
    expect(queued.status).toBe('draft');
  });
});

describe('Follow-up review — idempotency allowlist + shutdown listener teardown', () => {
  it('P2a: a SETTLED saga run (compensated) does not block a new start with the same idempotencyKey', async () => {
    const wf = env.workflow('idem-settled', { steps: { a: async () => 'a' } });
    // Seed a settled (compensated) saga run carrying an idempotencyKey.
    const settled = await env.runs.insert(wf, {
      status: 'compensated',
      idempotencyKey: 'order-42',
      steps: [{ stepId: 'a', status: 'done', attempts: 1 }],
      currentStepId: 'a',
      startedAt: new Date(),
      endedAt: new Date(),
    });

    // Pre-fix: findActiveByIdempotencyKey used $nin:['done','failed','cancelled'],
    // so 'compensated' counted as ACTIVE → returned the settled run as a dedup hit.
    const active = await env.container.repository.findActiveByIdempotencyKey('order-42', {
      bypassTenant: true,
    });
    expect(active).toBeNull(); // compensated is reusable, not active

    // A fresh start with the same key must create a NEW run, not return the settled one.
    const fresh = await wf.start({}, { idempotencyKey: 'order-42' });
    expect(fresh._id).not.toBe(settled._id);
  });

  it('P1: shutdown() removes the slot-release listeners — a recreated same-workflowId engine on a shared bus is not double-released by the old one', async () => {
    const key = 'k';
    const config = {
      steps: { only: async () => 'x' },
      concurrency: { strict: true, limit: 5, key: () => key },
      container: env.container,
      autoExecute: false,
    };

    // E1 registers its 5 slot-release listeners on the shared bus, then is torn down.
    const e1 = env.workflow('recreate-leak', config);
    e1.shutdown(); // must remove e1's listeners

    // E2: same workflowId, same shared bus. Hold the bucket at 2 (so a phantom
    // second decrement is observable past releaseSlot's count>0 clamp).
    const e2 = env.redefine(e1, config);
    const r1 = await e2.start({});
    await e2.start({});
    expect((await env.counter(e2, key))?.count).toBe(2);

    // Complete r1. Only E2's listener should fire (2→1). If e1's listeners leaked,
    // they ALSO match workflowId and decrement again (2→1→0).
    await e2.execute(r1._id);
    await env.until(r1._id, 'done');
    await env.eventually(async () => expect((await env.counter(e2, key))?.count).toBe(1));
    await sleep(150); // deliberate window: a leaked listener's decrement would land here

    expect((await env.counter(e2, key))?.count).toBe(1); // exactly one decrement; pre-fix → 0
  });
});
