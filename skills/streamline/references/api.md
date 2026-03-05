# Complete API Reference

## Core Types

### WorkflowRun

```typescript
interface WorkflowRun<TContext = Record<string, unknown>> {
  _id: string;
  workflowId: string;
  status: 'draft' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  steps: StepState[];
  currentStepId: string | null;
  context: TContext;
  input: unknown;
  output?: unknown;
  error?: WorkflowError;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  lastHeartbeat?: Date;
  paused?: boolean;
  scheduling?: SchedulingInfo;
  userId?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
}
```

### StepState

```typescript
interface StepState<TOutput = unknown> {
  stepId: string;
  status: 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
  attempts: number;
  startedAt?: Date;
  endedAt?: Date;
  output?: TOutput;
  waitingFor?: WaitingFor;
  error?: StepError;
  retryAfter?: Date;
}

interface WaitingFor {
  type: string;
  reason: string;
  resumeAt?: Date;
  eventName?: string;
  data?: unknown;
}
```

### Step Definition

```typescript
interface Step {
  id: string;
  name: string;
  description?: string;
  retries?: number;        // Default: 3
  timeout?: number;        // No default (max: 30 min)
  condition?: (context: unknown, run: WorkflowRun) => boolean | Promise<boolean>;
  skipIf?: (context: unknown) => boolean | Promise<boolean>;
  runIf?: (context: unknown) => boolean | Promise<boolean>;
}
```

### StepContext (Full Interface)

```typescript
interface StepContext<TContext> {
  // Properties
  runId: string;
  stepId: string;
  context: TContext;
  input: unknown;
  attempt: number;         // 1-based retry attempt
  signal: AbortSignal;

  // Context mutation
  set<K extends keyof TContext>(key: K, value: TContext[K]): Promise<void>;

  // Cross-step data
  getOutput<T = unknown>(stepId: string): T | undefined;

  // Flow control
  wait(reason: string, data?: unknown): Promise<never>;
  waitFor(eventName: string, reason?: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;

  // Long-running
  heartbeat(): Promise<void>;

  // Observability
  emit(eventName: string, data: unknown): void;
  log(message: string, data?: unknown): void;
}
```

## Type Inference Utilities

```typescript
// Extract context type from a workflow definition
type InferContext<T> = T extends WorkflowDefinition<infer TContext> ? TContext : never;

// Extract context from handlers
type InferHandlersContext<T> = T extends WorkflowHandlers<infer TContext> ? TContext : never;

// Type-safe handlers matching a definition
type TypedHandlers<TWorkflow extends WorkflowDefinition<any>, TContext = InferContext<TWorkflow>> = {
  [K in StepIds<TWorkflow>]: StepHandler<unknown, TContext>;
};

// Get step IDs as union type
type StepIds<T extends WorkflowDefinition<any>> = T['steps'][number]['id'];
```

## Status Constants

```typescript
export const RUN_STATUS = {
  DRAFT: 'draft',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;
```

## Error Codes

```typescript
export const ErrorCode = {
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  WORKFLOW_ALREADY_COMPLETED: 'WORKFLOW_ALREADY_COMPLETED',
  WORKFLOW_CANCELLED: 'WORKFLOW_CANCELLED',
  STEP_NOT_FOUND: 'STEP_NOT_FOUND',
  STEP_TIMEOUT: 'STEP_TIMEOUT',
  STEP_FAILED: 'STEP_FAILED',
  INVALID_STATE: 'INVALID_STATE',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  DATA_CORRUPTION: 'DATA_CORRUPTION',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
  EXECUTION_ABORTED: 'EXECUTION_ABORTED',
} as const;
```

## Error Classes

