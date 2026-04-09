export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'draft' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface Step {
  id: string;
  name: string;
  description?: string;
  /**
   * Maximum number of execution attempts for this step (including the initial attempt).
   *
   * Example: retries=3 means:
   * - Attempt 1 (initial execution)
   * - Attempt 2 (first retry after failure)
   * - Attempt 3 (second retry after failure)
   * - Total: 3 attempts
   *
   * If all attempts fail, the step is marked as 'failed' and the workflow stops.
   * Uses exponential backoff: 1s, 2s, 4s, 8s, ... (max 60s between retries).
   *
   * @default 3
   */
  retries?: number;
  /**
   * Maximum execution time in milliseconds for this step.
   * If the step handler doesn't complete within this time, it throws a timeout error.
   *
   * @default undefined (no timeout)
   */
  timeout?: number;

  /**
   * Base delay in milliseconds before the first retry.
   * Used as the starting point for exponential backoff.
   *
   * @default 1000 (1 second)
   *
   * @example
   * ```typescript
   * step({ id: 'call-api', retries: 3, retryDelay: 5000 }) // 5s, 10s, 20s
   * ```
   */
  retryDelay?: number;

  /**
   * Backoff strategy for retries.
   * - 'exponential': delay doubles each attempt (default)
   * - 'linear': delay stays constant
   * - 'fixed': alias for 'linear'
   * - number: custom multiplier (e.g., 3 for tripling)
   *
   * @default 'exponential'
   */
  retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;

  // ============ Conditional Execution ============

  /**
   * Full condition function with access to context and run.
   * Return true to execute the step, false to skip.
   *
   * @example
   * ```typescript
   * step({
   *   id: 'send-email',
   *   name: 'Send Email',
   *   condition: (context, run) => context.shouldSendEmail && run.status === 'running'
   * })
   * ```
   */
  condition?: (context: unknown, run: WorkflowRun) => boolean | Promise<boolean>;

  /**
   * Skip this step if the predicate returns true.
   * Simpler alternative to condition for basic skip logic.
   *
   * @example
   * ```typescript
   * step({ id: 'optional-step', name: 'Optional', skipIf: (ctx) => !ctx.featureEnabled })
   * ```
   */
  skipIf?: (context: unknown) => boolean | Promise<boolean>;

  /**
   * Only run this step if the predicate returns true.
   * Simpler alternative to condition for basic run logic.
   *
   * @example
   * ```typescript
   * step({ id: 'premium-feature', name: 'Premium', runIf: (ctx) => ctx.isPremiumUser })
   * ```
   */
  runIf?: (context: unknown) => boolean | Promise<boolean>;
}

/**
 * A single log entry persisted on the workflow run document.
 * Captured via ctx.log() and visible via GET /api/workflows/:id/runs/:runId
 */
export interface StepLogEntry {
  /** Step that produced this log */
  stepId: string;
  /** Log message */
  message: string;
  /** Optional structured data */
  data?: unknown;
  /** Attempt number when log was captured */
  attempt: number;
  /** Timestamp of the log entry */
  timestamp: Date;
}

export interface StepError {
  message: string;
  code?: string;
  retriable?: boolean;
  stack?: string;
}

export interface WorkflowError {
  message: string;
  code?: string;
  stack?: string;
}

export interface WaitingFor {
  type: 'human' | 'webhook' | 'timer' | 'event' | 'childWorkflow';
  reason: string;
  resumeAt?: Date;
  eventName?: string;
  data?: unknown;
}

export interface StepState<TOutput = unknown> {
  stepId: string;
  status: StepStatus;
  attempts: number;
  startedAt?: Date;
  completedAt?: Date;
  endedAt?: Date;
  /**
   * Actual execution duration in milliseconds (completedAt - startedAt).
   * Only set when step completes (done/failed/skipped).
   * Useful for performance monitoring and SLA tracking.
   */
  durationMs?: number;
  output?: TOutput;
  waitingFor?: WaitingFor;
  error?: StepError;
  retryAfter?: Date; // Exponential backoff - don't retry before this time
}

/**
 * Scheduling metadata for timezone-aware workflow execution
 */
export interface SchedulingInfo {
  /**
   * User's intended local time as ISO string (without timezone suffix)
   * Format: "YYYY-MM-DDTHH:mm:ss" (e.g., "2024-03-10T09:00:00")
   * This is the ORIGINAL string the user provided, preserved for accurate rescheduling
   */
  scheduledFor: string;
  /** IANA timezone name (e.g., "America/New_York", "Europe/London") */
  timezone: string;
  /** Human-readable local time with timezone abbreviation (e.g., "2024-03-10 09:00:00 EDT") */
  localTimeDisplay: string;
  /** UTC execution time - used by scheduler for actual execution */
  executionTime: Date;
  /** Whether this time falls during a DST transition */
  isDSTTransition: boolean;
  /** Human-readable note about DST adjustments (if any) */
  dstNote?: string;
  /** Optional recurrence pattern for repeating workflows */
  recurrence?: RecurrencePattern;
}

