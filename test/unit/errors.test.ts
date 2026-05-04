/**
 * Unit tests for src/utils/errors.ts.
 *
 * **Migration note (HttpError conformance).** Pre-migration `err.code` held
 * the screaming-snake legacy value (`'WORKFLOW_NOT_FOUND'`). Post-migration
 * `err.code` is the hierarchical HttpError-canonical form
 * (`'workflow.not_found'`); the legacy value moved to `err.legacyCode`.
 * `err.status` and `err.meta` are new — they make the error implement
 * `HttpError` from `@classytic/repo-core/errors`.
 */

import { describe, expect, it } from 'vitest';
import {
  DataCorruptionError,
  ERROR_STATUS_MAP,
  ErrorCode,
  ErrorCodeHierarchical,
  InvalidStateError,
  MaxRetriesExceededError,
  StepNotFoundError,
  StepTimeoutError,
  toError,
  WorkflowError,
  WorkflowNotFoundError,
} from '../../src/utils/errors.js';

describe('toError', () => {
  it('should pass through Error instances', () => {
    const err = new Error('test');
    expect(toError(err)).toBe(err);
  });

  it('should wrap string into Error', () => {
    const err = toError('something broke');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('something broke');
  });

  it('should wrap null into Error', () => {
    const err = toError(null);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Unknown error');
  });

  it('should wrap undefined into Error', () => {
    const err = toError(undefined);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Unknown error');
  });

  it('should wrap number into Error', () => {
    const err = toError(42);
    expect(err.message).toBe('42');
  });

  it('should wrap object into Error', () => {
    const err = toError({ code: 'FAIL' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('Error classes — legacy fields preserved', () => {
  it('WorkflowError keeps `context` field for backwards compat', () => {
    const err = new WorkflowError('test', ErrorCode.WORKFLOW_NOT_FOUND, { runId: 'r1' });
    expect(err.context.runId).toBe('r1');
    expect(err.name).toBe('WorkflowError');
    // toString includes the hierarchical code (the new canonical form).
    expect(err.toString()).toContain('workflow.not_found');
  });

  it('StepNotFoundError lists available steps', () => {
    const err = new StepNotFoundError('missing', 'wf1', ['a', 'b', 'c']);
    expect(err.message).toContain('missing');
    expect(err.message).toContain('a, b, c');
    expect(err.legacyCode).toBe(ErrorCode.STEP_NOT_FOUND);
  });

  it('WorkflowNotFoundError includes runId', () => {
    const err = new WorkflowNotFoundError('run-123');
    expect(err.message).toContain('run-123');
    expect(err.legacyCode).toBe(ErrorCode.WORKFLOW_NOT_FOUND);
  });

  it('InvalidStateError shows current and expected states', () => {
    const err = new InvalidStateError('resume', 'cancelled', ['waiting', 'running'], {
      runId: 'r1',
    });
    expect(err.message).toContain('cancelled');
    expect(err.message).toContain('waiting, running');
  });

  it('StepTimeoutError includes timeout value', () => {
    const err = new StepTimeoutError('slow-step', 5000, 'r1');
    expect(err.message).toContain('5000ms');
    expect(err.legacyCode).toBe(ErrorCode.STEP_TIMEOUT);
  });

  it('MaxRetriesExceededError includes attempts', () => {
    const err = new MaxRetriesExceededError('flaky', 3, 'r1');
    expect(err.message).toContain('3 attempts');
    expect(err.legacyCode).toBe(ErrorCode.MAX_RETRIES_EXCEEDED);
  });
});

describe('ErrorCode constants — legacy SCREAMING_SNAKE form', () => {
  it('exposes the original codes for backwards compat', () => {
    expect(ErrorCode.WORKFLOW_NOT_FOUND).toBe('WORKFLOW_NOT_FOUND');
    expect(ErrorCode.STEP_NOT_FOUND).toBe('STEP_NOT_FOUND');
    expect(ErrorCode.INVALID_STATE).toBe('INVALID_STATE');
    expect(ErrorCode.DATA_CORRUPTION).toBe('DATA_CORRUPTION');
    expect(ErrorCode.STEP_TIMEOUT).toBe('STEP_TIMEOUT');
    expect(ErrorCode.MAX_RETRIES_EXCEEDED).toBe('MAX_RETRIES_EXCEEDED');
  });
});

describe('ErrorCodeHierarchical — new HttpError-canonical form', () => {
  it('uses dotted hierarchical ids per repo-core convention', () => {
    expect(ErrorCodeHierarchical.WORKFLOW_NOT_FOUND).toBe('workflow.not_found');
    expect(ErrorCodeHierarchical.STEP_NOT_FOUND).toBe('workflow.step.not_found');
    expect(ErrorCodeHierarchical.STEP_TIMEOUT).toBe('workflow.step.timeout');
    expect(ErrorCodeHierarchical.INVALID_STATE).toBe('workflow.invalid_state');
    expect(ErrorCodeHierarchical.DATA_CORRUPTION).toBe('workflow.data_corruption');
  });

  it('covers every legacy code (compile-time `satisfies Record<ErrorCode, string>`)', () => {
    // If a new ErrorCode is added without a hierarchical alias, this loop
    // throws — proving the `satisfies Record<ErrorCode, string>` annotation
    // on the const is the actual enforcement.
    for (const legacy of Object.values(ErrorCode)) {
      const hierarchical = ErrorCodeHierarchical[legacy];
      expect(hierarchical).toBeDefined();
      expect(hierarchical.startsWith('workflow.')).toBe(true);
    }
  });
});

describe('HttpError conformance — status + hierarchical code on every WorkflowError', () => {
  it('WorkflowError implements HttpError shape: status, code, meta, message', () => {
    const err = new WorkflowError('boom', ErrorCode.WORKFLOW_NOT_FOUND, { runId: 'r1' });
    // status is the HTTP code, taken from ERROR_STATUS_MAP.
    expect(err.status).toBe(404);
    expect(err.status).toBe(ERROR_STATUS_MAP.WORKFLOW_NOT_FOUND);
    // code is the hierarchical (HttpError-canonical) form.
    expect(err.code).toBe('workflow.not_found');
    expect(err.code).toBe(ErrorCodeHierarchical.WORKFLOW_NOT_FOUND);
    // legacyCode preserves the screaming-snake form for backwards-compat
    // callers doing `err.legacyCode === ErrorCode.X`.
    expect(err.legacyCode).toBe(ErrorCode.WORKFLOW_NOT_FOUND);
    expect(err.legacyCode).toBe('WORKFLOW_NOT_FOUND');
    // meta mirrors context — same object.
    expect(err.meta).toBe(err.context);
    expect(err.meta.runId).toBe('r1');
  });

  it.each([
    ['WorkflowNotFoundError', new WorkflowNotFoundError('r1'), 404, 'workflow.not_found'],
    [
      'StepNotFoundError',
      new StepNotFoundError('s', 'wf', ['a']),
      404,
      'workflow.step.not_found',
    ],
    ['StepTimeoutError', new StepTimeoutError('s', 5000, 'r1'), 408, 'workflow.step.timeout'],
    [
      'InvalidStateError',
      new InvalidStateError('resume', 'done', ['waiting'], { runId: 'r1' }),
      400,
      'workflow.invalid_state',
    ],
    [
      'DataCorruptionError',
      new DataCorruptionError('bad data', { runId: 'r1' }),
      500,
      'workflow.data_corruption',
    ],
    [
      'MaxRetriesExceededError',
      new MaxRetriesExceededError('s', 3, 'r1'),
      500,
      'workflow.max_retries_exceeded',
    ],
  ])('%s carries the right status + hierarchical code', (_name, err, expectedStatus, expectedCode) => {
    expect(err.status).toBe(expectedStatus);
    expect(err.code).toBe(expectedCode);
    // Sanity: it's still a WorkflowError + an Error.
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(Error);
  });

  it('every entry in ERROR_STATUS_MAP is a valid HTTP status code', () => {
    for (const status of Object.values(ERROR_STATUS_MAP)) {
      // 4xx caller errors / 5xx server errors only — no 1xx/2xx/3xx for
      // workflow failures, no nonsense codes.
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
