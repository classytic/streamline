/**
 * Scheduling Service - Facade for timezone-aware workflow scheduling
 *
 * Provides high-level API for scheduling workflows at specific times with full timezone support.
 * Handles DST transitions, recurrence patterns, and multi-tenant isolation.
 *
 * Design Philosophy:
 * - Simple API: One method to schedule, one to reschedule, one to cancel
 * - Smart Defaults: Sensible timezone handling with clear DST warnings
 * - Zero Surprises: Explicit about what time workflow will actually execute
 * - Resource Efficient: Uses keyset pagination for large-scale scheduling
 * - Unified Container: Uses the same container/repository for scheduling and execution
 *
 * @example Basic Scheduling
 * ```typescript
 * import { SchedulingService } from '@classytic/streamline/scheduling';
 * import { myWorkflow, myHandlers } from './workflows';
 *
 * const service = new SchedulingService(myWorkflow, myHandlers);
 *
 * // Schedule workflow for 9:00 AM New York time
 * const run = await service.schedule({
 *   scheduledFor: '2024-03-15T09:00:00',
 *   timezone: 'America/New_York',
 *   input: { task: 'Send morning email' }
 * });
 *
 * console.log(run.scheduling?.executionTime); // UTC time when scheduler will execute
 * console.log(run.scheduling?.localTimeDisplay); // "2024-03-15 09:00:00 EDT"
 * console.log(run.scheduling?.isDSTTransition); // false (9 AM is safe)
 * ```
 *
 * @example Multi-Tenant Scheduling
 * ```typescript
 * const service = new SchedulingService(workflow, handlers, {
 *   multiTenant: {
 *     tenantField: 'context.tenantId',
 *     strict: true
 *   }
 * });
 *
 * const run = await service.schedule({
 *   scheduledFor: '2024-12-25T10:00:00',
 *   timezone: 'America/Los_Angeles',
 *   input: { postContent: 'Happy Holidays!' },
 *   tenantId: 'client-123'
 * });
 * ```
 */

import { randomUUID } from 'node:crypto';
import { WorkflowEngine, hookRegistry } from '../execution/engine.js';
import { createContainer, type StreamlineContainer, type ContainerOptions } from '../core/container.js';
import { TimezoneHandler, type TimezoneCalculationResult } from './timezone-handler.js';
import { logger } from '../utils/logger.js';
import { SCHEDULING } from '../config/constants.js';
import type {
  WorkflowDefinition,
  WorkflowHandlers,
  WorkflowRun,
  RecurrencePattern,
  StepState,
} from '../core/types.js';
import type { TenantFilterOptions } from '../plugins/tenant-filter.plugin.js';
import type { SortOrder } from 'mongoose';

/**
 * Type for scheduled workflow data before creation
 */
type ScheduledWorkflowInput<TContext> = Omit<WorkflowRun<TContext>, 'startedAt' | 'endedAt' | 'output' | 'error' | 'lastHeartbeat' | 'paused'> & {
  tenantId?: string;
};

/**
 * Type for sort options
 */
type WorkflowSort = Record<string, SortOrder>;

/**
 * Paginated result type for scheduled workflows
 */
export interface ScheduledWorkflowsResult<TContext = unknown> {
  docs: WorkflowRun<TContext>[];
  page?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
  next?: string;
}

/**
 * Options for scheduling a workflow
 */
export interface ScheduleWorkflowOptions {
  /** 
   * Local date/time to execute (in user's timezone, NOT UTC)
   * 
   * Format: ISO string without timezone - "YYYY-MM-DDTHH:mm:ss"
   * 
   * @example
   * ```typescript
   * scheduledFor: '2024-03-10T09:00:00' // 9:00 AM local time
   * ```
   * 
   * This represents the LOCAL time in the target timezone.
   * The timezone parameter determines which timezone this represents.
   * Accepts both string and Date (Date will be converted to ISO string using local components).
   */
  scheduledFor: string | Date;

  /** IANA timezone name (e.g., "America/New_York", "Europe/London") */
  timezone: string;

  /** Input data for workflow execution */
  input: unknown;

  /** Optional recurrence pattern for repeating workflows */
  recurrence?: RecurrencePattern;

  /** Tenant ID for multi-tenant deployments */
  tenantId?: string;

  /** User ID who scheduled the workflow */
  userId?: string;

  /** Tags for categorization/filtering */
  tags?: string[];

  /** Additional metadata */
  meta?: Record<string, unknown>;
}

/**
 * Options for querying scheduled workflows
 */
export interface GetScheduledWorkflowsOptions {
  /** Page number for offset pagination */
  page?: number;

  /** Number of results per page */
  limit?: number;

