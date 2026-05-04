/**
 * Workflow + step status state machines.
 *
 * Pre-v2.3 this file shipped two transition-validator functions
 * (`isValidStepTransition`, `isValidRunTransition`) that were defined
 * but never called — pure dead code. v2.3 replaces them with
 * `defineStateMachine()` from `@classytic/primitives/state-machine` AND
 * wires the engine's atomic claim sites through `assertAndClaim()` so
 * illegal transitions throw before they reach the database, paired with
 * the existing `claim()` runtime CAS.
 *
 * Two layers, both load-bearing:
 *
 *   - **`*_MACHINE.assertTransition(id, from, to)`** — sync, in-memory,
 *     no I/O. Catches programmer bugs (wrong target status, illegal
 *     transition the model doesn't support).
 *   - **`repo.claim(id, { from, to, ... })`** — atomic Mongo CAS.
 *     Catches concurrent writers (returns `null` on race-loss).
 *
 * Skipping either layer leaves a hole: skip the assert and bad
 * transitions reach storage; skip claim and concurrent writers race.
 * Use `assertAndClaim` from primitives to compose both in one call.
 */

import { defineStateMachine } from '@classytic/primitives/state-machine';
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

/**
 * Step state machine — declarative replacement for the dead-code
 * `isValidStepTransition` function. The transition table is identical
 * to the pre-v2.3 validator (preserves existing semantics), but is now
 * load-bearing because the executor uses `STEP_MACHINE.assertTransition`
 * before status writes.
 *
 * Terminal: `skipped` (no further transitions).
 *
 * Notable shapes:
 *   - `pending → running | skipped` — the executor picks up a pending
 *     step or the workflow chooses to skip it.
 *   - `running → done | failed | waiting | pending` — running can fall
 *     back to pending (retry path) and re-enter the loop.
 *   - `waiting → pending | done | failed` — resumes either by retry
 *     (pending) or directly to terminal.
 *   - `done | failed → pending` — rewind support; explicit replay.
 */
export const STEP_MACHINE = defineStateMachine<StepStatus>({
  name: 'WorkflowStep',
  transitions: {
    pending: ['running', 'skipped'],
    running: ['done', 'failed', 'waiting', 'pending'],
    waiting: ['pending', 'done', 'failed'],
    done: ['pending'],
    failed: ['pending'],
    skipped: [],
  },
});

/**
 * Workflow run state machine — declarative replacement for the dead-code
 * `isValidRunTransition` function. The transition table is identical
 * to the pre-v2.3 validator. The engine's atomic claim sites use
 * `assertAndClaim(RUN_MACHINE, repo, runId, { from, to, ... })` so the
 * domain validation runs sync before the Mongo CAS.
 *
 * Terminal: `cancelled` (no further transitions).
 *
 * `done | failed → running` allows rewind/retry for completed runs.
 */
export const RUN_MACHINE = defineStateMachine<RunStatus>({
  name: 'WorkflowRun',
  transitions: {
    draft: ['running', 'cancelled'],
    running: ['waiting', 'done', 'failed', 'cancelled'],
    waiting: ['running', 'cancelled'],
    done: ['running'],
    failed: ['running'],
    cancelled: [],
  },
});

/**
 * Back-compat shim for the legacy `isValidStepTransition(from, to)`
 * function. Delegates to the new `STEP_MACHINE.canTransition` — same
 * semantics, no `IllegalTransitionError` throw.
 *
 * @deprecated Use `STEP_MACHINE.canTransition(from, to)` directly, or
 *   `STEP_MACHINE.assertTransition(id, from, to)` to throw on illegal
 *   transitions. Removed in v3.
 */
export function isValidStepTransition(from: StepStatus, to: StepStatus): boolean {
  return STEP_MACHINE.canTransition(from, to);
}

/**
 * Back-compat shim for the legacy `isValidRunTransition(from, to)`.
 *
 * @deprecated Use `RUN_MACHINE.canTransition(from, to)` directly, or
 *   `RUN_MACHINE.assertTransition(id, from, to)` to throw on illegal
 *   transitions. Removed in v3.
 */
export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_MACHINE.canTransition(from, to);
}

/**
 * Check if a workflow status represents a terminal (final) state.
 *
 * **Domain semantic, distinct from `RUN_MACHINE.isTerminal()`.** The state
 * machine allows `done → running` and `failed → running` for rewind
 * support, so structurally only `cancelled` is terminal. But the
 * streamline lifecycle treats all three (done/failed/cancelled) as
 * "complete" — the run is no longer active, the engine stops the
 * execution loop, scheduler ignores it. This helper preserves that
 * domain semantic; consumers that want the structural-terminal check
 * (only states with no outgoing transitions) can call
 * `RUN_MACHINE.isTerminal(status)` directly.
 */
export function isTerminalState(status: RunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}
