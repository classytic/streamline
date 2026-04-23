/**
 * Domain-specific matchers with good failure messages.
 *
 * Prefer these over bare `expect(run.status).toBe('done')` — they provide
 * the full run context in the failure output, which makes async debugging
 * tractable.
 */

import { expect } from 'vitest';
import type { RunStatus, StepStatus, WorkflowRun } from '../../src/core/types.js';

function summarize(run: WorkflowRun | null | undefined): string {
  if (!run) return '<null>';
  const steps = run.steps.map((s) => `${s.stepId}=${s.status}`).join(',');
  return `run=${run._id} status=${run.status} steps=[${steps}] paused=${run.paused ?? false}`;
}

export function expectRunStatus(run: WorkflowRun | null | undefined, expected: RunStatus): void {
  if (!run) {
    throw new Error(`expected run with status '${expected}' but run was ${run}`);
  }
  if (run.status !== expected) {
    throw new Error(
      `expected status '${expected}' but got '${run.status}' — ${summarize(run)}`,
    );
  }
}

export function expectStepStatus(
  run: WorkflowRun,
  stepId: string,
  expected: StepStatus,
): void {
  const step = run.steps.find((s) => s.stepId === stepId);
  if (!step) {
    throw new Error(
      `step '${stepId}' not found — existing: ${run.steps.map((s) => s.stepId).join(',')}`,
    );
  }
  if (step.status !== expected) {
    throw new Error(
      `step '${stepId}' expected '${expected}' but got '${step.status}' — ${summarize(run)}`,
    );
  }
}

/**
 * Assert the steps ran in the given order (completed steps only).
 * Ignores `skipped` and `pending` entries.
 */
export function expectStepSequence(run: WorkflowRun, sequence: string[]): void {
  const completed = run.steps
    .filter((s) => s.status === 'done')
    .map((s) => s.stepId);
  expect(completed).toEqual(sequence);
}

/**
 * Assert the run finished successfully and returned the expected context shape.
 */
export function expectDone<T extends object>(
  run: WorkflowRun<T> | null | undefined,
  contextSubset?: Partial<T>,
): void {
  expectRunStatus(run, 'done');
  if (contextSubset && run) {
    expect(run.context).toMatchObject(contextSubset);
  }
}
