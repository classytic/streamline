/**
 * Custom error classes with rich context for better debugging
 */

/**
 * Standardized error codes for programmatic error handling.
 * Use these codes to handle specific error conditions in your application.
 *
 * @example
 * ```typescript
 * try {
 *   await workflow.resume(runId);
 * } catch (err) {
 *   if (err.code === ErrorCode.WORKFLOW_NOT_FOUND) {
 *     // Handle missing workflow
 *   }
 * }
 * ```
 */
export const ErrorCode = {
  // Workflow errors
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  WORKFLOW_ALREADY_COMPLETED: 'WORKFLOW_ALREADY_COMPLETED',
  WORKFLOW_CANCELLED: 'WORKFLOW_CANCELLED',

  // Step errors
  STEP_NOT_FOUND: 'STEP_NOT_FOUND',
  STEP_TIMEOUT: 'STEP_TIMEOUT',
  STEP_FAILED: 'STEP_FAILED',

  // State errors
  INVALID_STATE: 'INVALID_STATE',
  INVALID_TRANSITION: 'INVALID_TRANSITION',

  // Data errors
  DATA_CORRUPTION: 'DATA_CORRUPTION',
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Execution errors
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
  EXECUTION_ABORTED: 'EXECUTION_ABORTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class WorkflowError extends Error {
  public readonly code: ErrorCode;

  constructor(
    message: string,
    code: ErrorCode,
    public readonly context: {
      runId?: string;
      workflowId?: string;
      stepId?: string;
      [key: string]: unknown;
    },
  ) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }

  override toString(): string {
    const contextStr = Object.entries(this.context)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    return `${this.name} [${this.code}]: ${this.message} (${contextStr})`;
  }
}

export class StepNotFoundError extends WorkflowError {
  constructor(stepId: string, workflowId: string, availableSteps: string[]) {
    super(
      `Step "${stepId}" not found in workflow "${workflowId}". Available steps: ${availableSteps.join(', ')}`,
      ErrorCode.STEP_NOT_FOUND,
      { stepId, workflowId, availableSteps },
    );
    this.name = 'StepNotFoundError';
  }
}

export class WorkflowNotFoundError extends WorkflowError {
  constructor(runId: string) {
    super(`Workflow run "${runId}" not found in database`, ErrorCode.WORKFLOW_NOT_FOUND, { runId });
    this.name = 'WorkflowNotFoundError';
  }
}

export class InvalidStateError extends WorkflowError {
  constructor(
    action: string,
    currentState: string,
    expectedStates: string[],
    context: { runId?: string; stepId?: string },
  ) {
    super(
      `Cannot ${action} - workflow is in state "${currentState}". Expected one of: ${expectedStates.join(', ')}`,
      ErrorCode.INVALID_STATE,
      { action, currentState, expectedStates, ...context },
    );
    this.name = 'InvalidStateError';
  }
}

export class StepTimeoutError extends WorkflowError {
  constructor(stepId: string, timeoutMs: number, runId?: string) {
    super(`Step "${stepId}" exceeded timeout of ${timeoutMs}ms`, ErrorCode.STEP_TIMEOUT, {
      stepId,
      timeoutMs,
      runId,
    });
    this.name = 'StepTimeoutError';
  }
}

export class DataCorruptionError extends WorkflowError {
  constructor(reason: string, context: { runId: string; [key: string]: unknown }) {
    super(`Data corruption detected: ${reason}`, ErrorCode.DATA_CORRUPTION, context);
    this.name = 'DataCorruptionError';
  }
}

export class MaxRetriesExceededError extends WorkflowError {
  constructor(stepId: string, attempts: number, runId?: string) {
    super(`Step "${stepId}" failed after ${attempts} attempts`, ErrorCode.MAX_RETRIES_EXCEEDED, {
      stepId,
      attempts,
      runId,
    });
    this.name = 'MaxRetriesExceededError';
  }
}

/**
 * Throw this to immediately fail a step without retrying.
 * The executor checks `error.retriable === false` and skips all retry attempts.
 *
 * @example
 * ```typescript
 * if (!isValidInput(ctx.input)) {
 *   throw new NonRetriableError('Invalid input — retrying won\'t help');
 * }
 * ```
 */
export class NonRetriableError extends Error {
  public readonly retriable = false as const;

  constructor(message: string) {
    super(message);
    this.name = 'NonRetriableError';
  }
}

/** Coerce any thrown value (null, string, number, Error) into an Error instance. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value ?? 'Unknown error'));
}
