/**
 * Custom error classes with rich context for better debugging.
 *
 * **HttpError conformance.** `WorkflowError` (and every subclass) implements
 * `HttpError` from `@classytic/repo-core/errors` — the canonical wire shape
 * arc handlers and host HTTP layers map to JSON envelopes. Three fields:
 *
 *   - `status: number`  — HTTP status code (404, 408, 409, 500, ...)
 *   - `code: string`    — hierarchical machine-readable id
 *                         (`'workflow.not_found'`, `'workflow.step.timeout'`)
 *   - `meta?: Record<string, unknown>` — structured diagnostics (no PII)
 *
 * Pre-fix, `WorkflowError` had a custom `code: ErrorCode` string-enum but
 * no `status`, so every host had to maintain its own
 * `WORKFLOW_NOT_FOUND → 404` translation table. With HttpError the mapping
 * is intrinsic to the error; arc and any other repo-core-aware HTTP layer
 * surface it correctly without a translation step.
 *
 * Backwards compat: the original screaming-snake `ErrorCode` enum still
 * exists and `WorkflowError.code` still equals the legacy value
 * (`'WORKFLOW_NOT_FOUND'`). The new hierarchical id lives on
 * `WorkflowError.codeHierarchical` and is what the HttpError shape
 * publishes via the inherited `code` slot — both paths stay live for one
 * minor while consumers migrate.
 */

import type { HttpError } from '@classytic/repo-core/errors';

/**
 * Standardized error codes for programmatic error handling.
 *
 * **Legacy `code` value.** Pre-HttpError-migration, `WorkflowError.code`
 * was set to the screaming-snake string here (e.g.
 * `'WORKFLOW_NOT_FOUND'`). Existing consumers using
 * `err.code === ErrorCode.WORKFLOW_NOT_FOUND` keep working — the legacy
 * value is preserved on `err.legacyCode`.
 *
 * **New canonical `code`.** The HttpError-conformant `err.code` is the
 * hierarchical alias (e.g. `'workflow.not_found'`). New consumers
 * comparing against repo-core/arc patterns should switch to the
 * hierarchical form via the `ErrorCodeHierarchical` map below.
 *
 * @example
 * ```typescript
 * try {
 *   await workflow.resume(runId);
 * } catch (err) {
 *   // Both work — pick one for your codebase.
 *   if (err.code === ErrorCodeHierarchical.WORKFLOW_NOT_FOUND) { ... }    // new
 *   if (err.legacyCode === ErrorCode.WORKFLOW_NOT_FOUND) { ... }          // legacy
 *   if (err.status === 404) { ... }                                       // HttpError
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
  CONCURRENCY_LIMIT_REACHED: 'CONCURRENCY_LIMIT_REACHED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Hierarchical (HttpError-canonical) version of {@link ErrorCode}.
 *
 * Format: `workflow.<topic>` or `workflow.<area>.<topic>`. Matches
 * repo-core's "extend hierarchically with a domain prefix" guidance for
 * `HttpError.code` — hosts can switch on `'workflow.not_found'` exactly
 * like they switch on `'order.validation.missing_line'` or
 * `'payment.gateway.timeout'`.
 */
export const ErrorCodeHierarchical = {
  WORKFLOW_NOT_FOUND: 'workflow.not_found',
  WORKFLOW_ALREADY_COMPLETED: 'workflow.already_completed',
  WORKFLOW_CANCELLED: 'workflow.cancelled',
  STEP_NOT_FOUND: 'workflow.step.not_found',
  STEP_TIMEOUT: 'workflow.step.timeout',
  STEP_FAILED: 'workflow.step.failed',
  INVALID_STATE: 'workflow.invalid_state',
  INVALID_TRANSITION: 'workflow.invalid_transition',
  DATA_CORRUPTION: 'workflow.data_corruption',
  VALIDATION_ERROR: 'workflow.validation_error',
  MAX_RETRIES_EXCEEDED: 'workflow.max_retries_exceeded',
  EXECUTION_ABORTED: 'workflow.execution_aborted',
  CONCURRENCY_LIMIT_REACHED: 'workflow.concurrency_limit_reached',
} as const satisfies Record<ErrorCode, string>;

