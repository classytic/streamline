// ============================================================================
// Core Workflow API - Most Commonly Used
// ============================================================================

/**
 * Status utilities and validation
 */
export * from './core/status.js';
/**
 * Core types exported from types.js
 * Includes: WorkflowDefinition, WorkflowRun, Step, StepContext, etc.
 */
export * from './core/types.js';
export type { WorkflowEngineOptions } from './execution/engine.js';
/**
 * Direct engine access for advanced use cases.
 * Most users should use createWorkflow instead.
 */
export { WorkflowEngine } from './execution/engine.js';
export type {
  StartOptions,
  StepConfig,
  WaitForOptions,
  Workflow,
  WorkflowConfig,
} from './workflow/define.js';
/**
 * Main entry point for creating workflows.
 * Use this for 90% of use cases.
 */
export { createWorkflow } from './workflow/define.js';

// ============================================================================
// Hooks & Resume - For External Workflow Control
// ============================================================================

export { GotoSignal, WaitSignal } from './execution/context.js';
export type { HookOptions, HookResult } from './features/hooks.js';
/**
 * Create hooks for pausing workflows and resuming them from webhooks/APIs.
 *
 * @example
 * ```typescript
 * const hook = createHook(ctx, 'awaiting-approval');
 * await resumeHook(hook.token, { approved: true });
 * ```
 */
export { createHook, hookToken, resumeHook } from './features/hooks.js';

// ============================================================================
// Storage & Database - MongoDB Models & Repositories
// ============================================================================

export type { WorkflowDefinitionDoc } from './storage/definition.model.js';
/**
 * Optional: WorkflowDefinition storage for versioning and auditing.
 */
export {
  WorkflowDefinitionModel,
  workflowDefinitionRepository,
} from './storage/definition.model.js';
/**
 * Query builder and common queries for workflows.
 * Type-safe MongoDB query construction.
 */
export {
  CommonQueries,
  RUN_STATUS,
  STEP_STATUS,
  WorkflowQueryBuilder,
} from './storage/query-builder.js';
/**
 * Mongoose model for workflow runs.
 * Use this for direct MongoDB queries and custom indexes.
 */
export { WorkflowRunModel } from './storage/run.model.js';
export type { WorkflowRepositoryConfig, WorkflowRunRepository } from './storage/run.repository.js';
/**
 * Repository for workflow run CRUD operations.
 * Supports multi-tenancy and atomic updates.
 */
export {
  createWorkflowRepository,
  workflowRunRepository,
} from './storage/run.repository.js';
/**
 * Typed Mongo update-doc builders used by `WorkflowRunRepository.updateOne()`.
 *
 * `MongoUpdate` is the public shape of a well-formed operator update
 * (`$set`/`$unset`/`$inc`/`$push`/`$pull`/`$addToSet`). `normalizeUpdate`
 * is the runtime guard that rejects malformed shapes that mix operators
 * with raw field keys (Mongo would silently drop them). `runSet` /
 * `runSetUnset` are the builders every streamline write path uses.
 */
export type { MongoUpdate } from './storage/update-builders.js';
export {
  buildStepUpdateOps,
  normalizeUpdate,
  runSet,
  runSetUnset,
} from './storage/update-builders.js';

// ============================================================================
// Events & Observability
// ============================================================================

export type {
  BaseEventPayload,
  EngineErrorPayload,
  EventPayloadMap,
  EventSinkHandler,
  EventSinkOptions,
  StepCompletedPayload,
  StepEventPayload,
  StepFailedPayload,
  StepRetryPayload,
  WorkflowCompletedPayload,
  WorkflowEventName,
  WorkflowFailedPayload,
  WorkflowResumedPayload,
} from './core/events.js';
/**
 * Event bus for workflow lifecycle events.
 * Subscribe to workflow:started, step:completed, etc.
 */
export { createEventSink, globalEventBus, WorkflowEventBus } from './core/events.js';
export type { StepTimeline, StepUIState, WorkflowProgress } from './utils/visualization.js';
/**
 * Visualization helpers for building UIs.
 * Get step timeline, progress, execution path, etc.
 */
export {
  canRewindTo,
  getExecutionPath,
  getStepTimeline,
  getStepUIStates,
  getWaitingInfo,
  getWorkflowProgress,
} from './utils/visualization.js';

// ============================================================================
// Dependency Injection - For Testing & Multi-Instance Support
// ============================================================================

/**
 * Computed constants for monitoring and capacity planning.
 */
export { COMPUTED } from './config/constants.js';
export type { ContainerOptions, SignalStore, StreamlineContainer } from './core/container.js';
/**
 * Create isolated containers for testing or running multiple engines.
 * createWorkflow() handles this automatically for normal use.
 */
export { createContainer, isStreamlineContainer } from './core/container.js';
export type { CacheHealthStatus } from './storage/cache.js';
/**
 * Cache health monitoring for operational dashboards.
 */
export { WorkflowCache } from './storage/cache.js';
/**
 * Retention — TTL on terminal runs, tenant-prefixed compound indexes,
 * and the stale-run sweeper. Configure via `createContainer({ retention })`;
 * the lower-level `syncRetentionIndexes` + `StaleRunSweeper` exports are
 * for hosts driving retention from a deploy script directly.
 */
