/**
 * Workflow Run Repository
 *
 * Extends mongokit's `Repository<WorkflowRun>` — callers get the full CRUD /
 * pagination / query surface for free. Only domain-specific verbs live here.
 *
 * See packages/streamline/docs/PACKAGE_RULES alignment note in CHANGELOG:
 * this file was refactored in v2.2 to extend rather than wrap. Pure proxy
 * methods (`getActiveRuns`, `getRunningRuns`, `getWaitingRuns`,
 * `getRunsByWorkflow`) were removed — use `repo.getAll({ filters })` directly
 * or `CommonQueries.*` from `./query-builder.js` for canonical filter shapes.
 */

import {
  methodRegistryPlugin,
  mongoOperationsPlugin,
  type PluginType,
  Repository,
} from '@classytic/mongokit';
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

interface PaginatedResult<T> {
  docs: T[];
  page?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
  next?: string;
}

export interface WorkflowRepositoryConfig {
  multiTenant?: TenantFilterOptions;
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
  private readonly tenantField: string;
  private readonly isMultiTenant: boolean;
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
   * Accept a `WorkflowRun<TContext>` shape directly (convenience over
   * mongokit's `Record<string, unknown>`). Callers already build the full
   * run with their own context type before persisting it; the stored type
   * is `WorkflowRun` at rest regardless.
   */
  override async create<TContext = unknown>(
    data: WorkflowRun<TContext> | Record<string, unknown>,
    options: Parameters<Repository<WorkflowRun>['create']>[1] = {},
  ): Promise<WorkflowRun<TContext>> {
    return super.create(data as Record<string, unknown>, options) as Promise<WorkflowRun<TContext>>;
  }

  // ---------------------------------------------------------------------------
  // Atomic claim — used by scheduler to race multiple workers for a run.
  // Real domain logic (tenant bypass + operator-aware update merge), not a
  // proxy.
  // ---------------------------------------------------------------------------

  /**
   * Atomic `updateOne` with tenant-scoped filter. Accepts either a
   * well-formed Mongo update doc (`{ $set, $unset, ... }`) or a plain
   * field-shape object (auto-wrapped in `$set`). Mixing the two — e.g.
   * `{ $set: {...}, status: 'foo' }` — throws loudly instead of letting
   * Mongo silently drop the non-operator keys.
   */
  async updateOne(
    filter: Record<string, unknown>,
    update: MongoUpdate | Record<string, unknown>,
    options?: AtomicUpdateOptions,
  ): Promise<{ modifiedCount: number }> {
    const finalFilter = this.applyTenantFilter(filter, options, 'updateOne');
    const finalUpdate = normalizeUpdate(update);

    const result = await WorkflowRunModel.updateOne(finalFilter, finalUpdate);
    return { modifiedCount: result.modifiedCount };
  }

  /**
   * Update a run by id, optionally bypassing the tenant filter (internal
   * operations that are already scoped by `_id`). Delegates to `super.update`
   * for the normal path so hooks and plugins fire.
   */
  async updateById<TContext = unknown>(
    id: string,
    data: Partial<WorkflowRun<TContext>>,
    options?: AtomicUpdateOptions,
  ): Promise<WorkflowRun<TContext>> {
    if (options?.bypassTenant) {
      const result = await WorkflowRunModel.findByIdAndUpdate(id, data, {
        returnDocument: 'after',
        runValidators: true,
        lean: true,
      });
      if (!result) {
        throw new Error(`Workflow run "${id}" not found`);
      }
      return result as WorkflowRun<TContext>;
    }

    return super.update(id, data as Record<string, unknown>) as Promise<WorkflowRun<TContext>>;
  }

  // ---------------------------------------------------------------------------
  // Scheduler claim queries — encode timer/retry/stale/scheduled semantics.
  // These are genuine domain verbs: the filter composition and cutoff
  // reasoning belongs on the repository, not repeated at 4 scheduler call
  // sites.
  // ---------------------------------------------------------------------------

  async getReadyToResume(now: Date, limit = 100): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.readyToResume(now), { updatedAt: 1 }, limit);
  }

  async getReadyForRetry(now: Date, limit = 100): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.readyForRetry(now), { updatedAt: 1 }, limit);
  }

  async getStaleRunningWorkflows(
    staleThresholdMs: number,
    limit = 100,
  ): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.staleRunning(staleThresholdMs), { updatedAt: 1 }, limit);
  }

  async getScheduledWorkflowsReadyToExecute(
    now: Date,
    options: { page?: number; limit?: number; cursor?: string | null; tenantId?: string } = {},
  ): Promise<PaginatedResult<LeanWorkflowRun>> {
    const { page = 1, limit = 100, cursor, tenantId } = options;

    const result = await this.getAll(
      {
        filters: CommonQueries.scheduledReady(now),
        sort: { 'scheduling.executionTime': 1 },
        page,
        limit,
        cursor: cursor ?? undefined,
        ...(tenantId && { tenantId }),
      },
      { lean: true },
    );

    return result as PaginatedResult<LeanWorkflowRun>;
  }

  // ---------------------------------------------------------------------------
  // Lightweight existence/count probes — cheaper than fetching docs for
  // "do we need to poll?" checks. Single-roundtrip, bounded.
  // ---------------------------------------------------------------------------

  async countRunning(): Promise<number> {
    return WorkflowRunModel.countDocuments({ status: 'running' });
  }

  async hasWaitingWorkflows(): Promise<boolean> {
    const found = await WorkflowRunModel.exists({
      status: 'waiting',
      paused: { $ne: true },
    });
    return !!found;
  }

  /**
   * Single-roundtrip existence check for concurrency-queued drafts. Cheaper
   * than `countConcurrencyDrafts()` when the caller just wants "is there any
   * work?" — Mongo can short-circuit on the first match.
   */
  async hasConcurrencyDrafts(): Promise<boolean> {
    const found = await WorkflowRunModel.exists({
      status: 'draft',
      concurrencyKey: { $exists: true, $ne: null },
      scheduling: { $exists: false },
      paused: { $ne: true },
    });
    return !!found;
  }

  // ---------------------------------------------------------------------------
  // Distributed primitives — idempotency + concurrency gating.
  // ---------------------------------------------------------------------------

  async findActiveByIdempotencyKey(key: string): Promise<LeanWorkflowRun | null> {
    return WorkflowRunModel.findOne({
      idempotencyKey: key,
      status: { $nin: ['done', 'failed', 'cancelled'] },
    }).lean() as Promise<LeanWorkflowRun | null>;
  }

  async countActiveByConcurrencyKey(workflowId: string, concurrencyKey: string): Promise<number> {
    return WorkflowRunModel.countDocuments({
      workflowId,
      concurrencyKey,
      status: { $in: ['running', 'waiting'] },
    });
  }

  async getConcurrencyDrafts(limit = 100): Promise<LeanWorkflowRun[]> {
    return WorkflowRunModel.find({
      status: 'draft',
      concurrencyKey: { $exists: true, $ne: null },
      scheduling: { $exists: false },
      paused: { $ne: true },
    })
      .sort({ priority: -1, createdAt: 1 })
      .limit(limit)
      .lean() as Promise<LeanWorkflowRun[]>;
  }

  async countConcurrencyDrafts(): Promise<number> {
    return WorkflowRunModel.countDocuments({
      status: 'draft',
      concurrencyKey: { $exists: true, $ne: null },
      scheduling: { $exists: false },
      paused: { $ne: true },
    });
  }

  async getConcurrencyDraft(runId: string): Promise<LeanWorkflowRun | null> {
    return WorkflowRunModel.findOne({
      _id: runId,
      status: 'draft',
      concurrencyKey: { $exists: true },
    }).lean() as Promise<LeanWorkflowRun | null>;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async queryLean(
    filters: Record<string, unknown>,
    sort: string | Record<string, 1 | -1>,
    limit: number,
  ): Promise<LeanWorkflowRun[]> {
    const result = await this.getAll({ filters, sort, limit }, { lean: true });
    const docs = Array.isArray(result) ? result : (result as { docs: LeanWorkflowRun[] }).docs;
    return docs as LeanWorkflowRun[];
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