export type ErrorCodeHierarchical =
  (typeof ErrorCodeHierarchical)[keyof typeof ErrorCodeHierarchical];

/**
 * HTTP status mapping for each error code. Drives the `status` field on
 * the `HttpError` shape — arc / any HTTP-layer host reads this directly
 * instead of maintaining its own translation table.
 *
 * Choices:
 *   - `404` for not-found (workflow / step missing)
 *   - `408` for `STEP_TIMEOUT` (request timeout — the closest semantic match
 *     for "the operation didn't complete within its budget")
 *   - `409` for `WORKFLOW_CANCELLED` / `WORKFLOW_ALREADY_COMPLETED` /
 *     `EXECUTION_ABORTED` (state-conflict — the request can't proceed
 *     because of the current resource state)
 *   - `400` for `INVALID_STATE` / `INVALID_TRANSITION` /
 *     `VALIDATION_ERROR` (caller's fault)
 *   - `500` for `DATA_CORRUPTION` / `STEP_FAILED` / `MAX_RETRIES_EXCEEDED`
 *     (server-side condition the caller can't fix)
 */
export const ERROR_STATUS_MAP = {
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_ALREADY_COMPLETED: 409,
  WORKFLOW_CANCELLED: 409,
  STEP_NOT_FOUND: 404,
  STEP_TIMEOUT: 408,
  STEP_FAILED: 500,
  INVALID_STATE: 400,
  INVALID_TRANSITION: 400,
  DATA_CORRUPTION: 500,
  VALIDATION_ERROR: 400,
  MAX_RETRIES_EXCEEDED: 500,
  EXECUTION_ABORTED: 409,
  // 429 = Too Many Requests — semantically the rate-limit / quota family.
  // Caller can retry after backoff; the slot may free.
  CONCURRENCY_LIMIT_REACHED: 429,
} as const satisfies Record<ErrorCode, number>;

/**
 * Workflow error — implements repo-core's `HttpError` so arc handlers and
 * host HTTP layers auto-map to the canonical wire envelope.
 *
 * `code` is the hierarchical HttpError-canonical form
 * (`'workflow.not_found'`); `legacyCode` carries the screaming-snake
 * value for backwards compat with existing `err.legacyCode === ErrorCode.X`
 * (and `err.code === ErrorCode.X` callers should migrate to either
 * `legacyCode` or the hierarchical comparison).
 */
export class WorkflowError extends Error implements HttpError {
  /** HTTP status code derived from the error class. */
  public readonly status: number;
  /** Hierarchical machine-readable id — what `HttpError.code` publishes. */
  public readonly code: string;
  /** Legacy screaming-snake code; kept for backwards compat. */
  public readonly legacyCode: ErrorCode;
  /** Structured diagnostics — same shape as the legacy `context`. */
  public readonly meta: Record<string, unknown>;

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
    this.legacyCode = code;
    this.code = ErrorCodeHierarchical[code];
    this.status = ERROR_STATUS_MAP[code];
    // `meta` mirrors `context` so HttpError consumers reading
    // `err.meta` get the same diagnostics legacy callers got from
    // `err.context`. Both fields point at the same object.
    this.meta = context;
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
 * Thrown by `start()` when `concurrency.strict: true` is configured and
 * the bucket is at limit. Caller decides whether to retry (e.g. with
 * backoff) or fail loudly.
 *
 * Distinct from the best-effort `concurrency.limit` path, which queues
 * excess starts as drafts and auto-promotes when a slot frees. Strict
 * mode is "reject when full" — for workloads where queueing is unsafe
 * (payment captures with deadlines, SLA-bound tasks).
 *
 * Status `429 Too Many Requests` because the slot may free shortly;
 * the caller can retry after backoff.
 */
export class ConcurrencyLimitReachedError extends WorkflowError {
  constructor(workflowId: string, concurrencyKey: string, limit: number) {
    super(
      `Concurrency limit reached for workflow "${workflowId}" key "${concurrencyKey}" (limit: ${limit}). ` +
        `Strict mode rejects starts when the bucket is full — retry after backoff or queue externally.`,
      ErrorCode.CONCURRENCY_LIMIT_REACHED,
      { workflowId, concurrencyKey, limit },
    );
    this.name = 'ConcurrencyLimitReachedError';
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