```typescript
class WorkflowError extends Error {
  code: ErrorCode;
  context: Record<string, unknown>;
  toString(): string;
}

class WorkflowNotFoundError extends WorkflowError {}   // code: WORKFLOW_NOT_FOUND
class StepNotFoundError extends WorkflowError {}        // code: STEP_NOT_FOUND
class InvalidStateError extends WorkflowError {}        // code: INVALID_STATE
class StepTimeoutError extends WorkflowError {}         // code: STEP_TIMEOUT
class DataCorruptionError extends WorkflowError {}      // code: DATA_CORRUPTION
class MaxRetriesExceededError extends WorkflowError {}  // code: MAX_RETRIES_EXCEEDED

// Error message builder
function createErrorMessage(parts: {
  action: string;
  subject?: string;
  reason?: string;
  suggestion?: string;
}): string;
```

## Configuration Constants

### Timing

| Constant | Value | Description |
|----------|-------|-------------|
| `HEARTBEAT_INTERVAL_MS` | 30,000 | Heartbeat frequency |
| `SHORT_DELAY_THRESHOLD_MS` | 5,000 | In-process vs scheduler delay threshold |
| `STALE_WORKFLOW_THRESHOLD_MS` | 300,000 | When to consider a workflow stale (5 min) |
| `MAX_RETRY_DELAY_MS` | 60,000 | Maximum retry backoff delay |
| `RETRY_BASE_DELAY_MS` | 1,000 | Initial retry delay |
| `RETRY_MULTIPLIER` | 2 | Exponential backoff multiplier |

### Limits

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_CACHE_SIZE` | 10,000 | LRU cache max entries |
| `DEFAULT_BATCH_SIZE` | 100 | Default batch size for queries |
| `MAX_ID_LENGTH` | 100 | Max workflow/step ID length |
| `MAX_STEPS_PER_WORKFLOW` | 1,000 | Max steps per workflow |
| `MAX_RETRIES` | 20 | Absolute max retry attempts |
| `MAX_STEP_TIMEOUT_MS` | 1,800,000 | Max step timeout (30 min) |

### Scheduler

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_MAX_ATTEMPTS` | 3 | Default retry attempts |
| `DEFAULT_TIMEOUT_MS` | 30,000 | Default step timeout |
| `MIN_POLL_INTERVAL_MS` | 10,000 | Min scheduler poll (under load) |
| `MAX_POLL_INTERVAL_MS` | 300,000 | Max scheduler poll (idle) |
| `BASE_POLL_INTERVAL_MS` | 60,000 | Normal scheduler poll |
| `SCHEDULER_BATCH_SIZE` | 100 | Workflows processed per poll |

## Computed Constants

```typescript
export const COMPUTED = {
  CACHE_WARNING_THRESHOLD: number;
  CACHE_CRITICAL_THRESHOLD: number;
  MAX_TIMEOUT_SAFE_MS: number;
  RETRY_DELAY_SEQUENCE_MS: number[];  // Pre-computed: [1000, 2000, 4000, 8000, ...]
};
```

## WorkflowRunRepository Interface

```typescript
interface WorkflowRunRepository {
  create<TContext>(run: WorkflowRun<TContext>): Promise<WorkflowRun<TContext>>;
  getById<TContext>(id: string): Promise<WorkflowRun<TContext> | null>;
  getAll: Repository<WorkflowRun>['getAll'];
  update<TContext>(id: string, data: Partial<WorkflowRun<TContext>>, options?: AtomicUpdateOptions): Promise<WorkflowRun<TContext>>;
  delete: Repository<WorkflowRun>['delete'];
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: AtomicUpdateOptions): Promise<{ modifiedCount: number }>;

  // Specialized queries
  getActiveRuns(): Promise<LeanWorkflowRun[]>;
  getRunsByWorkflow(workflowId: string, limit?: number): Promise<LeanWorkflowRun[]>;
  getWaitingRuns(): Promise<LeanWorkflowRun[]>;
  getRunningRuns(): Promise<LeanWorkflowRun[]>;
  getReadyToResume(now: Date, limit?: number): Promise<LeanWorkflowRun[]>;
  getReadyForRetry(now: Date, limit?: number): Promise<LeanWorkflowRun[]>;
  getStaleRunningWorkflows(staleThresholdMs: number, limit?: number): Promise<LeanWorkflowRun[]>;
  getScheduledWorkflowsReadyToExecute(now: Date, options?: {
    page?: number;
    limit?: number;
    cursor?: string | null;
    tenantId?: string;
  }): Promise<PaginatedResult<LeanWorkflowRun>>;

  readonly base: Repository<WorkflowRun>; // Underlying mongokit repository
}
```