  /** Cursor for keyset pagination (more efficient at scale) */
  cursor?: string | null;

  /** Filter by tenant ID */
  tenantId?: string;

  /** Filter by specific time range */
  executionTimeRange?: {
    from: Date;
    to: Date;
  };

  /** Filter by recurrence pattern */
  recurring?: boolean;
}

/**
 * Scheduling Service configuration
 */
export interface SchedulingServiceConfig {
  /** Multi-tenant configuration (optional) - shorthand for container.repository config */
  multiTenant?: TenantFilterOptions;

  /** Auto-execute workflows when ready (default: true) */
  autoExecute?: boolean;

  /**
   * Custom container or container options
   * If provided, multiTenant option is ignored (use container.repository instead)
   */
  container?: StreamlineContainer | ContainerOptions;
}

/**
 * SchedulingService - High-level API for timezone-aware workflow scheduling
 *
 * Combines WorkflowEngine, TimezoneHandler, and Repository for easy scheduling.
 * Handles all the complexity of timezone conversion, DST transitions, and scheduling.
 *
 * IMPORTANT: Uses a unified container for both scheduling and execution to ensure
 * consistent multi-tenant isolation and proper hook registration.
 *
 * @typeParam TContext - Workflow context type
 */
export class SchedulingService<TContext = Record<string, unknown>> {
  private readonly engine: WorkflowEngine<TContext>;
  private readonly workflow: WorkflowDefinition<TContext>;
  private readonly timezoneHandler: TimezoneHandler;
  /** Exposed for testing and advanced use cases */
  readonly container: StreamlineContainer;

  constructor(
    workflow: WorkflowDefinition<TContext>,
    handlers: WorkflowHandlers<TContext>,
    config: SchedulingServiceConfig = {}
  ) {
    this.workflow = workflow;
    this.timezoneHandler = new TimezoneHandler();

    // Create unified container - same repository for scheduling and execution
    // Priority: explicit container > multiTenant config > default
    if (config.container) {
      // Check if it's already a StreamlineContainer or ContainerOptions
      if ('repository' in config.container && 'eventBus' in config.container && 'cache' in config.container) {
        this.container = config.container as StreamlineContainer;
      } else {
        this.container = createContainer(config.container as ContainerOptions);
      }
    } else if (config.multiTenant) {
      // Create container with multi-tenant repository
      this.container = createContainer({
        repository: { multiTenant: config.multiTenant },
      });
    } else {
      this.container = createContainer();
    }

    // Engine uses the SAME container - ensuring consistent tenant isolation
    this.engine = new WorkflowEngine(workflow, handlers, this.container, {
      autoExecute: config.autoExecute !== false,
    });
  }

  /** Get the repository (uses container's repository) */
  private get repository() {
    return this.container.repository;
  }

