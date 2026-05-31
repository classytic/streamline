import { describe, expect, it } from 'vitest';
import { StepContextImpl } from '../../src/execution/context.js';
import type { WorkflowEventBus } from '../../src/core/events.js';
import type { WorkflowRun } from '../../src/core/types.js';
import type { WorkflowRunRepository } from '../../src/storage/run.repository.js';

/**
 * `ctx.idempotencyKey()` is a pure, attempt-invariant primitive — it only
 * reads runId + stepId, so we construct the context with minimal stubs for
 * the I/O collaborators (they are never touched by this method).
 */
function makeCtx(runId: string, stepId: string, attempt: number): StepContextImpl {
  const run = { _id: runId, steps: [] } as unknown as WorkflowRun;
  return new StepContextImpl(
    runId,
    stepId,
    {},
    undefined,
    attempt,
    run,
    {} as unknown as WorkflowRunRepository,
    {} as unknown as WorkflowEventBus,
  );
}

describe('ctx.idempotencyKey', () => {
  it('returns `${runId}:${stepId}` with no scope', () => {
    expect(makeCtx('run-1', 'charge', 0).idempotencyKey()).toBe('run-1:charge');
  });

  it('appends the scope when provided', () => {
    const ctx = makeCtx('run-1', 'settle', 0);
    expect(ctx.idempotencyKey('charge')).toBe('run-1:settle:charge');
    expect(ctx.idempotencyKey('refund')).toBe('run-1:settle:refund');
  });

  it('is ATTEMPT-INVARIANT — identical across retries (the whole point)', () => {
    const first = makeCtx('run-1', 'charge', 0).idempotencyKey('pay');
    const retry = makeCtx('run-1', 'charge', 5).idempotencyKey('pay');
    expect(retry).toBe(first); // a retried step must reuse the SAME key
  });

  it('is distinct per run, per step, and per scope', () => {
    expect(makeCtx('run-1', 'charge', 0).idempotencyKey()).not.toBe(
      makeCtx('run-2', 'charge', 0).idempotencyKey(),
    );
    expect(makeCtx('run-1', 'charge', 0).idempotencyKey()).not.toBe(
      makeCtx('run-1', 'ship', 0).idempotencyKey(),
    );
    expect(makeCtx('run-1', 'charge', 0).idempotencyKey('a')).not.toBe(
      makeCtx('run-1', 'charge', 0).idempotencyKey('b'),
    );
  });
});