## WorkflowQueryBuilder

```typescript
class WorkflowQueryBuilder {
  static create(): WorkflowQueryBuilder;
  withStatus(status: RunStatus | RunStatus[]): this;
  notPaused(): this;
  isPaused(): this;
  withWorkflowId(workflowId: string): this;
  withRunId(runId: string): this;
  withUserId(userId: string): this;
  withTags(tags: string | string[]): this;
  withStepReady(stepStatus: StepStatus, field: string, beforeTime: Date): this;
}
```

## Event System

### WorkflowEventBus

```typescript
class WorkflowEventBus extends EventEmitter {
  emit<K extends WorkflowEventName>(event: K, payload: EventPayloadMap[K]): boolean;
  on<K extends WorkflowEventName>(event: K, listener: (payload: EventPayloadMap[K]) => void): this;
  once<K extends WorkflowEventName>(event: K, listener: (payload: EventPayloadMap[K]) => void): this;
  off<K extends WorkflowEventName>(event: K, listener: (payload: EventPayloadMap[K]) => void): this;
}

const globalEventBus: WorkflowEventBus; // Singleton
```

### Event Names

| Category | Events |
|----------|--------|
| Workflow | `workflow:started`, `workflow:completed`, `workflow:failed`, `workflow:waiting`, `workflow:resumed`, `workflow:cancelled`, `workflow:recovered`, `workflow:retry` |
| Step | `step:started`, `step:completed`, `step:failed`, `step:waiting`, `step:skipped`, `step:retry-scheduled` |
| System | `engine:error`, `scheduler:error`, `scheduler:circuit-open` |

## Mongoose Models

```typescript
export { WorkflowRunModel }         // Mongoose model for workflow runs
export { WorkflowDefinitionModel }  // Mongoose model for workflow definitions (versioning)
```

## Container

```typescript
interface StreamlineContainer {
  repository: WorkflowRunRepository;
  eventBus: WorkflowEventBus;
  cache: WorkflowCache;
}

function createContainer(options?: ContainerOptions): StreamlineContainer;
function isStreamlineContainer(obj: unknown): obj is StreamlineContainer;

interface ContainerOptions {
  repository?: WorkflowRunRepository | WorkflowRepositoryConfig;
  eventBus?: WorkflowEventBus | 'global';
  cache?: WorkflowCache;
}
```

## Visualization Helpers

```typescript
function getStepTimeline(run: WorkflowRun): StepTimeline[];
function getWorkflowProgress(run: WorkflowRun): WorkflowProgress;
function getStepUIStates(run: WorkflowRun): StepUIState[];
function getWaitingInfo(run: WorkflowRun): WaitingInfo | null;
function canRewindTo(run: WorkflowRun, stepId: string): boolean;
function getExecutionPath(run: WorkflowRun): string[];

interface WorkflowProgress {
  completed: number;
  total: number;
  percentage: number;
}
```

## Parallel Execution

```typescript
function executeParallel<T>(
  tasks: Array<() => Promise<T>>,
  options?: ExecuteParallelOptions
): Promise<T[] | Array<{ success: boolean; value?: T; reason?: unknown }>>;

interface ExecuteParallelOptions {
  mode?: 'all' | 'race' | 'any' | 'allSettled';  // Default: 'all'
  concurrency?: number;                           // Default: Infinity
  timeout?: number;                               // Per-task timeout in ms
}
```

## Hooks API

```typescript
function createHook(
  ctx: StepContext,
  reason: string,
  options?: { token?: string }
): { token: string; path: string };

function resumeHook(
  token: string,
  payload: unknown
): Promise<{ runId: string; run: WorkflowRun }>;

function hookToken(...parts: string[]): string;
```
