/**
 * Workflow Run Repository
 *
 * MongoKit-powered repository with multi-tenant support and atomic operations.
 */

import { Repository, methodRegistryPlugin, mongoOperationsPlugin } from '@classytic/mongokit';
import { WorkflowRunModel } from './run.model.js';
import { CommonQueries } from './query-builder.js';
import { tenantFilterPlugin, type TenantFilterOptions } from '../plugins/tenant-filter.plugin.js';
import type { WorkflowRun } from '../core/types.js';

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
// Repository Interface
// ============================================================================

/**
 * Repository interface for workflow run storage operations.
 * Provides CRUD, queries, and atomic updates for workflow runs.
 */
export interface WorkflowRunRepository {
  /** Create a new workflow run */
  create<TContext = unknown>(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>>;

  /** Get a workflow run by ID */
  getById<TContext = unknown>(id: string): Promise<WorkflowRun<TContext> | null>;

  /** Get all workflow runs with filtering and pagination */
  getAll: Repository<WorkflowRun>['getAll'];

  /** Update a workflow run */
  update<TContext = unknown>(
    id: string,
    data: Partial<WorkflowRun<TContext>>,
    options?: AtomicUpdateOptions
  ): Promise<WorkflowRun<TContext>>;

  /** Delete a workflow run */
  delete: Repository<WorkflowRun>['delete'];

  /** Atomic update with filter (for concurrent workflow claiming) */
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: AtomicUpdateOptions
  ): Promise<{ modifiedCount: number }>;

  /** Get all active (running/waiting) workflow runs */
  getActiveRuns(): Promise<LeanWorkflowRun[]>;

  /** Get workflow runs by workflow ID */
  getRunsByWorkflow(workflowId: string, limit?: number): Promise<LeanWorkflowRun[]>;

  /** Get all waiting workflow runs */
  getWaitingRuns(): Promise<LeanWorkflowRun[]>;

  /** Get all running workflow runs */
  getRunningRuns(): Promise<LeanWorkflowRun[]>;

  /** Get workflows ready to resume (resumeAt <= now) */
  getReadyToResume(now: Date, limit?: number): Promise<LeanWorkflowRun[]>;

  /** Get workflows ready for retry (retryAt <= now) */
  getReadyForRetry(now: Date, limit?: number): Promise<LeanWorkflowRun[]>;

  /** Get stale running workflows (no heartbeat in threshold) */
  getStaleRunningWorkflows(staleThresholdMs: number, limit?: number): Promise<LeanWorkflowRun[]>;

  /** Get scheduled workflows ready to execute */
  getScheduledWorkflowsReadyToExecute(
    now: Date,
    options?: { page?: number; limit?: number; cursor?: string | null; tenantId?: string }
  ): Promise<PaginatedResult<LeanWorkflowRun>>;

  /** Access to underlying MongoKit repository */
  readonly base: Repository<WorkflowRun>;

  /** Access to repository hooks */
  readonly _hooks: Map<string, unknown[]>;
}

// ============================================================================
// Repository Implementation
// ============================================================================

class WorkflowRepository implements WorkflowRunRepository {
  private readonly repo: Repository<WorkflowRun>;
  private readonly tenantField: string;
  private readonly isMultiTenant: boolean;
  private readonly isStrictTenant: boolean;

  constructor(config: WorkflowRepositoryConfig = {}) {
    this.isMultiTenant = !!config.multiTenant;
    this.isStrictTenant = config.multiTenant?.strict !== false;
    this.tenantField = config.multiTenant?.tenantField || 'context.tenantId';

    const plugins = [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
      ...(config.multiTenant ? [tenantFilterPlugin(config.multiTenant)] : []),
    ];

    this.repo = new Repository<WorkflowRun>(WorkflowRunModel, plugins);
  }

  // ---------------------------------------------------------------------------
  // Core CRUD
  // ---------------------------------------------------------------------------

