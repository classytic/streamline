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
import type { Model } from 'mongoose';
import type { WorkflowRun } from '../core/types.js';
import { makeCounterId, type WorkflowConcurrencyCounter } from './concurrency-counter.model.js';
import { WorkflowConcurrencyCounterModel, WorkflowRunModel } from './models.js';

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

/** CAS retries before `reconcile` leaves a persistently busy bucket alone. */
const RECONCILE_ATTEMPTS = 5;

/** Connection-aware models for the concurrency counter (default: the eager singletons). */
export interface ConcurrencyCounterConfig {
  /** Counter model to persist through. Default {@link WorkflowConcurrencyCounterModel}. */
  counterModel?: Model<WorkflowConcurrencyCounter>;
  /** Run model used by slot RECONCILIATION — MUST be on the same connection as the run repo. */
  runModel?: Model<WorkflowRun>;
}

export class WorkflowConcurrencyCounterRepository extends Repository<WorkflowConcurrencyCounter> {
  /** Run model consulted by {@link reconcileBucket} — same connection as the run repo. */
  private readonly runModel: Model<WorkflowRun>;

  constructor(config: ConcurrencyCounterConfig = {}) {
    // Counter docs are global per (workflowId, key) — the same scheduler
    // serves every tenant. No tenant-filter plugin wired here by design;
    // tenant scoping for strict concurrency would require a per-tenant
    // counter (= per-tenant rate limit), a different feature.
    super(config.counterModel ?? WorkflowConcurrencyCounterModel);
    this.runModel = config.runModel ?? WorkflowRunModel;
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
          $inc: { count: 1, rev: 1 },
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
          { $inc: { count: 1, rev: 1 }, $set: { updatedAt: now } },
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
      { $inc: { count: -1, rev: 1 }, $set: { updatedAt: new Date() } },
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
   * Safe to run on a live bucket:
   *   - The write is a CAS on the counter's `rev` (bumped by every claim and
   *     release): a claim/release landing between the read and the recount
   *     fails the CAS and the bucket is re-read and recounted.
   *   - A claim whose run is not persisted YET looks exactly like a leak. So
   *     the counter is only LOWERED when its last claim/release is older than
   *     `settleMs` (default 5s — claim→create takes milliseconds); raising is
   *     always safe. A busy bucket keeps its count until a quiet moment.
   * Idempotent: a correct counter is left unchanged.
   *
   * @returns the bucket's count after reconciliation (single bucket) or the
   *   sum across buckets (whole workflow).
   */
  async reconcile(
    workflowId: string,
    concurrencyKey?: string,
    options: { settleMs?: number } = {},
  ): Promise<number> {
    const settleMs = options.settleMs ?? 5000;
    if (concurrencyKey !== undefined) {
      return this.reconcileBucket(workflowId, concurrencyKey, settleMs);
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
      total += await this.reconcileBucket(workflowId, counter.concurrencyKey, settleMs);
    }
    return total;
  }

  /** Recount one `(workflowId, key)` bucket and CAS its counter to truth. */
  private async reconcileBucket(
    workflowId: string,
    concurrencyKey: string,
    settleMs: number,
  ): Promise<number> {
    const id = makeCounterId(workflowId, concurrencyKey);

    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      // Read the counter BEFORE counting runs: any claim/release after this
      // read bumps `rev`, and the CAS below then refuses the stale recount.
      const before = await this.getCounter(id);

      // Runs that actually still hold a slot. Cross-tenant on purpose — the
      // strict counter is a global gate (see the no-tenant-plugin note above).
      const trueCount = await this.runModel.countDocuments({
        workflowId,
        concurrencyKey,
        status: { $in: SLOT_HOLDING_STATUSES },
      });
      const now = new Date();

      if (!before) {
        // Counter doc lost while runs are active: recreate it. A concurrent
        // first claim may insert first (E11000) — re-read and go again.
        try {
          await this.create({
            _id: id,
            workflowId,
            concurrencyKey,
            count: trueCount,
            limit: trueCount,
            rev: 0,
            createdAt: now,
            updatedAt: now,
          });
          return trueCount;
        } catch (err) {
          if (this.isDuplicateKeyError(err)) continue;
          throw err;
        }
      }

      if (before.count === trueCount) return trueCount;
      // A claim whose run is not persisted yet looks like a leak — only lower
      // a counter that has been quiet for `settleMs`.
      if (trueCount < before.count && now.getTime() - before.updatedAt.getTime() < settleMs) {
        return before.count;
      }

      const written = await this.findOneAndUpdate(
        { _id: id, rev: before.rev ?? { $exists: false } },
        { $set: { count: trueCount, updatedAt: now }, $inc: { rev: 1 } },
        { returnDocument: 'after' },
      );
      if (written) return trueCount;
      // Lost to a live claim/release — re-read and recount.
    }

    // Persistently busy bucket: leave it to the live claims/releases (correct
    // by construction) and the next reconcile.
    const current = (await this.getCounter(id))?.count;
    return current ?? 0;
  }
}

/**
 * Singleton — counter docs live in a global collection (no per-container
 * sharding); one repo handle is enough. Mirrors `workflowRunRepository`'s
 * default-singleton export pattern in `run.repository.ts`.
 */
export const workflowConcurrencyCounterRepository = new WorkflowConcurrencyCounterRepository();
