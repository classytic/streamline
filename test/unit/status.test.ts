/**
 * Unit tests for src/core/status.ts
 * State machine validation — pure functions, no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveRunStatus,
  isTerminalState,
  isValidStepTransition,
  isValidRunTransition,
  isStepStatus,
  isRunStatus,
} from '../../src/core/status.js';
import type { WorkflowRun } from '../../src/core/types.js';

const makeRun = (
  status: string,
  steps: Array<{ stepId: string; status: string; attempts: number }>,
): WorkflowRun =>
  ({
    _id: 'test',
    workflowId: 'wf',
    status,
    steps,
    currentStepId: null,
    context: {},
    input: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as WorkflowRun;

describe('deriveRunStatus', () => {
  it('should return done when all steps are done', () => {
    const run = makeRun('running', [
      { stepId: 'a', status: 'done', attempts: 1 },
      { stepId: 'b', status: 'done', attempts: 1 },
    ]);
    expect(deriveRunStatus(run)).toBe('done');
  });

  it('should return done when all steps are done or skipped', () => {
    const run = makeRun('running', [
      { stepId: 'a', status: 'done', attempts: 1 },
      { stepId: 'b', status: 'skipped', attempts: 0 },
    ]);
    expect(deriveRunStatus(run)).toBe('done');
  });

  it('should return failed when any step is failed', () => {
    const run = makeRun('running', [
      { stepId: 'a', status: 'done', attempts: 1 },
      { stepId: 'b', status: 'failed', attempts: 3 },
    ]);
    expect(deriveRunStatus(run)).toBe('failed');
  });

  it('should return waiting when any step is waiting', () => {
    const run = makeRun('running', [
      { stepId: 'a', status: 'done', attempts: 1 },
      { stepId: 'b', status: 'waiting', attempts: 1 },
    ]);
    expect(deriveRunStatus(run)).toBe('waiting');
  });

  it('should return running when steps are pending', () => {
    const run = makeRun('running', [
      { stepId: 'a', status: 'done', attempts: 1 },
      { stepId: 'b', status: 'pending', attempts: 0 },
    ]);
    expect(deriveRunStatus(run)).toBe('running');
  });

  it('should preserve cancelled status', () => {
    const run = makeRun('cancelled', [
      { stepId: 'a', status: 'done', attempts: 1 },
    ]);
    expect(deriveRunStatus(run)).toBe('cancelled');
  });

  it('should prioritize failed over waiting', () => {
    const run = makeRun('running', [
      { stepId: 'a', status: 'failed', attempts: 3 },
      { stepId: 'b', status: 'waiting', attempts: 1 },
    ]);
    expect(deriveRunStatus(run)).toBe('failed');
  });
});

describe('isTerminalState', () => {
  it('should return true for done, failed, cancelled', () => {
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
  });

  it('should return false for non-terminal states', () => {
    expect(isTerminalState('running')).toBe(false);
    expect(isTerminalState('waiting')).toBe(false);
    expect(isTerminalState('draft')).toBe(false);
  });
});

describe('isValidStepTransition', () => {
  it('should allow pending → running', () => {
    expect(isValidStepTransition('pending', 'running')).toBe(true);
  });
  it('should allow pending → skipped', () => {
    expect(isValidStepTransition('pending', 'skipped')).toBe(true);
  });
  it('should allow running → done/failed/waiting', () => {
    expect(isValidStepTransition('running', 'done')).toBe(true);
    expect(isValidStepTransition('running', 'failed')).toBe(true);
    expect(isValidStepTransition('running', 'waiting')).toBe(true);
  });
  it('should disallow done → running directly', () => {
    expect(isValidStepTransition('done', 'running')).toBe(false);
  });
  it('should allow done → pending (rewind)', () => {
    expect(isValidStepTransition('done', 'pending')).toBe(true);
  });
  it('should disallow skipped → anything', () => {
    expect(isValidStepTransition('skipped', 'pending')).toBe(false);
    expect(isValidStepTransition('skipped', 'running')).toBe(false);
  });
});

describe('isValidRunTransition', () => {
  it('should allow running → done', () => {
    expect(isValidRunTransition('running', 'done')).toBe(true);
  });
  it('should allow running → cancelled', () => {
    expect(isValidRunTransition('running', 'cancelled')).toBe(true);
  });
  it('should disallow cancelled → anything', () => {
    expect(isValidRunTransition('cancelled', 'running')).toBe(false);
  });
});

describe('type guards', () => {
  it('isStepStatus should validate step statuses', () => {
    expect(isStepStatus('done')).toBe(true);
    expect(isStepStatus('pending')).toBe(true);
    expect(isStepStatus('invalid')).toBe(false);
    expect(isStepStatus(42)).toBe(false);
  });

  it('isRunStatus should validate run statuses', () => {
    expect(isRunStatus('running')).toBe(true);
    expect(isRunStatus('cancelled')).toBe(true);
    expect(isRunStatus('bogus')).toBe(false);
  });
});