  async create<TContext = unknown>(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>> {
    return this.repo.create(run as unknown as Record<string, unknown>) as Promise<
      WorkflowRun<TContext>
    >;
  }

  async getById<TContext = unknown>(id: string): Promise<WorkflowRun<TContext> | null> {
    return this.repo.getById(id) as Promise<WorkflowRun<TContext> | null>;
  }

  getAll(...args: Parameters<Repository<WorkflowRun>['getAll']>) {
    return this.repo.getAll(...args);
  }

  async update<TContext = unknown>(
    id: string,
    data: Partial<WorkflowRun<TContext>>,
    options?: AtomicUpdateOptions
  ): Promise<WorkflowRun<TContext>> {
    // Bypass tenant filter for internal operations (already scoped by _id)
    // Uses same approach as MongoKit: findByIdAndUpdate without $set wrapper
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

    return this.repo.update(id, data as unknown as Record<string, unknown>) as Promise<
      WorkflowRun<TContext>
    >;
  }

  delete(...args: Parameters<Repository<WorkflowRun>['delete']>) {
    return this.repo.delete(...args);
  }

  // ---------------------------------------------------------------------------
  // Atomic Update (for concurrent workflow claiming)
  // ---------------------------------------------------------------------------

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: AtomicUpdateOptions
  ): Promise<{ modifiedCount: number }> {
    const finalFilter = this.applyTenantFilter(filter, options, 'updateOne');

    const hasOperators = Object.keys(update).some((k) => k.startsWith('$'));
    const finalUpdate = hasOperators ? update : { $set: update };

    const result = await WorkflowRunModel.updateOne(finalFilter, finalUpdate);
    return { modifiedCount: result.modifiedCount };
  }

  // ---------------------------------------------------------------------------
  // Query Methods
  // ---------------------------------------------------------------------------

  async getActiveRuns(): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.active(), '-updatedAt', 1000);
  }

  async getRunsByWorkflow(workflowId: string, limit = 100): Promise<LeanWorkflowRun[]> {
    return this.queryLean({ workflowId }, '-createdAt', limit);
  }

  async getWaitingRuns(): Promise<LeanWorkflowRun[]> {
    return this.queryLean({ status: 'waiting', paused: { $ne: true } }, '-updatedAt', 1000);
  }

  async getRunningRuns(): Promise<LeanWorkflowRun[]> {
    return this.queryLean({ status: 'running' }, '-updatedAt', 1000);
  }

  async getReadyToResume(now: Date, limit = 100): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.readyToResume(now), { updatedAt: 1 }, limit);
  }

  async getReadyForRetry(now: Date, limit = 100): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.readyForRetry(now), { updatedAt: 1 }, limit);
  }

  async getStaleRunningWorkflows(
    staleThresholdMs: number,
    limit = 100
  ): Promise<LeanWorkflowRun[]> {
    return this.queryLean(CommonQueries.staleRunning(staleThresholdMs), { updatedAt: 1 }, limit);
  }

  async getScheduledWorkflowsReadyToExecute(
    now: Date,
    options: { page?: number; limit?: number; cursor?: string | null; tenantId?: string } = {}
  ): Promise<PaginatedResult<LeanWorkflowRun>> {
    const { page = 1, limit = 100, cursor, tenantId } = options;

    const result = await this.repo.getAll(
      {
        filters: CommonQueries.scheduledReady(now),
        sort: { 'scheduling.executionTime': 1 },
        page,
        limit,
        cursor: cursor ?? undefined,
        ...(tenantId && { tenantId }),
      },
      { lean: true }
    );

    return result as PaginatedResult<LeanWorkflowRun>;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  get base(): Repository<WorkflowRun> {
    return this.repo;
  }

  get _hooks(): Map<string, unknown[]> {
    return this.repo._hooks;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private async queryLean(
    filters: Record<string, unknown>,
    sort: string | Record<string, 1 | -1>,
    limit: number
  ): Promise<LeanWorkflowRun[]> {
    const result = await this.repo.getAll({ filters, sort, limit }, { lean: true });
    return result.docs as LeanWorkflowRun[];
  }

  private applyTenantFilter(
    filter: Record<string, unknown>,
    options: AtomicUpdateOptions | undefined,
    operation: string
  ): Record<string, unknown> {
    if (!this.isMultiTenant || options?.bypassTenant) {
      return filter;
    }

    if (this.isStrictTenant && !options?.tenantId) {
      throw new Error(
        `[WorkflowRepository.${operation}] tenantId required in multi-tenant mode. ` +
          `Pass { tenantId } or { bypassTenant: true }.`
      );
    }

    if (!options?.tenantId) {
      return filter;
    }

    return { ...filter, [this.tenantField]: options.tenantId };
  }
}

// ============================================================================
// Factory Functions
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
  config: WorkflowRepositoryConfig = {}
): WorkflowRunRepository {
  return new WorkflowRepository(config);
}

// ============================================================================
// Default Instance (Single-Tenant)
// ============================================================================

export const workflowRunRepository = createWorkflowRepository();
