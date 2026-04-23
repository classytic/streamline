/**
 * Fixture builders — value factories for tests.
 *
 * Rule: every builder takes `Partial<T>` overrides. Never hard-code ids,
 * workflow ids, or tenant ids — collisions will make parallel tests flaky.
 */

import type { StepState, WorkflowRun } from '../../src/core/types.js';

let runCounter = 0;

function uniq(prefix: string): string {
  runCounter += 1;
  return `${prefix}-${Date.now()}-${runCounter}`;
}

/**
 * Build an in-memory WorkflowRun for unit tests that don't touch the DB.
 * Overrides merge shallowly.
 */
export function makeWorkflowRun<TContext = unknown>(
  overrides: Partial<WorkflowRun<TContext>> = {},
): WorkflowRun<TContext> {
  const now = new Date();
  return {
    _id: overrides._id ?? uniq('run'),
    workflowId: overrides.workflowId ?? uniq('wf'),
    status: overrides.status ?? 'running',
    steps: overrides.steps ?? [],
    currentStepId: overrides.currentStepId ?? null,
    context: overrides.context ?? ({} as TContext),
    input: overrides.input ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  } as WorkflowRun<TContext>;
}

/**
 * Build a StepState fixture.
 */
export function makeStepState(overrides: Partial<StepState> = {}): StepState {
  return {
    stepId: overrides.stepId ?? uniq('step'),
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    ...overrides,
  } as StepState;
}

/**
 * Generate a unique workflow id suitable for a single test's scope.
 * Use this over hard-coding 'test-workflow' so parallel tests don't collide.
 */
export function uniqueWorkflowId(prefix = 'wf'): string {
  return uniq(prefix);
}

/**
 * Generate a unique tenant id for multi-tenant isolation tests.
 */
export function uniqueTenantId(prefix = 'tenant'): string {
  return uniq(prefix);
}
