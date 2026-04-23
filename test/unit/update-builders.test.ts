/**
 * Unit tests for the update-builders module.
 *
 * These helpers sit directly underneath `WorkflowRunRepository.updateOne()`
 * — if they regress, every write path regresses with them. The most
 * important guarantee is that `normalizeUpdate` catches mixed
 * operator-and-field shapes (the single most frequent update-path bug before
 * the helper landed).
 */

import { describe, expect, it } from 'vitest';
import {
  applyStepUpdates,
  buildStepUpdateOps,
  normalizeUpdate,
  runSet,
  runSetUnset,
  toPlainRun,
} from '../../src/storage/update-builders.js';
import type { StepState, WorkflowRun } from '../../src/core/types.js';

describe('normalizeUpdate', () => {
  it('passes an all-operator update through unchanged', () => {
    const input = { $set: { status: 'done' }, $unset: { waitingFor: '' as const } };
    expect(normalizeUpdate(input)).toBe(input);
  });

  it('wraps a plain field-shape object in $set', () => {
    expect(normalizeUpdate({ status: 'waiting', updatedAt: new Date(0) })).toEqual({
      $set: { status: 'waiting', updatedAt: new Date(0) },
    });
  });

  it('throws on mixed operators + fields — the silent-drop footgun', () => {
    expect(() =>
      normalizeUpdate({
        $set: { status: 'done' },
        status: 'waiting', // would be silently dropped by Mongo
      }),
    ).toThrowError(/cannot mix operators.*raw field keys/);
  });

  it('names both the offending operators and fields in the error', () => {
    let caught: Error | undefined;
    try {
      normalizeUpdate({ $inc: { retries: 1 }, otherField: 42, $set: {} });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain('$inc');
    expect(caught?.message).toContain('$set');
    expect(caught?.message).toContain('otherField');
  });

  it('treats an empty object as a no-op (callers filter this before firing)', () => {
    expect(normalizeUpdate({})).toEqual({});
  });
});

describe('runSet', () => {
  it('wraps the patch in $set and stamps updatedAt', () => {
    const before = Date.now();
    const out = runSet({ status: 'running' });
    const after = Date.now();

    expect(out.$set?.status).toBe('running');
    expect(out.$set?.updatedAt).toBeInstanceOf(Date);
    expect((out.$set?.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((out.$set?.updatedAt as Date).getTime()).toBeLessThanOrEqual(after);
  });

  it('preserves caller-supplied keys alongside updatedAt', () => {
    const now = new Date();
    const out = runSet({ status: 'running', lastHeartbeat: now, startedAt: now });
    expect(out.$set).toMatchObject({
      status: 'running',
      lastHeartbeat: now,
      startedAt: now,
    });
  });

  it('always produces only $set (no accidental $unset leak)', () => {
    const out = runSet({ status: 'running' });
    expect(Object.keys(out)).toEqual(['$set']);
  });
});

describe('runSetUnset', () => {
  it('emits $set with updatedAt AND $unset with "" sentinels', () => {
    const out = runSetUnset({ status: 'waiting' }, ['error', 'waitingFor']);
    expect(out.$set?.status).toBe('waiting');
    expect(out.$set?.updatedAt).toBeInstanceOf(Date);
    expect(out.$unset).toEqual({ error: '', waitingFor: '' });
  });

  it('handles an empty unset list without emitting garbage', () => {
    const out = runSetUnset({ status: 'done' }, []);
    expect(out.$set?.status).toBe('done');
    expect(out.$unset).toEqual({});
  });
});

describe('buildStepUpdateOps', () => {
  it('maps defined values into $set with dotted paths', () => {
    const out = buildStepUpdateOps(2, {
      status: 'done',
      output: { ok: true },
    });
    expect(out.$set['steps.2.status']).toBe('done');
    expect(out.$set['steps.2.output']).toEqual({ ok: true });
    expect(out.$set.updatedAt).toBeInstanceOf(Date);
  });

  it('routes undefined values into $unset (Mongo delete)', () => {
    const out = buildStepUpdateOps(0, {
      status: 'pending',
      error: undefined,
      waitingFor: undefined,
    });
    expect(out.$set['steps.0.status']).toBe('pending');
    expect(out.$unset['steps.0.error']).toBe('');
    expect(out.$unset['steps.0.waitingFor']).toBe('');
  });

  it('includes workflow-level status when `includeStatus` is passed', () => {
    const out = buildStepUpdateOps(0, { status: 'done' }, { includeStatus: 'running' });
    expect(out.$set.status).toBe('running');
  });

  it('omits updatedAt when `includeUpdatedAt: false`', () => {
    const out = buildStepUpdateOps(0, { status: 'done' }, { includeUpdatedAt: false });
    expect(out.$set.updatedAt).toBeUndefined();
  });
});

describe('applyStepUpdates', () => {
  it('updates only the matching stepId, leaves siblings untouched', () => {
    const steps: StepState[] = [
      { stepId: 'a', status: 'done', attempts: 1 },
      { stepId: 'b', status: 'pending', attempts: 0 },
    ];
    const out = applyStepUpdates('b', steps, { status: 'running' });
    expect(out[0]).toBe(steps[0]); // untouched reference
    expect(out[1].status).toBe('running');
  });

  it('mirrors $unset by deleting undefined fields', () => {
    const steps: StepState[] = [
      { stepId: 'a', status: 'running', attempts: 1, error: { message: 'x' } },
    ];
    const out = applyStepUpdates('a', steps, { error: undefined });
    expect(out[0].error).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out[0], 'error')).toBe(false);
  });
});

describe('toPlainRun', () => {
  it('returns plain runs unchanged', () => {
    const run = { _id: 'r1', context: { foo: 1 } } as unknown as WorkflowRun;
    expect(toPlainRun(run)).toBe(run);
  });

  it('unwraps a Mongoose-style doc via toObject()', () => {
    const plain = { _id: 'r1', context: { foo: 1 } } as unknown as WorkflowRun;
    const doc = { toObject: () => plain, context: { foo: 1 } };
    expect(toPlainRun(doc as never)).toBe(plain);
  });

  it('restores context if Mongoose dropped it for an empty object', () => {
    const doc = {
      toObject: () => ({ _id: 'r1', context: undefined }) as unknown as WorkflowRun,
      context: { foo: 1 },
    };
    const out = toPlainRun(doc as never);
    expect(out.context).toEqual({ foo: 1 });
  });
});
