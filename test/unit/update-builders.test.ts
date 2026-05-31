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

// ===========================================================================
// Output-history ring buffer (opt-in) — buildStepUpdateOps + applyStepUpdates
// must produce/replicate the SAME $push + $slice:-keep shape (invariant #1).
// ===========================================================================

describe('buildStepUpdateOps — output-history $push', () => {
  it('emits a $push with $each + $slice:-keep when historyPush is supplied', () => {
    const at = new Date(0);
    const out = buildStepUpdateOps(
      1,
      { status: 'done', output: { gen: 2 } },
      { historyPush: { version: { version: 1, output: { gen: 1 }, at, attempt: 1 }, keep: 3 } },
    );
    expect(out.$set['steps.1.output']).toEqual({ gen: 2 });
    expect(out.$push).toEqual({
      'steps.1.outputHistory': {
        $each: [{ version: 1, output: { gen: 1 }, at, attempt: 1 }],
        $slice: -3,
      },
    });
  });

  it('does NOT emit $push when no historyPush is supplied (disabled = unchanged)', () => {
    const out = buildStepUpdateOps(0, { status: 'done', output: { ok: true } });
    expect(out.$push).toBeUndefined();
    expect(Object.keys(out)).toEqual(['$set', '$unset']);
  });

  it('does NOT emit $push when keep is 0', () => {
    const out = buildStepUpdateOps(
      0,
      { status: 'done' },
      { historyPush: { version: { version: 1, output: 1, at: new Date(0) }, keep: 0 } },
    );
    expect(out.$push).toBeUndefined();
  });
});

describe('applyStepUpdates — output-history ring mirror', () => {
  it('appends a version, leaving the in-memory mirror matching the DB push', () => {
    const steps: StepState[] = [{ stepId: 'a', status: 'done', attempts: 1, output: { gen: 2 } }];
    const v = { version: 1, output: { gen: 1 }, at: new Date(0), attempt: 1 };
    const out = applyStepUpdates('a', steps, { status: 'done', output: { gen: 2 } }, { version: v, keep: 3 });
    expect(out[0].outputHistory).toEqual([v]);
  });

  it('evicts the OLDEST entry once length exceeds keep (slice -keep, trim front)', () => {
    const existing = [
      { version: 1, output: 'a', at: new Date(0), attempt: 1 },
      { version: 2, output: 'b', at: new Date(1), attempt: 2 },
    ];
    const steps: StepState[] = [
      { stepId: 'a', status: 'done', attempts: 3, output: 'c', outputHistory: [...existing] },
    ];
    const v3 = { version: 3, output: 'c', at: new Date(2), attempt: 3 };
    const out = applyStepUpdates('a', steps, { status: 'done' }, { version: v3, keep: 2 });
    // keep=2 → oldest (version 1) evicted, newest two remain in order.
    expect(out[0].outputHistory?.map((h) => h.version)).toEqual([2, 3]);
  });

  it('writes nothing to outputHistory when historyPush is absent (disabled)', () => {
    const steps: StepState[] = [{ stepId: 'a', status: 'done', attempts: 1, output: 'x' }];
    const out = applyStepUpdates('a', steps, { status: 'done', output: 'y' });
    expect(out[0].outputHistory).toBeUndefined();
  });

  it('starts a fresh buffer when none exists', () => {
    const steps: StepState[] = [{ stepId: 'a', status: 'done', attempts: 1, output: 'b' }];
    const v = { version: 1, output: 'a', at: new Date(0), attempt: 1 };
    const out = applyStepUpdates('a', steps, { status: 'done' }, { version: v, keep: 5 });
    expect(out[0].outputHistory).toEqual([v]);
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
