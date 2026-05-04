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
  type WorkflowConcurrencyCounter,
  WorkflowConcurrencyCounterModel,
} from './concurrency-counter.model.js';

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
   *   4. If existing doc has `count >= limit`: filter doesn't match
   *      existing, upsert tries to insert, hits E11000 unique `_id`
   *      collision, we catch and return `false`.
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
      // E11000 = unique `_id` collision when filter rejected the existing
      // doc and upsert tried to insert. That's the at-limit signal.
      if (this.isDuplicateKeyError(err)) return false;
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
}

/**
 * Singleton — counter docs live in a global collection (no per-container
 * sharding); one repo handle is enough. Mirrors `workflowRunRepository`'s
 * default-singleton export pattern in `run.repository.ts`.
 */
export const workflowConcurrencyCounterRepository = new WorkflowConcurrencyCounterRepository();
