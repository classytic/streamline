/**
 * Workflow Run Repository
 *
 * Extends mongokit's `Repository<WorkflowRun>` — callers get the full CRUD /
 * pagination / query / hook / plugin surface for free. Only domain-specific
 * verbs live here.
 *
 * Internal-write rule (PACKAGE_RULES §1, §32): every read and write goes
 * through an inherited `Repository<TDoc>` method (`findAll`, `getOne`,
 * `count`, `exists`, `findOneAndUpdate`, `update`, `create`). Plugins —
 * audit, cache, observability, the multi-tenant injector — fire on every
 * engine write. The future cost of swapping mongokit for sqlitekit /
 * prismakit is one file (this one) instead of ~21 call sites scattered
 * across the engine.
 *
 * The atomic-claim path (`updateOne`) intentionally manually applies tenant
 * scope before delegating to `super.findOneAndUpdate`. The tenant-filter
 * plugin doesn't yet hook `before:findOneAndUpdate`; manual application is
 * defense-in-depth and explicit.
 */

import {
  type MongoOperatorUpdate,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  type PluginType,
  Repository,
} from '@classytic/mongokit';
import type {
  KeysetPaginationResult,
  OffsetPaginationResult,
} from '@classytic/repo-core/pagination';
import type { WorkflowRun } from '../core/types.js';
import { type TenantFilterOptions, tenantFilterPlugin } from '../plugins/tenant-filter.plugin.js';
import { CommonQueries } from './query-builder.js';
import { WorkflowRunModel } from './run.model.js';
import { type MongoUpdate, normalizeUpdate } from './update-builders.js';

// ============================================================================
// Types
// ============================================================================

type LeanWorkflowRun<TContext = unknown> = WorkflowRun<TContext>;

interface AtomicUpdateOptions {
  tenantId?: string;
  bypassTenant?: boolean;
}

/**
 * Pagination envelope returned by `getScheduledWorkflowsReadyToExecute`.
 *
 * Sourced from repo-core's pagination shapes per the rule mongokit itself
 * adopted in v3.12 — repo-core owns pagination types; kits and downstream
 * packages re-export rather than re-declare. Locking the shape on
 * repo-core means a host installing `arc + mongokit + repo-core +
 * streamline` gets ONE pagination contract across every package, no
 * dedup-induced type drift.
 *
 * Narrower than `AnyPaginationResult<TDoc>` on purpose: mongokit's
 * `getAll` only ever returns offset or keyset for this query (it doesn't
 * use the aggregate-pagination path), so excluding
 * `AggregatePaginationResult` from the union prevents bogus narrowing
 * branches at call sites. Discriminate via `result.method` for
 * page-/cursor-specific fields.
 *
 * Mongokit also widens offset results with `warning?: string` on deep
 * pages — we don't surface that field here, so we type against the
 * un-widened core shapes.
 */
type PaginatedResult<T> = OffsetPaginationResult<T> | KeysetPaginationResult<T>;

export interface WorkflowRepositoryConfig {
  multiTenant?: TenantFilterOptions;
}

/**
 * MongoDB duplicate-key error code. Surfaces from a partial unique index
 * collision — used in `create()` to translate idempotency races into a
 * "return the winning run" path instead of a thrown error.
 */
const MONGO_DUPLICATE_KEY = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY
  );
}

// ============================================================================
// Repository
// ============================================================================

/**
 * Thin extension of mongokit's Repository carrying only workflow-specific
 * domain verbs. Inherits `create`, `getById`, `getAll`, `update`, `delete`,
 * `countDocuments`, pagination, populate, aggregate, hooks, and transactions.
 */
export class WorkflowRunRepository extends Repository<WorkflowRun> {
  /**
   * Public so domain helpers (e.g. `bumpDebounceDraft`) can preserve
   * tenant scope when they $set fields that overlap the tenant subpath.
   * Defaults to `'context.tenantId'`.
   */
  readonly tenantField: string;
  /**
   * Public so retention helpers (`syncRetentionIndexes`) can decide
   * whether to build the tenant-prefixed compound index without rerouting
   * through the original config.
   */
  readonly isMultiTenant: boolean;
  private readonly isStrictTenant: boolean;

