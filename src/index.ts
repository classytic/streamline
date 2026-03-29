// ============================================================================
// Core Workflow API - Most Commonly Used
// ============================================================================

/**
 * Main entry point for creating workflows.
 * Use this for 90% of use cases.
 */
export { createWorkflow } from './workflow/define.js';
export type { Workflow, WorkflowConfig, StepConfig, WaitForOptions } from './workflow/define.js';

/**
 * Direct engine access for advanced use cases.
 * Most users should use createWorkflow instead.
 */
export { WorkflowEngine } from './execution/engine.js';
export type { WorkflowEngineOptions } from './execution/engine.js';

/**
 * Core types exported from types.js
 * Includes: WorkflowDefinition, WorkflowRun, Step, StepContext, etc.
 */
export * from './core/types.js';

/**
 * Status utilities and validation
 */
export * from './core/status.js';

// ============================================================================
// Hooks & Resume - For External Workflow Control
// ============================================================================

/**
 * Create hooks for pausing workflows and resuming them from webhooks/APIs.
 * 
 * @example
 * ```typescript
 * const hook = createHook(ctx, 'awaiting-approval');
 * await resumeHook(hook.token, { approved: true });
 * ```
 */
export { createHook, resumeHook, hookToken } from './features/hooks.js';
export type { HookResult, HookOptions } from './features/hooks.js';
export { WaitSignal, GotoSignal } from './execution/context.js';

// ============================================================================
// Storage & Database - MongoDB Models & Repositories
// ============================================================================

/**
 * Mongoose model for workflow runs.
 * Use this for direct MongoDB queries and custom indexes.
 */
export { WorkflowRunModel } from './storage/run.model.js';

/**
 * Repository for workflow run CRUD operations.
 * Supports multi-tenancy and atomic updates.
 */
export {
  workflowRunRepository,
  createWorkflowRepository,
} from './storage/run.repository.js';
export type { WorkflowRunRepository, WorkflowRepositoryConfig } from './storage/run.repository.js';

/**
 * Query builder and common queries for workflows.
 * Type-safe MongoDB query construction.
 */
export { WorkflowQueryBuilder, CommonQueries, RUN_STATUS, STEP_STATUS } from './storage/query-builder.js';

/**
 * Optional: WorkflowDefinition storage for versioning and auditing.
 */
export { WorkflowDefinitionModel, workflowDefinitionRepository } from './storage/definition.model.js';
export type { WorkflowDefinitionDoc } from './storage/definition.model.js';

// ============================================================================
// Events & Observability
// ============================================================================

/**
 * Event bus for workflow lifecycle events.
 * Subscribe to workflow:started, step:completed, etc.
 */
export { WorkflowEventBus, globalEventBus } from './core/events.js';
export type {
  WorkflowEventName,
  EventPayloadMap,
  BaseEventPayload,
  StepEventPayload,
  StepCompletedPayload,
  StepFailedPayload,
  StepRetryPayload,
  WorkflowCompletedPayload,
  WorkflowFailedPayload,
  WorkflowResumedPayload,
  EngineErrorPayload,
} from './core/events.js';

/**
 * Visualization helpers for building UIs.
 * Get step timeline, progress, execution path, etc.
 */
export {
  getStepTimeline,
  getWorkflowProgress,
  getStepUIStates,
  getWaitingInfo,
  canRewindTo,
  getExecutionPath,
} from './utils/visualization.js';
export type { StepTimeline, WorkflowProgress, StepUIState } from './utils/visualization.js';

// ============================================================================
// Dependency Injection - For Testing & Multi-Instance Support
// ============================================================================

/**
 * Create isolated containers for testing or running multiple engines.
 * createWorkflow() handles this automatically for normal use.
 */
export { createContainer, isStreamlineContainer } from './core/container.js';
export type { StreamlineContainer, ContainerOptions, SignalStore } from './core/container.js';

/**
 * Cache health monitoring for operational dashboards.
 */
export { WorkflowCache } from './storage/cache.js';
export type { CacheHealthStatus } from './storage/cache.js';

/**
 * Computed constants for monitoring and capacity planning.
 */
export { COMPUTED } from './config/constants.js';

// ============================================================================
// Scheduling - Timezone-Aware Workflow Scheduling
// ============================================================================

/**
 * Schedule workflows for future execution with full timezone support.
 * Handles DST transitions automatically.
 */
export {
  SchedulingService,
  TimezoneHandler,
  timezoneHandler,
} from './scheduling/index.js';
export type {
  ScheduleWorkflowOptions,
  GetScheduledWorkflowsOptions,
  SchedulingServiceConfig,
  TimezoneCalculationResult,
} from './scheduling/index.js';

// ============================================================================
// Multi-Tenancy - Repository Plugins
// ============================================================================

/**
 * Plugins for multi-tenant deployments.
 * Automatically inject tenant filters into all queries.
 */
export {
  tenantFilterPlugin,
  singleTenantPlugin,
} from './plugins/index.js';
export type { TenantFilterOptions } from './plugins/index.js';

// ============================================================================
// Advanced Features - Parallel, Conditional, Subworkflows
// ============================================================================

/**
 * Execute multiple async tasks in parallel.
 * Supports concurrency limits, timeouts, and different execution modes.
 */
export { executeParallel } from './features/parallel.js';
export type { ExecuteParallelOptions } from './features/parallel.js';

/**
 * Conditional step execution utilities.
 * Skip steps based on runtime conditions.
 */
export {
  isConditionalStep,
  shouldSkipStep,
  createCondition,
  conditions,
} from './features/conditional.js';
export type { ConditionalStep } from './features/conditional.js';

// ============================================================================
// Advanced Configuration (Optional)
// ============================================================================

/**
 * Scheduler configuration and stats for customizing and monitoring polling behavior.
 * Most users don't need this - engine handles it automatically.
 */
export type { SmartSchedulerConfig, SchedulerStats } from './execution/smart-scheduler.js';

// ============================================================================
// Hook Registry - For External Workflow Resume
// ============================================================================

/**
 * Hook registry for resuming workflows by token.
 * Used internally by resumeHook() - exposed for advanced use cases.
 */
export { hookRegistry, workflowRegistry } from './execution/engine.js';

// ============================================================================
// Error Classes - For Error Handling
// ============================================================================

/**
 * Custom error classes with rich context for debugging.
 * Includes standardized error codes for programmatic error handling.
 *
 * @example
 * ```typescript
 * import { ErrorCode, WorkflowNotFoundError } from '@classytic/streamline';
 *
 * try {
 *   await workflow.resume(runId);
 * } catch (err) {
 *   if (err.code === ErrorCode.WORKFLOW_NOT_FOUND) {
 *     console.log('Workflow not found');
 *   }
 * }
 * ```
 */
export {
  ErrorCode,
  WorkflowError,
  StepNotFoundError,
  WorkflowNotFoundError,
  InvalidStateError,
  StepTimeoutError,
  DataCorruptionError,
  MaxRetriesExceededError,
} from './utils/errors.js';
export type { ErrorCode as ErrorCodeType } from './utils/errors.js';