  /**
   * Convert Date to ISO string format (YYYY-MM-DDTHH:mm:ss)
   * Uses local components to preserve the "naive" datetime interpretation
   */
  private convertDateToISOString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  }

  /**
   * Schedule a workflow for future execution at a specific timezone
   *
   * @param options - Scheduling options with timezone information
   * @returns Created workflow run with scheduling metadata
   * @throws {Error} If timezone is invalid or scheduling fails
   *
   * @example
   * ```typescript
   * const run = await service.schedule({
   *   scheduledFor: '2024-06-15T14:30:00',
   *   timezone: 'Europe/London',
   *   input: { userId: '123', action: 'send-reminder' }
   * });
   *
   * // Check if DST transition affected scheduling
   * if (run.scheduling?.isDSTTransition) {
   *   console.warn('DST Note:', run.scheduling.dstNote);
   * }
   * ```
   */
  async schedule(options: ScheduleWorkflowOptions): Promise<WorkflowRun<TContext>> {
    // Normalize scheduledFor to string format (if Date was provided)
    const scheduledForString =
      options.scheduledFor instanceof Date
        ? this.convertDateToISOString(options.scheduledFor)
        : options.scheduledFor;

    // Calculate execution time with timezone awareness
    const timezoneResult = this.timezoneHandler.calculateExecutionTime(
      scheduledForString,
      options.timezone
    );

    // Validate not scheduling too far in the past (allow small grace period for clock skew)
    const now = new Date();
    if (timezoneResult.executionTime.getTime() < now.getTime() - SCHEDULING.PAST_SCHEDULE_GRACE_MS) {
      const minutesInPast = Math.round((now.getTime() - timezoneResult.executionTime.getTime()) / 60000);
      logger.warn('Scheduling workflow in the past - will execute immediately', {
        workflowId: this.workflow.id,
        minutesInPast,
        scheduledFor: timezoneResult.localTimeDisplay,
        currentTime: now.toISOString(),
      });
    }

    // Initialize context using workflow's createContext function
    const baseContext = this.workflow.createContext(options.input);
    const context = {
      ...baseContext,
      ...(options.tenantId && { tenantId: options.tenantId }),
    };

    // Initialize steps from workflow definition (critical for execution)
    const steps: StepState[] = this.workflow.steps.map((step) => ({
      stepId: step.id,
      status: 'pending',
      attempts: 0,
    }));

    // Get first step ID (where execution will begin)
    const firstStepId = this.workflow.steps[0]?.id || null;

    // Build workflow run data
    const workflowRunData: WorkflowRun<TContext> = {
      _id: randomUUID(),
      workflowId: this.workflow.id,
      status: 'draft', // Scheduled workflows start as 'draft' until execution time
      steps,
      currentStepId: firstStepId,
      context: context as TContext,
      input: options.input,
      createdAt: new Date(),
      updatedAt: new Date(),
      scheduling: {
        scheduledFor: scheduledForString, // Store original string for accurate rescheduling
        timezone: options.timezone,
        localTimeDisplay: timezoneResult.localTimeDisplay,
        executionTime: timezoneResult.executionTime, // UTC time for scheduler
        isDSTTransition: timezoneResult.isDSTTransition,
        dstNote: timezoneResult.dstNote,
        recurrence: options.recurrence,
      },
      userId: options.userId,
      tags: options.tags,
      meta: options.meta,
    };

    // Create workflow run with scheduling metadata
    const run = await this.repository.create(workflowRunData);

    return run as WorkflowRun<TContext>;
  }

  /**
   * Reschedule an existing workflow to a new time
   *
   * @param runId - Workflow run ID to reschedule
   * @param newScheduledFor - New local date/time as ISO string (format: "YYYY-MM-DDTHH:mm:ss")
   * @param newTimezone - Optional new timezone (if changing timezone)
   * @returns Updated workflow run
   * @throws {Error} If workflow not found or already executed
   *
   * @example Reschedule to different time (same timezone)
   * ```typescript
   * await service.reschedule(runId, '2024-06-16T15:00:00');
   * ```
   *
   * @example Reschedule to different time AND timezone
   * ```typescript
   * await service.reschedule(
   *   runId,
   *   '2024-06-16T10:00:00',
   *   'America/New_York'
   * );
   * ```
   */
  async reschedule(
    runId: string,
    newScheduledFor: string | Date,
    newTimezone?: string
  ): Promise<WorkflowRun<TContext>> {
    const run = await this.repository.getById(runId);

    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    if (run.status !== 'draft') {
      throw new Error(
        `Cannot reschedule workflow ${runId} with status ${run.status}. Only draft workflows can be rescheduled.`
      );
    }

    if (!run.scheduling) {
      throw new Error(`Workflow run ${runId} is not a scheduled workflow`);
    }

    // Use original timezone if not provided
    const timezone = newTimezone || run.scheduling.timezone;

    // Recalculate execution time (TimezoneHandler accepts both Date and string)
    const timezoneResult = this.timezoneHandler.calculateExecutionTime(
      newScheduledFor,
      timezone
    );

    // Convert Date to ISO string for storage
    const scheduledForString =
      newScheduledFor instanceof Date
        ? this.convertDateToISOString(newScheduledFor)
        : newScheduledFor;

    // Update scheduling metadata
    const updateData: Partial<WorkflowRun<TContext>> = {
      scheduling: {
        scheduledFor: scheduledForString,
        timezone,
        localTimeDisplay: timezoneResult.localTimeDisplay,
        executionTime: timezoneResult.executionTime,
        isDSTTransition: timezoneResult.isDSTTransition,
        dstNote: timezoneResult.dstNote,
        recurrence: run.scheduling.recurrence, // Preserve recurrence
      },
      updatedAt: new Date(),
    };

    const updatedRun = await this.repository.update(runId, updateData);

    return updatedRun as WorkflowRun<TContext>;
  }

  /**
   * Cancel a scheduled workflow
   *
   * @param runId - Workflow run ID to cancel
   * @returns Cancelled workflow run
   * @throws {Error} If workflow not found or already executed
   *
   * @example
   * ```typescript
   * await service.cancelScheduled(runId);
   * ```
   */
  async cancelScheduled(runId: string): Promise<WorkflowRun<TContext>> {
    const run = await this.repository.getById(runId);

    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    if (run.status !== 'draft') {
      throw new Error(
        `Cannot cancel workflow ${runId} with status ${run.status}. Only draft workflows can be cancelled.`
      );
    }

    // Cancel workflow - only update status fields
    const cancelData: Partial<WorkflowRun<TContext>> = {
      status: 'cancelled',
      updatedAt: new Date(),
      endedAt: new Date(),
    };

    const cancelledRun = await this.repository.update(runId, cancelData);

    return cancelledRun as WorkflowRun<TContext>;
  }

  /**
   * Get scheduled workflows (with pagination)
   *
   * Supports both offset (page-based) and keyset (cursor-based) pagination.
   * Use keyset pagination for large datasets (>10k workflows) for better performance.
   *
   * @param options - Query and pagination options
   * @returns Paginated results with scheduled workflows
   *
   * @example Offset Pagination (Simple)
   * ```typescript
   * const result = await service.getScheduled({
   *   page: 1,
   *   limit: 50,
   *   tenantId: 'client-123'
   * });
   *
   * console.log(result.data); // Array of workflows
   * console.log(result.hasNextPage); // true if more pages exist
   * ```
   *
   * @example Keyset Pagination (Efficient for large datasets)
   * ```typescript
   * // First page
   * const result = await service.getScheduled({
   *   cursor: null,
   *   limit: 1000
   * });
   *
   * // Next page
   * const nextResult = await service.getScheduled({
   *   cursor: result.nextCursor,
   *   limit: 1000
   * });
   * ```
   *
   * @example Filter by execution time range
   * ```typescript
   * const result = await service.getScheduled({
   *   executionTimeRange: {
   *     from: new Date('2024-06-01'),
   *     to: new Date('2024-06-30')
   *   },
   *   limit: 100
   * });
   * ```
   */
  async getScheduled(options: GetScheduledWorkflowsOptions = {}): Promise<ScheduledWorkflowsResult<TContext>> {
    const { page = 1, limit = 100, cursor, tenantId, executionTimeRange, recurring } = options;

    // Build filters for listing scheduled workflows
    const filters: Record<string, unknown> = {
      status: 'draft', // Only scheduled (not yet executed) workflows
      'scheduling.executionTime': { $exists: true },
      paused: { $ne: true },
    };

    // Apply execution time range filter
    if (executionTimeRange) {
      filters['scheduling.executionTime'] = {
        $gte: executionTimeRange.from,
        $lte: executionTimeRange.to,
      };
    }

    // Apply recurrence filter
    if (recurring !== undefined) {
      if (recurring) {
        filters['scheduling.recurrence'] = { $exists: true };
      } else {
        filters['scheduling.recurrence'] = { $exists: false };
      }
    }

    // Use repository.getAll directly with custom filters
    // This allows filtering by executionTimeRange and recurring status
    const result = await this.repository.getAll({
      filters,
      sort: { 'scheduling.executionTime': 1 } satisfies WorkflowSort, // Earliest first
      page,
      limit,
      cursor: cursor ?? undefined,
      ...(tenantId && { tenantId }), // Pass tenantId for multi-tenant plugin
    });

    return result as ScheduledWorkflowsResult<TContext>;
  }

  /**
   * Get workflow run by ID
   *
   * @param runId - Workflow run ID
   * @returns Workflow run or null if not found
   */
  async get(runId: string): Promise<WorkflowRun<TContext> | null> {
    try {
      const run = await this.repository.getById(runId);
      return run as WorkflowRun<TContext> | null;
    } catch (error: unknown) {
      // MongoKit throws 404 error for not found - return null instead
      const err = error as { status?: number; message?: string };
      if (err.status === 404 || err.message?.includes('not found')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Execute a scheduled workflow immediately (bypass schedule)
   *
   * @param runId - Workflow run ID to execute
   * @returns Executed workflow run
   * @throws {Error} If workflow not found or not in draft status
   *
   * @example
   * ```typescript
   * // Execute a scheduled workflow now instead of waiting for execution time
   * const run = await service.executeNow(runId);
   * ```
   */
  async executeNow(runId: string): Promise<WorkflowRun<TContext>> {
    const run = await this.repository.getById(runId);

    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    if (run.status !== 'draft') {
      throw new Error(
        `Cannot execute workflow ${runId} with status ${run.status}. Only draft workflows can be executed.`
      );
    }

    // Change status to running and execute via engine
    const updateData: Partial<WorkflowRun<TContext>> = {
      status: 'running',
      startedAt: new Date(),
      updatedAt: new Date(),
    };

    await this.repository.update(runId, updateData);

    // Register hook BEFORE execution so resumeHook() can find this engine
    // This is critical for scheduled workflows that use ctx.wait()
    hookRegistry.register(runId, this.engine as unknown as WorkflowEngine<unknown>);

    // Execute workflow
    return (await this.engine.execute(runId)) as WorkflowRun<TContext>;
  }
}