  constructor(config: WorkflowRepositoryConfig = {}) {
    const plugins: PluginType[] = [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
      ...(config.multiTenant ? [tenantFilterPlugin(config.multiTenant)] : []),
    ];

    super(WorkflowRunModel, plugins);

    this.isMultiTenant = !!config.multiTenant;
    this.isStrictTenant = config.multiTenant?.strict !== false;
    this.tenantField = config.multiTenant?.tenantField || 'context.tenantId';
  }

  /**
   * Default to `throwOnNotFound: false` — the workflow engine treats a
   * missing run as a not-found result, not an exception. Explicit
   * `throwOnNotFound: true` still works for callers that want the throw.
   */
  override async getById(
    id: Parameters<Repository<WorkflowRun>['getById']>[0],
    options: Parameters<Repository<WorkflowRun>['getById']>[1] = {},
  ): Promise<WorkflowRun | null> {
    return super.getById(id, { throwOnNotFound: false, ...options });
  }

  /**
   * Create with idempotency-race translation.
   *
   * The partial unique index on `idempotencyKey` (filtered to non-terminal
   * statuses) closes the TOCTOU window between
   * `findActiveByIdempotencyKey()` and `create()`. When two workers race the
   * same key, MongoDB rejects the second insert with E11000; this override
   * catches it and returns the winner instead of bubbling the error.
   *
   * Terminal runs (`done` / `failed` / `cancelled`) are excluded from the
   * partial filter, so the key is reusable after completion — same documented
   * semantic as before, now actually race-safe.
   */
  override async create<TContext = unknown>(
    data: WorkflowRun<TContext> | Record<string, unknown>,
    options: Parameters<Repository<WorkflowRun>['create']>[1] = {},
  ): Promise<WorkflowRun<TContext>> {
    try {
      return (await super.create(
        data as Record<string, unknown>,
        options,
      )) as WorkflowRun<TContext>;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;

      const idempotencyKey = (data as { idempotencyKey?: string }).idempotencyKey;
      if (!idempotencyKey) throw err;

      // Forward tenant context from the failed `create` to the lookup so
      // strict-tenant mode doesn't reject the post-race fetch.
      const tenantOpts: AtomicUpdateOptions = {};
      const opts = options as { tenantId?: string; bypassTenant?: boolean };
      if (opts.tenantId !== undefined) tenantOpts.tenantId = opts.tenantId;
      if (opts.bypassTenant) tenantOpts.bypassTenant = true;

      const winner = await this.findActiveByIdempotencyKey(idempotencyKey, tenantOpts);
      if (winner) return winner as WorkflowRun<TContext>;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Atomic claim — used by scheduler to race multiple workers for a run.
  // Real domain logic (tenant bypass + operator-aware update merge), not a
  // proxy. Routes through `super.findOneAndUpdate` so plugin hooks fire.
  // ---------------------------------------------------------------------------

  /**
   * Atomic `updateOne` with tenant-scoped filter. Accepts either a
   * well-formed Mongo update doc (`{ $set, $unset, ... }`) or a plain
   * field-shape object (auto-wrapped in `$set`). Mixing the two — e.g.
   * `{ $set: {...}, status: 'foo' }` — throws loudly instead of letting
   * Mongo silently drop the non-operator keys.
   *
   * Returns `{ modifiedCount }` for backwards compatibility with callers.
   * Internally goes through `super.findOneAndUpdate` so plugin hooks
   * (audit, cache invalidation, observability) fire on every claim.
   */
  async updateOne(
    filter: Record<string, unknown>,
    update: MongoUpdate | Record<string, unknown>,
    options?: AtomicUpdateOptions,
  ): Promise<{ modifiedCount: number }> {
    const finalFilter = this.applyTenantFilter(filter, options, 'updateOne');
    // mongokit 3.13+ exports `MongoOperatorUpdate` with the `[op: string]:
    // unknown` index signature, so a typed `MongoUpdate` value assigns to
    // `findOneAndUpdate`'s `Record<string, unknown>` slot without the
    // historic `as unknown as Record<…>` cast hack.
    const finalUpdate: MongoOperatorUpdate = normalizeUpdate(update);

    // Forward tenant context to the underlying call so the plugin's
    // `before:findOneAndUpdate` hook (registered alongside other read/
    // write hooks) sees `tenantId` / `bypassTenant` and doesn't throw a
    // missing-tenant error in strict mode. The manual `applyTenantFilter`
    // above already merged the scope into the filter; passing the same
    // tenantId through means the plugin's idempotent filter merge agrees
    // with the manual one. `bypassTenant: true` short-circuits the
    // plugin (which is what the manual path expects).
    const result = await super.findOneAndUpdate(finalFilter, finalUpdate, {
      returnDocument: 'after',
      ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options?.bypassTenant ? { bypassTenant: true } : {}),
    });
    return { modifiedCount: result ? 1 : 0 };
  }

  /**
   * Update a run by id, optionally bypassing the tenant filter (internal
   * operations that are already scoped by `_id`). Both branches go through
   * inherited Repository methods so hooks and plugins fire.
   */
  async updateById<TContext = unknown>(
    id: string,
    data: Partial<WorkflowRun<TContext>>,
    options?: AtomicUpdateOptions,
  ): Promise<WorkflowRun<TContext>> {
    if (options?.bypassTenant) {
      // Forward `bypassTenant: true` so the tenant-filter plugin's
      // `before:findOneAndUpdate` hook short-circuits — without this
      // forward, strict mode would throw a missing-tenantId error even
      // though the caller deliberately opted out of scope.
      const result = await super.findOneAndUpdate(
        { _id: id },
        { $set: data as Record<string, unknown> },
        { returnDocument: 'after', bypassTenant: true },
      );
      if (!result) {
        throw new Error(`Workflow run "${id}" not found`);
      }
      return result as WorkflowRun<TContext>;
    }

    // Forward tenantId so the plugin's `before:update` hook scopes the
    // query — the inherited `super.update()` would otherwise see no
    // tenant context and throw in strict mode.
    return super.update(
      id,
      data as Record<string, unknown>,
      options?.tenantId !== undefined ? { tenantId: options.tenantId } : {},
    ) as Promise<WorkflowRun<TContext>>;
  }

  // ---------------------------------------------------------------------------
  // Scheduler claim queries — encode timer/retry/stale/scheduled semantics.
  // These are genuine domain verbs: the filter composition and cutoff
  // reasoning belongs on the repository, not repeated at 4 scheduler call
  // sites.
  // ---------------------------------------------------------------------------

  async getReadyToResume(
    now: Date,
    limit = 100,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.readyToResume(now), { updatedAt: 1 }, limit, options);
  }

