/**
 * Unit tests for src/utils/errors.ts
 * Pure functions — no DB required.
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  WorkflowError,
  StepNotFoundError,
  WorkflowNotFoundError,
  InvalidStateError,
  StepTimeoutError,
  MaxRetriesExceededError,
  toError,
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

describe('Error classes', () => {
  it('WorkflowError should have code and context', () => {
    const err = new WorkflowError('test', ErrorCode.WORKFLOW_NOT_FOUND, { runId: 'r1' });
    expect(err.code).toBe('WORKFLOW_NOT_FOUND');
    expect(err.context.runId).toBe('r1');
    expect(err.name).toBe('WorkflowError');
    expect(err.toString()).toContain('WORKFLOW_NOT_FOUND');
  });

  it('StepNotFoundError should list available steps', () => {
    const err = new StepNotFoundError('missing', 'wf1', ['a', 'b', 'c']);
    expect(err.message).toContain('missing');
    expect(err.message).toContain('a, b, c');
    expect(err.code).toBe(ErrorCode.STEP_NOT_FOUND);
  });

  it('WorkflowNotFoundError should include runId', () => {
    const err = new WorkflowNotFoundError('run-123');
    expect(err.message).toContain('run-123');
    expect(err.code).toBe(ErrorCode.WORKFLOW_NOT_FOUND);
  });

  it('InvalidStateError should show current and expected states', () => {
    const err = new InvalidStateError('resume', 'cancelled', ['waiting', 'running'], { runId: 'r1' });
    expect(err.message).toContain('cancelled');
    expect(err.message).toContain('waiting, running');
  });

  it('StepTimeoutError should include timeout value', () => {
    const err = new StepTimeoutError('slow-step', 5000, 'r1');
    expect(err.message).toContain('5000ms');
    expect(err.code).toBe(ErrorCode.STEP_TIMEOUT);
  });

  it('MaxRetriesExceededError should include attempts', () => {
    const err = new MaxRetriesExceededError('flaky', 3, 'r1');
    expect(err.message).toContain('3 attempts');
    expect(err.code).toBe(ErrorCode.MAX_RETRIES_EXCEEDED);
  });
});

describe('ErrorCode', () => {
  it('should have all expected codes', () => {
    expect(ErrorCode.WORKFLOW_NOT_FOUND).toBe('WORKFLOW_NOT_FOUND');
    expect(ErrorCode.STEP_NOT_FOUND).toBe('STEP_NOT_FOUND');
    expect(ErrorCode.INVALID_STATE).toBe('INVALID_STATE');
    expect(ErrorCode.DATA_CORRUPTION).toBe('DATA_CORRUPTION');
    expect(ErrorCode.STEP_TIMEOUT).toBe('STEP_TIMEOUT');
    expect(ErrorCode.MAX_RETRIES_EXCEEDED).toBe('MAX_RETRIES_EXCEEDED');
  });
});