export type { RetentionOptions } from './storage/retention.js';
export {
  RETENTION_DEFAULTS,
  resolveSweeperConfig,
  StaleRunSweeper,
  syncRetentionIndexes,
} from './storage/retention.js';
export type { LogLevel, LogTransport } from './utils/logger.js';
/**
 * Centralized logger configuration.
 * Control log level, enable/disable, or plug in a custom transport (Pino, Winston, etc.).
 */
export { configureStreamlineLogger } from './utils/logger.js';

// ============================================================================
// Scheduling - Timezone-Aware Workflow Scheduling
// ============================================================================

export type {
  GetScheduledWorkflowsOptions,
  ScheduleWorkflowOptions,
  SchedulingServiceConfig,
  TimezoneCalculationResult,
} from './scheduling/index.js';
/**
 * Schedule workflows for future execution with full timezone support.
 * Handles DST transitions automatically.
 */
export {
  SchedulingService,
  TimezoneHandler,
  timezoneHandler,
} from './scheduling/index.js';

// ============================================================================
// Multi-Tenancy - Repository Plugins
// ============================================================================

export type { TenantFilterOptions } from './plugins/index.js';
/**
 * Plugins for multi-tenant deployments.
 * Automatically inject tenant filters into all queries.
 */
export {
  singleTenantPlugin,
  tenantFilterPlugin,
} from './plugins/index.js';

// ============================================================================
// Advanced Features - Parallel, Conditional, Subworkflows
// ============================================================================

export type { ConditionalStep } from './features/conditional.js';
/**
 * Conditional step execution utilities.
 * Skip steps based on runtime conditions.
 */
export {
  conditions,
  createCondition,
  isConditionalStep,
  shouldSkipStep,
} from './features/conditional.js';
export type { ExecuteParallelOptions } from './features/parallel.js';
/**
 * Execute multiple async tasks in parallel.
 * Supports concurrency limits, timeouts, and different execution modes.
 */
export { executeParallel } from './features/parallel.js';

// ============================================================================
// Advanced Configuration (Optional)
// ============================================================================

/**
 * Scheduler configuration and stats for customizing and monitoring polling behavior.
 * Most users don't need this - engine handles it automatically.
 */
export type { SchedulerStats, SmartSchedulerConfig } from './execution/smart-scheduler.js';

// ============================================================================
// Hook Registry - For External Workflow Resume
// ============================================================================

/**
 * Hook registry for resuming workflows by token.
 * Used internally by resumeHook() - exposed for advanced use cases.
 */
export { hookRegistry, workflowRegistry } from './execution/engine.js';

// ============================================================================
// Arc-compatible Event Transport
// ============================================================================

/**
 * Arc-compatible event transport — `DomainEvent`, `EventTransport`,
 * `EventHandler` shapes are structurally identical to `@classytic/arc`'s.
 * Pass any arc transport (Memory/Redis/Kafka) into `createContainer({
 * eventTransport })` and subscribe glob-style:
 *
 * ```typescript
 * engine.container.eventTransport.subscribe('streamline:workflow.*', handler);
 * ```
 */
export type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';
export {
  bridgeBusToTransport,
  createEvent,
  type EventContext,
  type InProcessBusOptions,
  InProcessStreamlineBus,
  LEGACY_TO_CANONICAL,
  STREAMLINE_EVENTS,
  type StreamlineEventName,
} from './events/index.js';

// ============================================================================
// Error Classes - For Error Handling
// ============================================================================

export type { ErrorCode as ErrorCodeType } from './utils/errors.js';
/**
 * Custom error classes with rich context for debugging.
 *
 * **Implements `HttpError` from `@classytic/repo-core/errors`** —
 * `WorkflowError` and every subclass carry `status`, hierarchical `code`,
 * and `meta` so arc handlers and host HTTP layers map to the canonical
 * wire envelope without translation. The legacy screaming-snake
 * `ErrorCode` enum still works via the `legacyCode` slot for backwards
 * compat.
 *
 * @example
 * ```typescript
 * import {
 *   ErrorCode,                // legacy SCREAMING_SNAKE constants
 *   ErrorCodeHierarchical,    // new hierarchical 'workflow.not_found' constants
 *   WorkflowNotFoundError,
 * } from '@classytic/streamline';
 *
 * try {
 *   await workflow.resume(runId);
 * } catch (err) {
 *   // Three equivalent ways to identify the error — pick one:
 *   if (err.status === 404) { ... }                                       // HttpError
 *   if (err.code === ErrorCodeHierarchical.WORKFLOW_NOT_FOUND) { ... }    // canonical
 *   if (err.legacyCode === ErrorCode.WORKFLOW_NOT_FOUND) { ... }          // legacy
 * }
 * ```
 */
export {
  ConcurrencyLimitReachedError,
  DataCorruptionError,
  ERROR_STATUS_MAP,
  ErrorCode,
  ErrorCodeHierarchical,
  InvalidStateError,
  MaxRetriesExceededError,
  NonRetriableError,
  StepNotFoundError,
  StepTimeoutError,
  WorkflowError,
  WorkflowNotFoundError,
} from './utils/errors.js';