/**
 * Recurrence pattern for scheduled workflows
 */
export interface RecurrencePattern {
  /** How often to repeat (daily, weekly, monthly, custom cron) */
  pattern: 'daily' | 'weekly' | 'monthly' | 'custom';
  /** For weekly: which days (0=Sunday, 6=Saturday) */
  daysOfWeek?: number[];
  /** For monthly: which day of month (1-31) */
  dayOfMonth?: number;
  /** Custom cron expression (if pattern='custom') */
  cronExpression?: string;
  /** Stop repeating after this date */
  until?: Date;
  /** Or stop after N occurrences */
  count?: number;
  /** How many times has this recurred so far */
  occurrences?: number;
}

export interface WorkflowRun<TContext = Record<string, unknown>> {
  _id: string;
  workflowId: string;
  status: RunStatus;
  steps: StepState[];
  currentStepId: string | null;
  context: TContext;
  input: unknown;
  output?: unknown;
  error?: WorkflowError; // Set when workflow fails due to unrecoverable error
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  lastHeartbeat?: Date; // For detecting stale/stuck running workflows
  paused?: boolean; // User-initiated pause - scheduler skips paused workflows
  /** Timezone-aware scheduling metadata (optional - only for scheduled workflows) */
  scheduling?: SchedulingInfo;
  /**
   * Persisted step-level logs captured via ctx.log().
   * Each entry includes stepId, message, optional data, attempt, and timestamp.
   * Queryable via GET /api/workflows/:workflowId/runs/:runId
   */
  stepLogs?: StepLogEntry[];
  /**
   * Idempotency key for deduplication.
   * If set, only one non-terminal run can exist per key.
   * Starting a workflow with a duplicate key returns the existing run.
   */
  idempotencyKey?: string;
  /**
   * Execution priority (higher = picked up sooner by scheduler).
   * @default 0
   */
  priority?: number;
  /** Concurrency grouping key (set by engine when concurrency config is active) */
  concurrencyKey?: string;
  userId?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface WorkflowDefinition<TContext = Record<string, unknown>> {
  id: string;
  name: string;
  version: string;
  steps: Step[];
  createContext: (input: unknown) => TContext;
  /**
   * Default values for all steps in this workflow.
   * Individual steps can override these defaults.
   */
  defaults?: {
    /**
     * Maximum number of execution attempts for each step (including initial attempt).
     * @default 3
     */
    retries?: number;
    /**
     * Maximum execution time in milliseconds for each step.
     * @default undefined (no timeout)
     */
    timeout?: number;
    /**
     * Base delay in milliseconds before the first retry.
     * @default 1000 (1 second)
     */
    retryDelay?: number;
    /**
     * Backoff strategy for retries.
     * @default 'exponential'
     */
    retryBackoff?: 'exponential' | 'linear' | 'fixed' | number;
  };
}

export interface StepContext<TContext = Record<string, unknown>> {
  runId: string;
  stepId: string;
  context: TContext;
  input: unknown;
  attempt: number;

  /**
   * AbortSignal for step cancellation.
   * Handlers should check this signal and abort long-running operations when triggered.
   * The signal is aborted when:
   * - Step timeout is exceeded
   * - Workflow is cancelled
   *
   * @example
   * ```typescript
   * async function fetchData(ctx) {
   *   const response = await fetch(url, { signal: ctx.signal });
   *   // ...
   * }
   * ```
   */
  signal: AbortSignal;

  set: <K extends keyof TContext>(key: K, value: TContext[K]) => Promise<void>;
  getOutput: <T = unknown>(stepId: string) => T | undefined;

