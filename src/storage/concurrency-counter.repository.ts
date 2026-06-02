/**
 * Strict-concurrency counter repository — atomic slot reservation.
 *
 * Backs `concurrency.strict: true` in workflow configs. Two domain
 * primitives wrap mongokit's `findOneAndUpdate`:
 *
 *   - `claimSlot(id, limit, …)` — atomically reserves a slot if
 *     `count < limit`. Upserts on first call. Returns `true` on success,
 *     `false` when at limit (the standard race-loss signal).
 *   - `releaseSlot(id)` — decrements the counter, with a `count > 0`
 *     guard so accidental over-decrement (drift recovery, replays)
 *     can't push it negative.
 *
 * Both use `findOneAndUpdate` directly (not `incrementIfBelow`), because
 * mongokit's `incrementIfBelow` doesn't support `upsert: true` and we
 * need first-call bootstrap. The hand-written upsert path catches
 * E11000 from the unique `_id` collision when the filter rejects an
 * existing doc — Mongo's documented "upsert race" pattern.
 *
 * Reconciliation: `reconcile(workflowId)` re-counts active runs per
 * bucket and resets the counter to truth. Use as a daily cron or after
 * confirmed worker crashes. The leak risk between `claimSlot` and
 * `repository.create` is bounded by parallelism × MTBF; reconciliation
 * sweeps it back to zero.
 */

import { Repository } from '@classytic/mongokit';
import {
  makeCounterId,
  type WorkflowConcurrencyCounter,
  WorkflowConcurrencyCounterModel,
} from './concurrency-counter.model.js';
import { WorkflowRunModel } from './run.model.js';

/**
 * Run statuses that hold a strict-concurrency slot. The slot is claimed at
 * `start()` (before the run exists) and released only when the run reaches a
 * TERMINAL state (`done`/`failed`/`cancelled`/`compensated`/`compensation_failed`).
 * So a run still holding a slot is in one of these non-terminal active states.
 * `compensating` is INCLUDED — a run mid-rollback hasn't released its slot yet
 * (mirrors the idempotency-index active set in run.model.ts). `draft` is
 * EXCLUDED for strict mode: strict claims the counter slot, never queues drafts.
 */
const SLOT_HOLDING_STATUSES = ['running', 'waiting', 'compensating'] as const;

export class WorkflowConcurrencyCounterRepository extends Repository<WorkflowConcurrencyCounter> {
  constructor() {
    // Counter docs are global per (workflowId, key) — the same scheduler
    // serves every tenant. No tenant-filter plugin wired here by design;
    // tenant scoping for strict concurrency would require a per-tenant
    // counter (= per-tenant rate limit), a different feature.
    super(WorkflowConcurrencyCounterModel);
  }