  async getReadyForRetry(
    now: Date,
    limit = 100,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.readyForRetry(now), { updatedAt: 1 }, limit, options);
  }

  async getStaleRunningWorkflows(
    staleThresholdMs: number,
    limit = 100,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun[]> {
    return this.queryLean(
      CommonQueries.staleRunning(staleThresholdMs),
      { updatedAt: 1 },
      limit,
      options,
    );
  }

  /**
   * Streaming variant of `getStaleRunningWorkflows` — yields stale runs
   * one at a time via mongokit's `cursor()` instead of buffering the full
   * page. Routes through the standard `before:cursor` hook pipeline so
   * tenant scope (when not bypassed) and any future policy plugins are
   * still applied.
   *
   * Why streaming wins here:
   *   - Lower memory peak when the fleet has many stale runs
   *     (recovery sweeps after a cluster crash can find thousands).
   *   - Allows the consumer to break early on its own bound (poll budget,
   *     concurrency cap on `staleRecoveryCallback`) without paying for
   *     unread docs.
   *   - Same Mongo wire cost as the bounded `find().limit()` because the
   *     consumer breaks out of the for-await loop at its own limit.
   *
   * The consumer MUST bound iteration — `cursor()` itself doesn't stop.
   * The scheduler's poll loop in `smart-scheduler.ts` breaks at
   * `staleCount >= limit`.
   */
  cursorStaleRunning(
    staleThresholdMs: number,
    options?: AtomicUpdateOptions & { batchSize?: number },
  ): AsyncIterableIterator<LeanWorkflowRun> {
    return this.cursor(CommonQueries.staleRunning(staleThresholdMs), {
      sort: { updatedAt: 1 },
      batchSize: options?.batchSize ?? 50,
      lean: true,
      ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options?.bypassTenant ? { bypassTenant: true } : {}),
    } as Parameters<
      Repository<WorkflowRun>['cursor']
    >[1]) as AsyncIterableIterator<LeanWorkflowRun>;
  }

  /**
   * Atomic give-up: mark a stale `running` run as `failed` (or
   * `cancelled`) iff its heartbeat is older than `staleThresholdMs`.
   *
   * Distinct from `engine.recoverStale()` — recovery RE-EXECUTES from the
   * last heartbeat, suitable for transient worker crashes; this terminates,
   * suitable for "the run is wedged, give up and let the scheduler move on."
   * The two can coexist: pick different thresholds (recover at 5min,
   * terminate at 30min) and the longer threshold acts as a backstop.
   *
   * Routes through `claim()` so plugins (audit, cache invalidation,
   * observability) fire and the CAS prevents a race against a worker that
   * is mid-recovery. Returns `true` when the row was claimed and marked,
   * `false` when another writer won (worker rebooted, recovery already
   * promoted the run, etc.) — the caller treats `false` as "not my problem
   * anymore," not as an error.
   */
  async markStaleAsFailed(
    runId: string,
    staleThresholdMs: number,
    action: 'fail' | 'cancel' = 'fail',
  ): Promise<boolean> {
    const now = new Date();
    const staleTime = new Date(now.getTime() - staleThresholdMs);
    const targetStatus = action === 'cancel' ? 'cancelled' : 'failed';

    const claimed = await this.claim(
      runId,
      {
        from: 'running',
        to: targetStatus,
        where: {
          $or: [{ lastHeartbeat: { $lt: staleTime } }, { lastHeartbeat: { $exists: false } }],
        },
      },
      {
        $set: {
          endedAt: now,
          updatedAt: now,
          error: {
            code: 'stale_heartbeat',
            message: `Worker heartbeat older than ${staleThresholdMs}ms — terminated by retention sweep`,
            terminatedAt: now,
          },
        },
        $inc: { recoveryAttempts: 1 },
      },
      { bypassTenant: true } as Parameters<Repository<WorkflowRun>['claim']>[3],
    );

    return claimed !== null;
  }

  /**
   * Dead-letter a run that has exceeded `maxStaleRecoveries`. Routes
   * through `claim()` so the transition is plugin-observed; CAS guards
   * against marking a run that has since transitioned out of `running`
   * (a healthy worker recovered between sweep cycles).
   *
   * Sets `error.code === 'dead_lettered'` so hosts can build dashboards
   * + alerts on permanent failures distinct from transient `stale_heartbeat`
   * recoveries. The run stays in the collection so the host can inspect
   * it (subject to `terminalRunsTtlSeconds` GC).
   */
  async markAsDeadLettered(
    runId: string,
    recoveryCount: number,
    maxStaleRecoveries: number,
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await this.claim(
      runId,
      {
        from: 'running',
        to: 'failed',
        where: { recoveryAttempts: { $gte: maxStaleRecoveries } },
      },
      {
        $set: {
          endedAt: now,
          updatedAt: now,
          error: {
            code: 'dead_lettered',
            message: `Run exceeded maxStaleRecoveries (${recoveryCount}/${maxStaleRecoveries}) — moved to dead-letter`,
            recoveryAttempts: recoveryCount,
            terminatedAt: now,
          },
        },
      },
      { bypassTenant: true } as Parameters<Repository<WorkflowRun>['claim']>[3],
    );
    return claimed !== null;
  }

  async getScheduledWorkflowsReadyToExecute(
    now: Date,
    options: {
      page?: number;
      limit?: number;
      cursor?: string | null;
      tenantId?: string;
      bypassTenant?: boolean;
    } = {},
  ): Promise<PaginatedResult<LeanWorkflowRun>> {
    const { page = 1, limit = 100, cursor, tenantId, bypassTenant } = options;

    const result = await this.getAll(
      {
        filters: CommonQueries.scheduledReady(now),
        sort: { 'scheduling.executionTime': 1 },
        page,
        limit,
        cursor: cursor ?? undefined,
        ...(tenantId && { tenantId }),
      },
      {
        lean: true,
        ...(bypassTenant ? { bypassTenant: true } : {}),
      },
    );

    return result as PaginatedResult<LeanWorkflowRun>;
  }

  // ---------------------------------------------------------------------------
  // Lightweight existence/count probes — cheaper than fetching docs for
  // "do we need to poll?" checks. Single-roundtrip, bounded. All route
  // through inherited `count` / `exists` so hooks fire.
  // ---------------------------------------------------------------------------

  async countRunning(options?: AtomicUpdateOptions): Promise<number> {
    return this.count(
      { status: 'running' },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
  }

  async hasWaitingWorkflows(options?: AtomicUpdateOptions): Promise<boolean> {
    const found = await this.exists(
      {
        status: 'waiting',
        paused: { $ne: true },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
    return !!found;
  }

  /**
   * Single-roundtrip existence check for concurrency-queued drafts. Cheaper
   * than `countConcurrencyDrafts()` when the caller just wants "is there any
   * work?" — Mongo can short-circuit on the first match.
   *
   * Scheduler sweeps are cross-tenant by nature (one scheduler serves all
   * tenants), so callers from `smart-scheduler.ts` / `engine.ts` typically
   * pass `{ bypassTenant: true }`. Domain callers in strict-tenant mode
   * must pass `{ tenantId }`.
   */
  async hasConcurrencyDrafts(options?: AtomicUpdateOptions): Promise<boolean> {
    const found = await this.exists(
      {
        status: 'draft',
        concurrencyKey: { $exists: true, $ne: null },
        scheduling: { $exists: false },
        paused: { $ne: true },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
    return !!found;
  }

  // ---------------------------------------------------------------------------
  // Distributed primitives — idempotency + concurrency gating.
  // ---------------------------------------------------------------------------

  async findActiveByIdempotencyKey(
    key: string,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun | null> {
    return (await this.getOne(
      {
        idempotencyKey: key,
        status: { $nin: ['done', 'failed', 'cancelled'] },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    )) as LeanWorkflowRun | null;
  }

  async countActiveByConcurrencyKey(
    workflowId: string,
    concurrencyKey: string,
    options?: AtomicUpdateOptions,
  ): Promise<number> {
    return this.count(
      {
        workflowId,
        concurrencyKey,
        status: { $in: ['running', 'waiting'] },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
  }

  /**
   * List concurrency-queued drafts pending promotion. Used by the scheduler
   * sweep (cross-tenant — pass `bypassTenant: true`) and by per-tenant
   * promotion paths in the engine (pass `tenantId`).
   */
  async getConcurrencyDrafts(
    limit = 100,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun[]> {
    return (await this.findAll(
      {
        status: 'draft',
        concurrencyKey: { $exists: true, $ne: null },
        scheduling: { $exists: false },
        paused: { $ne: true },
      },
      {
        sort: { priority: -1, createdAt: 1 },
        limit,
        lean: true,
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      } as Parameters<Repository<WorkflowRun>['findAll']>[1],
    )) as LeanWorkflowRun[];
  }

  async countConcurrencyDrafts(options?: AtomicUpdateOptions): Promise<number> {
    return this.count(
      {
        status: 'draft',
        concurrencyKey: { $exists: true, $ne: null },
        scheduling: { $exists: false },
        paused: { $ne: true },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
  }

  /**
   * Look up a single concurrency draft by id (used in the executeRetry
   * fall-through path after a scheduled-draft claim misses). Scheduler
   * callers pass `{ bypassTenant: true }`; per-tenant code paths pass
   * `{ tenantId }`.
   */
  async getConcurrencyDraft(
    runId: string,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun | null> {
    return (await this.getOne(
      {
        _id: runId,
        status: 'draft',
        concurrencyKey: { $exists: true },
        // Exclude throttle/debounce drafts — they ride the scheduled-draft
        // pickup path and must not be promoted early by the concurrency-slot
        // path.
        scheduling: { $exists: false },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    )) as LeanWorkflowRun | null;
  }

  // ---------------------------------------------------------------------------
  // Start-rate gates: throttle / debounce.
  // Both ride the existing scheduled-draft pickup path (status='draft' +
  // scheduling.executionTime <= now). These helpers encode just the bucket
  // arithmetic so define.ts stays declarative.
  // ---------------------------------------------------------------------------

  /**
   * Count runs in `(workflowId, concurrencyKey)` whose `createdAt` falls
   * inside `[since, now]`. `createdAt` is the cheap proxy for "logical start
   * time" — accurate enough for rate-limit purposes and indexable.
   */
  async countStartsInWindow(
    workflowId: string,
    concurrencyKey: string,
    since: Date,
    options?: AtomicUpdateOptions,
  ): Promise<number> {
    return this.count(
      {
        workflowId,
        concurrencyKey,
        createdAt: { $gte: since },
        status: { $nin: ['cancelled'] },
      },
      {
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
  }

  /**
   * Compute the next throttle-fire slot for `(workflowId, concurrencyKey)`.
   *
   * Spreads excess starts across the rate-limit window instead of bunching
   * them. Algorithm:
   *
   *   1. Look up the most recently-queued throttle draft for this bucket.
   *   2. If one exists, return `tail.executionTime + windowMs/limit`
   *      (next slot is one rate-quantum after the tail).
   *   3. If none exists, this is the first excess call — return
   *      `oldestInWindow.createdAt + windowMs` (fires when the oldest
   *      in-window start rolls off and a slot opens).
   *
   * Walk-through, `limit=2, windowMs=60_000`, burst of 5 within 1 ms:
   *
   *   - Call 1, 2 — under limit, fire immediately at t0
   *   - Call 3 — no queued tail, fireAt = t0 + 60s = t60
   *   - Call 4 — tail = t60, fireAt = t60 + 30s = t90
   *   - Call 5 — tail = t90, fireAt = t90 + 30s = t120
   *
   * Earlier implementation used `oldestInWindow + windowMs` for every excess
   * call, so 3, 4, 5 all collided at t60 and the scheduler fired them
   * together — defeating the rate limit. This helper closes that bug for
   * sequential calls.
   *
   * **Residual race (sequential-safe, parallel-best-effort).** Two parallel
   * `start()` calls computed against the same tail before either persists
   * its draft will both pick the same slot. Strict closure requires an
   * atomic reservation primitive (a per-bucket counter doc updated via
   * `incrementIfBelow`). For now, document and accept — the typical
   * throttle workload is bursty-but-not-truly-parallel, and the bug is
   * an order of magnitude smaller than the prior "every excess on one
   * slot" defect.
   */
  async nextThrottleFireAt(
    workflowId: string,
    concurrencyKey: string,
    limit: number,
    windowMs: number,
    options?: AtomicUpdateOptions,
  ): Promise<Date> {
    const tenantOpts = {
      ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options?.bypassTenant ? { bypassTenant: true } : {}),
    };
    const tailQueued = (await this.findAll(
      {
        workflowId,
        concurrencyKey,
        status: 'draft',
        'meta.streamlineGate': 'throttle',
      },
      {
        sort: { 'scheduling.executionTime': -1 },
        limit: 1,
        lean: true,
        ...tenantOpts,
      } as Parameters<Repository<WorkflowRun>['findAll']>[1],
    )) as Array<LeanWorkflowRun & { scheduling?: { executionTime: Date } }>;

    const tailTime = tailQueued[0]?.scheduling?.executionTime;
    if (tailTime) {
      // Spread within the window — each excess start gets its own slot
      // `windowMs/limit` after the tail. Steady-state this becomes the
      // canonical "1 every windowMs/limit" rate-limit smoothing.
      const slotInterval = windowMs / limit;
      return new Date(tailTime.getTime() + slotInterval);
    }

    // First excess call — fire when oldest in-window start rolls off.
    const since = new Date(Date.now() - windowMs);
    const oldest = await this.oldestStartInWindow(workflowId, concurrencyKey, since, options);
    return new Date((oldest?.getTime() ?? Date.now()) + windowMs);
  }

  /**
   * Oldest run in the throttle window — its `createdAt + windowMs` is the
   * earliest the next slot opens. Returned as a `Date` (or `null` if none).
   */
  async oldestStartInWindow(
    workflowId: string,
    concurrencyKey: string,
    since: Date,
    options?: AtomicUpdateOptions,
  ): Promise<Date | null> {
    const docs = await this.findAll(
      {
        workflowId,
        concurrencyKey,
        createdAt: { $gte: since },
        status: { $nin: ['cancelled'] },
      },
      {
        sort: { createdAt: 1 },
        limit: 1,
        select: { createdAt: 1 },
        lean: true,
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      } as Parameters<Repository<WorkflowRun>['findAll']>[1],
    );
    const first = docs[0] as { createdAt?: Date } | undefined;
    return first?.createdAt ?? null;
  }

  /**
   * Atomic trailing-edge debounce: if a pending debounce draft exists for
   * `(workflowId, concurrencyKey)`, bump its `scheduling.executionTime` to
   * `nextFireAt` and refresh `input` + `context`. Returns the bumped run, or
   * `null` if no pending draft existed (caller should create one).
   *
   * Filter is `meta.streamlineGate: 'debounce'` so a coexisting throttle
   * draft for the same key is *not* clobbered. There's at most one debounce
   * draft per bucket by construction.
   *
   * Tenant scope is preserved on every bump:
   *   - The filter is tenant-scoped via `tenantOpts` (plugin's
   *     `before:findOneAndUpdate` hook + manual filter merge).
   *   - The `$set: { context }` would otherwise overwrite the
   *     plugin-injected tenant subpath. To prevent silent tenant loss,
   *     when `options.tenantId` is provided AND `tenantField` lives under
   *     `context.*`, we re-stamp the tenant subpath in the merged context
   *     before the update is sent.
   */
  async bumpDebounceDraft<TContext = unknown>(
    workflowId: string,
    concurrencyKey: string,
    nextFireAt: Date,
    input: unknown,
    context: TContext,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun<TContext> | null> {
    const now = new Date();

    // Re-stamp tenantId on the new context if the configured tenantField
    // lives inside `context.*` — otherwise the wholesale `$set: { context }`
    // below silently strips the tenant subpath that the plugin injected on
    // the original create. (Top-level tenantFields like `meta.tenantId` are
    // unaffected because `context` doesn't overlap them.)
    const enrichedContext: TContext =
      options?.tenantId !== undefined && this.tenantField.startsWith('context.')
        ? ({
            ...(context as Record<string, unknown>),
            [this.tenantField.slice('context.'.length)]: options.tenantId,
          } as TContext)
        : context;

    return (await super.findOneAndUpdate(
      {
        workflowId,
        concurrencyKey,
        status: 'draft',
        'meta.streamlineGate': 'debounce',
      },
      {
        $set: {
          'scheduling.executionTime': nextFireAt,
          'scheduling.scheduledFor': nextFireAt.toISOString(),
          'scheduling.localTimeDisplay': nextFireAt.toISOString(),
          input,
          context: enrichedContext,
          updatedAt: now,
        },
      },
      {
        returnDocument: 'after',
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    )) as LeanWorkflowRun<TContext> | null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async queryLean(
    filters: Record<string, unknown>,
    sort: string | Record<string, 1 | -1>,
    limit: number,
    options?: AtomicUpdateOptions,
  ): Promise<LeanWorkflowRun[]> {
    const result = await this.getAll(
      {
        filters,
        sort,
        limit,
        ...(options?.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      },
      {
        lean: true,
        ...(options?.bypassTenant ? { bypassTenant: true } : {}),
      },
    );
    const data = Array.isArray(result) ? result : (result as { data: LeanWorkflowRun[] }).data;
    return data as LeanWorkflowRun[];
  }

  private applyTenantFilter(
    filter: Record<string, unknown>,
    options: AtomicUpdateOptions | undefined,
    operation: string,
  ): Record<string, unknown> {
    if (!this.isMultiTenant || options?.bypassTenant) {
      return filter;
    }

    if (this.isStrictTenant && !options?.tenantId) {
      throw new Error(
        `[WorkflowRepository.${operation}] tenantId required in multi-tenant mode. ` +
          `Pass { tenantId } or { bypassTenant: true }.`,
      );
    }

    if (!options?.tenantId) {
      return filter;
    }

    return { ...filter, [this.tenantField]: options.tenantId };
  }
}

// ============================================================================
// Factory + default singleton
// ============================================================================

/**
 * Create a workflow repository instance.
 *
 * @example
 * // Single-tenant:
 * const repo = createWorkflowRepository();
 *
 * // Multi-tenant:
 * const repo = createWorkflowRepository({
 *   multiTenant: { tenantField: 'context.tenantId', strict: true }
 * });
 */
export function createWorkflowRepository(
  config: WorkflowRepositoryConfig = {},
): WorkflowRunRepository {
  return new WorkflowRunRepository(config);
}

export const workflowRunRepository = createWorkflowRepository();