  wait: (reason: string, data?: unknown) => Promise<never>;
  waitFor: (eventName: string, reason?: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;

  /**
   * Send a heartbeat to prevent the workflow from being marked as stale.
   * Use this in long-running steps (5+ minutes) to signal the step is still active.
   *
   * Heartbeats are automatically sent every 30 seconds during step execution,
   * but you can call this manually for extra control.
   *
   * @example
   * ```typescript
   * async function processLargeDataset(ctx) {
   *   for (const batch of batches) {
   *     await processBatch(batch);
   *     await ctx.heartbeat(); // Signal we're still alive
   *   }
   * }
   * ```
   */
  heartbeat: () => Promise<void>;

  emit: (eventName: string, data: unknown) => void;
  log: (message: string, data?: unknown) => void;

  /**
   * Save a typed checkpoint for crash-safe batch processing (durable loop).
   * On crash recovery, `getCheckpoint<T>()` returns the last saved value.
   *
   * @example
   * ```typescript
   * const last = ctx.getCheckpoint<number>() ?? -1;
   * for (let i = last + 1; i < items.length; i++) {
   *   await process(items[i]);
   *   await ctx.checkpoint(i);
   * }
   * ```
   */
  checkpoint: <T = unknown>(value: T) => Promise<void>;

  /**
   * Read the last checkpoint value saved by `checkpoint()`.
   * Returns `undefined` on first execution (no prior crash).
   *
   * Use the same type parameter as your `checkpoint()` call for type safety.
   */
  getCheckpoint: <T = unknown>() => T | undefined;

  /**
   * Start a child workflow and durably wait for it to complete.
   *
   * The parent step enters a waiting state. When the child reaches a terminal
   * state (done/failed/cancelled), the parent automatically resumes with the
   * child's output as this step's output.
   *
   * Durable: survives process restarts. The scheduler picks up the parent
   * when the child completes via the `childRunId` stored in waitingFor.
   *
   * @param workflowId - The child workflow's registered ID
   * @param input - Input data for the child workflow
   * @returns The child workflow's output (after it completes)
   *
   * @example
   * ```typescript
   * const pipeline = createWorkflow('pipeline', {
   *   steps: {
   *     validate: async (ctx) => { ... },
   *     runSubPipeline: async (ctx) => {
   *       return ctx.startChildWorkflow('sub-pipeline', { data: ctx.context.data });
   *       // Parent waits here. Resumes when child completes.
   *     },
   *     finalize: async (ctx) => {
   *       const childResult = ctx.getOutput('runSubPipeline');
   *       return { done: true, childResult };
   *     },
   *   },
   * });
   * ```
   */
  startChildWorkflow: (workflowId: string, input: unknown) => Promise<never>;

  /**
   * Jump to a different step, breaking out of the linear sequence.
   *
   * Use for conditional branching, error recovery paths, or skip-ahead logic.
   * The target step must exist in the workflow definition.
   *
   * @param stepId - The step ID to jump to
   *
   * @example
   * ```typescript
   * const workflow = createWorkflow('order', {
   *   steps: {
   *     validate: async (ctx) => {
   *       if (!ctx.context.paymentValid) {
   *         return ctx.goto('handleFailure'); // Skip to failure handler
   *       }
   *       return { valid: true };
   *     },
   *     process: async (ctx) => { ... },
   *     handleFailure: async (ctx) => { ... },
   *   },
   * });
   * ```
   */
  goto: (stepId: string) => Promise<never>;

  /**
   * Durable scatter/gather — execute tasks in parallel with crash recovery.
   *
   * Unlike `executeParallel()` (in-memory only), `scatter()` persists each
   * task's completion to MongoDB via checkpoints. If the process crashes
   * mid-scatter, only incomplete tasks re-execute on recovery.
   *
   * @param tasks - Named tasks to execute. Keys become result keys.
   * @param options - Concurrency limit (default: Infinity)
   * @returns Record of results keyed by task name
   *
   * @example
   * ```typescript
   * const results = await ctx.scatter({
   *   user: () => fetchUser(ctx.context.userId),
   *   orders: () => fetchOrders(ctx.context.userId),
   *   recommendations: () => getRecommendations(ctx.context.userId),
   * });
   *
   * // results.user, results.orders, results.recommendations
   * // If crash after 'user' completes, only 'orders' and 'recommendations' re-run.
   * ```
   */
  scatter: <T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
    options?: { concurrency?: number },
  ) => Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
}

export type StepHandler<TOutput = unknown, TContext = Record<string, unknown>> = (
  ctx: StepContext<TContext>,
) => Promise<TOutput>;

export type WorkflowHandlers<TContext = Record<string, unknown>> = {
  [stepId: string]: StepHandler<unknown, TContext>;
};

// ============ Type Inference Helpers ============

/**
 * Infer context type from WorkflowDefinition
 * @example
 * type MyContext = InferContext<typeof myWorkflow>
 */
export type InferContext<T> = T extends WorkflowDefinition<infer TContext> ? TContext : never;

/**
 * Infer context type from WorkflowHandlers
 * @example
 * type MyContext = InferHandlersContext<typeof myHandlers>
 */
export type InferHandlersContext<T> = T extends WorkflowHandlers<infer TContext> ? TContext : never;

/**
 * Strongly-typed handlers that match workflow steps
 * Ensures all step IDs have corresponding handlers
 * @example
 * const handlers: TypedHandlers<typeof workflow, MyContext> = { ... }
 */
export type TypedHandlers<
  TWorkflow extends WorkflowDefinition<any>,
  TContext = InferContext<TWorkflow>,
> = {
  [K in TWorkflow['steps'][number]['id']]: StepHandler<unknown, TContext>;
};

/**
 * Extract step IDs as union type from workflow definition
 * @example
 * type MyStepIds = StepIds<typeof myWorkflow> // 'step1' | 'step2' | 'step3'
 */
export type StepIds<T extends WorkflowDefinition<any>> = T['steps'][number]['id'];

/**
 * Payload for workflow and engine events
 */
export interface WorkflowEventPayload {
  runId?: string;
  stepId?: string;
  data?: unknown;
  error?: Error;
  context?: string;
  /**
   * Explicit broadcast flag for resuming multiple workflows.
   * When true, the event will resume ALL workflows waiting on this event.
   * When false/undefined with no runId, a warning is logged.
   */
  broadcast?: boolean;
}