  /**
   * Atomically reserve a slot. Returns `true` on success, `false` if
   * the bucket is at limit.
   *
   * Single round-trip:
   *   1. `findOneAndUpdate({ _id, count: { $lt: limit } }, $inc count, upsert)`
   *   2. If filter matches existing doc: increment. Returns updated doc.
   *   3. If filter matches no doc (first call ever): upsert inserts a
   *      fresh counter with `count: 1`. Returns inserted doc.
   *   4. If existing doc has `count >= limit`: filter doesn't match, upsert
   *      collides on `_id` (E11000); the catch retries a non-upsert guarded
   *      increment — still no match at the cap, so it returns `false`.
   *   5. Cold-bucket race: two concurrent first-calls both upsert; one inserts
   *      `count:1`, the other gets E11000 and the retry admits it iff
   *      `count < limit` (fixes first-burst under-admission).
   *
   * `limit` is also stored in the doc (`$setOnInsert`) for diagnostics
   * — the runtime decision still uses the value passed here, so a
   * workflow that changes its limit gets the new value on the next
   * claim attempt.
   */
  async claimSlot(
    id: string,
    limit: number,
    workflowId: string,
    concurrencyKey: string,
  ): Promise<boolean> {
    const now = new Date();
    try {
      const result = await this.findOneAndUpdate(
        { _id: id, count: { $lt: limit } },
        {
          $inc: { count: 1 },
          $set: { updatedAt: now },
          $setOnInsert: { workflowId, concurrencyKey, limit, createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return result !== null;
    } catch (err) {
      // E11000 means a CONCURRENT claim just inserted the counter doc
      // (cold-bucket race): our `{count:{$lt:limit}}` filter matched no doc
      // (none existed yet), upsert tried to insert, and collided on `_id`.
      // The doc now EXISTS, so the bucket is NOT necessarily full — retry the
      // guarded increment WITHOUT upsert. It admits when count<limit, and only
      // returns null (→ false) if the racer's insert already reached the cap.
      if (this.isDuplicateKeyError(err)) {
        const retried = await this.findOneAndUpdate(
          { _id: id, count: { $lt: limit } },
          { $inc: { count: 1 }, $set: { updatedAt: now } },
          { returnDocument: 'after' },
        );
        return retried !== null;
      }
      throw err;
    }
  }

  /**
   * Decrement the counter. The `count > 0` guard prevents drift below
   * zero if a release fires twice (cancel-while-shutting-down,
   * idempotent retry of the completion event listener). Idempotent by
   * construction.
   */
  async releaseSlot(id: string): Promise<void> {
    await this.findOneAndUpdate(
      { _id: id, count: { $gt: 0 } },
      { $inc: { count: -1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
  }

  /** Read a counter doc without mutating it (diagnostics / admin UIs). */
  async getCounter(id: string): Promise<WorkflowConcurrencyCounter | null> {
    return (await this.getById(id)) as WorkflowConcurrencyCounter | null;
  }

  /**
   * Repair counter drift/leaks by recomputing the TRUE active-run count and
   * resetting the counter doc(s) to it.
   *
   * A counter can leak +1 when a worker dies AFTER `claimSlot` but BEFORE the
   * run is persisted (no run exists to release the slot), or skew if a release
   * is missed. This recounts the actual slot-holding runs
   * ({@link SLOT_HOLDING_STATUSES}) for `workflowId` (+ `concurrencyKey` if
   * given) and atomically `$set`s the counter `count` to the truth.
   *
   * Modes:
   *   - `reconcile(workflowId, key)` — repair ONE bucket; returns its count.
   *   - `reconcile(workflowId)` — repair EVERY existing counter doc for the
   *     workflow; returns the SUM of the corrected counts.
   *
   * Idempotent: re-running with no concurrent activity yields the same result
   * and a correct counter is left unchanged. Small window (documented): a
   * concurrent `claimSlot`/`releaseSlot` racing the recount-then-set can be
   * over/under-written by ±1 until the next reconcile; run from a low-traffic
   * cron or after confirmed worker crashes, when the bucket is quiescent.
   *
   * @returns the corrected count (single bucket) or the summed corrected count
   *   (whole workflow).
   */
  async reconcile(workflowId: string, concurrencyKey?: string): Promise<number> {
    if (concurrencyKey !== undefined) {
      return this.reconcileBucket(workflowId, concurrencyKey);
    }

    // Whole-workflow: repair every existing counter bucket for this workflow.
    const counters = (await this.findAll({ workflowId }, {
      lean: true,
      bypassTenant: true,
    } as Parameters<
      Repository<WorkflowConcurrencyCounter>['findAll']
    >[1])) as WorkflowConcurrencyCounter[];

    let total = 0;
    for (const counter of counters) {
      total += await this.reconcileBucket(workflowId, counter.concurrencyKey);
    }
    return total;
  }

  /** Recount one `(workflowId, key)` bucket and reset its counter to truth. */
  private async reconcileBucket(workflowId: string, concurrencyKey: string): Promise<number> {
    // Count the runs that actually still hold a slot. Query the run model
    // directly (cross-tenant — the strict counter is a global gate, same
    // rationale as the repository's no-tenant-plugin design above).
    const trueCount = await WorkflowRunModel.countDocuments({
      workflowId,
      concurrencyKey,
      status: { $in: SLOT_HOLDING_STATUSES },
    });

    const id = makeCounterId(workflowId, concurrencyKey);
    const now = new Date();

    // Atomically set the counter to truth. Upsert so a bucket whose counter
    // doc was lost (but which has active runs) is recreated; `$setOnInsert`
    // backfills the immutable bootstrap fields only on creation.
    await this.findOneAndUpdate(
      { _id: id },
      {
        $set: { count: trueCount, updatedAt: now },
        $setOnInsert: { workflowId, concurrencyKey, limit: trueCount, createdAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );

    return trueCount;
  }
}

/**
 * Singleton — counter docs live in a global collection (no per-container
 * sharding); one repo handle is enough. Mirrors `workflowRunRepository`'s
 * default-singleton export pattern in `run.repository.ts`.
 */
export const workflowConcurrencyCounterRepository = new WorkflowConcurrencyCounterRepository();
