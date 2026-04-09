import type { RunStatus, StepStatus, WorkflowRun } from './types.js';

export const STEP_STATUS_VALUES: StepStatus[] = [
  'pending',
  'running',
  'waiting',
  'done',
  'failed',
  'skipped',
];
export const RUN_STATUS_VALUES: RunStatus[] = [
  'draft',
  'running',
  'waiting',
  'done',
  'failed',
  'cancelled',
];

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === 'string' && STEP_STATUS_VALUES.includes(value as StepStatus);
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && RUN_STATUS_VALUES.includes(value as RunStatus);
}

export function deriveRunStatus<TContext>(run: WorkflowRun<TContext>): RunStatus {
  if (run.status === 'cancelled') return 'cancelled';

  const hasWaiting = run.steps.some((s) => s.status === 'waiting');
  const hasFailed = run.steps.some((s) => s.status === 'failed');
  const allDone = run.steps.every((s) => s.status === 'done' || s.status === 'skipped');

  if (hasFailed) return 'failed';
  if (hasWaiting) return 'waiting';
  if (allDone) return 'done';
  return 'running';
}

export function isValidStepTransition(from: StepStatus, to: StepStatus): boolean {
  const validTransitions: Record<StepStatus, StepStatus[]> = {
    pending: ['running', 'skipped'],
    running: ['done', 'failed', 'waiting', 'pending'],
    waiting: ['pending', 'done', 'failed'],
    done: ['pending'],
    failed: ['pending'],
    skipped: [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
  const validTransitions: Record<RunStatus, RunStatus[]> = {
    draft: ['running', 'cancelled'],
    running: ['waiting', 'done', 'failed', 'cancelled'],
    waiting: ['running', 'cancelled'],
    done: ['running'],
    failed: ['running'],
    cancelled: [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Check if a workflow status represents a terminal (final) state
 */
export function isTerminalState(status: RunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}
