/**
 * v2.6 feature suite
 *
 * Covers the five 2.6 additions end-to-end on a real Mongo:
 *   1. Typed step outputs — `ctx.outputs` proxy (runtime semantics)
 *   2. `ctx.loop` — durable agent-loop primitive (completion, crash-resume,
 *      maxIterations hard cap)
 *   3. Recurring schedules — `computeNextOccurrence` math + engine-driven
 *      next-occurrence spawn on scheduled pickup
 *   4. Payload guards — opt-in `maxPayloadBytes` hard cap on outputs and
 *      checkpoints (non-retriable), warn-only default
 *   5. (Heartbeat hardening is interval-internal; covered by the existing
 *      heartbeat-backpressure suite staying green.)
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeNextOccurrence,
  configureStreamlineLogger,
  createWorkflow,
  validateRecurrence,
  WorkflowRunModel,
} from '../../src/index.js';
import type { SchedulingInfo } from '../../src/core/types.js';
import { cleanupTestDB, setupTestDB, teardownTestDB } from '../utils/setup.js';

beforeAll(async () => {
  await setupTestDB();
  configureStreamlineLogger({ enabled: false });
});

afterAll(async () => {
  configureStreamlineLogger({ enabled: true });
  await teardownTestDB();
});

// ============================================================================
// 1. Typed step outputs — ctx.outputs
// ============================================================================

describe('v2.6: ctx.outputs typed proxy', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('resolves sibling step outputs by property access (typed when TOutputs declared)', async () => {
    interface Outputs {
      fetch: { html: string };
      parse: { items: number };
      save: { saved: boolean };
    }

    const wf = createWorkflow<Record<string, never>, unknown, Outputs>('outputs-proxy', {
      steps: {
        fetch: async () => ({ html: '<li>a</li><li>b</li>' }),
        parse: async (ctx) => {
          // Typed access — no getOutput<T>() cast needed.
          const html = ctx.outputs.fetch?.html ?? '';
          return { items: (html.match(/<li>/g) ?? []).length };
        },
        save: {
          handler: async (ctx) => ({ saved: (ctx.outputs.parse?.items ?? 0) > 0 }),
          retries: 1,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.steps.find((s) => s.stepId === 'parse')?.output).toEqual({ items: 2 });
    expect(result.steps.find((s) => s.stepId === 'save')?.output).toEqual({ saved: true });

    wf.shutdown();
  });

  it('enumerates step ids and returns undefined for unknown/incomplete steps', async () => {
    let observedKeys: string[] = [];
    let unknownValue: unknown = 'sentinel';

    const wf = createWorkflow('outputs-proxy-enum', {
      steps: {
        first: async () => ({ ok: 1 }),
        second: async (ctx) => {
          observedKeys = Object.keys(ctx.outputs);
          unknownValue = (ctx.outputs as Record<string, unknown>).nonexistent;
          return { ok: 2 };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    expect(observedKeys).toEqual(['first', 'second']);
    expect(unknownValue).toBeUndefined();

    wf.shutdown();
  });
});

// ============================================================================
// 2. ctx.loop — durable loop primitive
// ============================================================================

describe('v2.6: ctx.loop durable loop', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('runs body until done, threading state, and returns the final state', async () => {
    const iterations: number[] = [];

    const wf = createWorkflow('loop-basic', {
      steps: {
        accumulate: async (ctx) => {
          const final = await ctx.loop(
            { sum: 0 },
            async (state, i) => {
              iterations.push(i);
              return { state: { sum: state.sum + i }, done: state.sum + i >= 10 };
            },
            { maxIterations: 100 },
          );
          return { total: final.sum };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    // 0+1+2+3+4 = 10 → done at iteration 4 (five iterations: 0..4)
    expect(iterations).toEqual([0, 1, 2, 3, 4]);
    expect(result.steps[0]?.output).toEqual({ total: 10 });

    wf.shutdown();
  });

  it('resumes from the last committed iteration after a mid-loop failure (crash recovery)', async () => {
    const executed: number[] = [];
    let crashed = false;

    const wf = createWorkflow('loop-resume', {
      steps: {
        work: {
          handler: async (ctx) => {
            const final = await ctx.loop(
              { log: [] as number[] },
              async (state, i) => {
                // Simulated crash on iteration 2, first pass only — iterations
                // 0 and 1 are already durably committed by then.
                if (i === 2 && !crashed) {
                  crashed = true;
                  throw new Error('simulated crash');
                }
                executed.push(i);
                return { state: { log: [...state.log, i] }, done: i >= 3 };
              },
              { maxIterations: 10 },
            );
            return { log: final.log };
          },
          retries: 2,
          retryDelay: 10,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    let result = await wf.execute(run._id);

    // First attempt failed at iteration 2 → step scheduled for retry.
    // Drive the retry (waiting → running with retryAfter elapsed).
    if (result.status !== 'done') {
      await new Promise((r) => setTimeout(r, 50));
      result = (await wf.engine.executeRetry(run._id)) ?? result;
    }

    expect(result.status).toBe('done');
    // Iterations 0,1 ran exactly once (committed before the crash); the
    // retry resumed AT iteration 2 — not from scratch.
    expect(executed).toEqual([0, 1, 2, 3]);
    expect(result.steps[0]?.output).toEqual({ log: [0, 1, 2, 3] });

    wf.shutdown();
  });

  it('fails the step NON-retriably when maxIterations is exceeded', async () => {
    const wf = createWorkflow('loop-runaway', {
      steps: {
        spin: {
          handler: async (ctx) => {
            await ctx.loop({}, async () => ({ state: {}, done: false }), { maxIterations: 3 });
            return 'unreachable';
          },
          retries: 5,
          retryDelay: 10,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('maxIterations');
    // Non-retriable: exactly one attempt despite retries: 5.
    expect(result.steps[0]?.attempts).toBe(1);

    wf.shutdown();
  });
});

// ============================================================================
// 3. Recurring schedules
// ============================================================================

describe('v2.6: recurrence math (computeNextOccurrence)', () => {
  const base: SchedulingInfo = {
    scheduledFor: '2026-06-10T09:00:00',
    timezone: 'UTC',
    localTimeDisplay: '2026-06-10 09:00:00 UTC',
    executionTime: new Date('2026-06-10T09:00:00Z'),
    isDSTTransition: false,
  };
  const now = new Date('2026-06-10T09:00:05Z');

  it('daily advances one day at the same local time', () => {
    const next = computeNextOccurrence({ ...base, recurrence: { pattern: 'daily' } }, now);
    expect(next?.executionTime.toISOString()).toBe('2026-06-11T09:00:00.000Z');
    expect(next?.recurrence?.occurrences).toBe(2);
  });

  it('skips missed occurrences instead of catching up', () => {
    // Engine was down for ~3 days; next firing is the first FUTURE one.
    const lateNow = new Date('2026-06-13T11:00:00Z');
    const next = computeNextOccurrence({ ...base, recurrence: { pattern: 'daily' } }, lateNow);
    expect(next?.executionTime.toISOString()).toBe('2026-06-14T09:00:00.000Z');
  });

  it('weekly honors daysOfWeek (0=Sunday)', () => {
    // 2026-06-10 is a Wednesday; next of [1 (Mon), 5 (Fri)] is Friday the 12th.
    const next = computeNextOccurrence(
      { ...base, recurrence: { pattern: 'weekly', daysOfWeek: [1, 5] } },
      now,
    );
    expect(next?.executionTime.toISOString()).toBe('2026-06-12T09:00:00.000Z');
  });

  it('monthly clamps dayOfMonth to short months', () => {
    const jan31: SchedulingInfo = {
      ...base,
      scheduledFor: '2026-01-31T09:00:00',
      executionTime: new Date('2026-01-31T09:00:00Z'),
    };
    const next = computeNextOccurrence(
      { ...jan31, recurrence: { pattern: 'monthly', dayOfMonth: 31 } },
      new Date('2026-01-31T09:00:05Z'),
    );
    // February 2026 has 28 days.
    expect(next?.executionTime.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });

  it('custom cron evaluates in the schedule timezone', () => {
    const next = computeNextOccurrence(
      {
        ...base,
        timezone: 'America/New_York',
        recurrence: { pattern: 'custom', cronExpression: '0 9 * * 1' }, // Mondays 9am ET
      },
      now,
    );
    // Next Monday after Wed 2026-06-10 is 2026-06-15; 9am EDT = 13:00 UTC.
    expect(next?.executionTime.toISOString()).toBe('2026-06-15T13:00:00.000Z');
  });

  it('stops at count and until boundaries', () => {
    expect(
      computeNextOccurrence({ ...base, recurrence: { pattern: 'daily', count: 1 } }, now),
    ).toBeNull();
    expect(
      computeNextOccurrence(
        { ...base, recurrence: { pattern: 'daily', occurrences: 3, count: 3 } },
        now,
      ),
    ).toBeNull();
    expect(
      computeNextOccurrence(
        { ...base, recurrence: { pattern: 'daily', until: new Date('2026-06-10T12:00:00Z') } },
        now,
      ),
    ).toBeNull();
  });

  it('validateRecurrence rejects malformed patterns loudly', () => {
    expect(() => validateRecurrence({ pattern: 'custom' })).toThrow(/cronExpression/);
    expect(() =>
      validateRecurrence({ pattern: 'custom', cronExpression: 'not a cron' }),
    ).toThrow(/Invalid recurrence.cronExpression/);
    expect(() => validateRecurrence({ pattern: 'weekly', daysOfWeek: [9] })).toThrow(/daysOfWeek/);
    expect(() => validateRecurrence({ pattern: 'monthly', dayOfMonth: 0 })).toThrow(/dayOfMonth/);
    expect(() => validateRecurrence({ pattern: 'daily', count: 0 })).toThrow(/count/);
    expect(() => validateRecurrence({ pattern: 'daily' })).not.toThrow();
  });
});

describe('v2.6: engine drives recurring schedules', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('spawns the next occurrence as an idempotency-keyed draft on scheduled pickup', async () => {
    let runs = 0;

    const wf = createWorkflow('recurring-job', {
      steps: {
        tick: async () => {
          runs += 1;
          return { ran: runs };
        },
      },
      autoExecute: false,
    });

    // Create a scheduled draft, then stamp a recurrence + past fire time
    // (simulating a SchedulingService-created recurring run that is now due).
    const draft = await wf.engine.start(
      { job: 'nightly' },
      { scheduledExecutionTime: new Date(Date.now() + 60_000) },
    );
    await WorkflowRunModel.updateOne(
      { _id: draft._id },
      {
        $set: {
          'scheduling.scheduledFor': '2026-06-10T03:00:00',
          'scheduling.timezone': 'UTC',
          'scheduling.executionTime': new Date(Date.now() - 1_000),
          'scheduling.recurrence': { pattern: 'daily', occurrences: 1 },
        },
      },
    );

    const result = await wf.engine.executeRetry(draft._id);

    expect(result?.status).toBe('done');
    expect(runs).toBe(1);

    // Exactly one NEXT occurrence queued, advanced a day, dedup-keyed.
    const next = await WorkflowRunModel.find({
      workflowId: 'recurring-job',
      status: 'draft',
    }).lean();
    expect(next).toHaveLength(1);
    expect(next[0]!.scheduling?.recurrence?.occurrences).toBe(2);
    expect(next[0]!.scheduling!.executionTime.getTime()).toBeGreaterThan(Date.now());
    expect(next[0]!.idempotencyKey).toMatch(/^recurring-job:recur:/);
    expect(next[0]!.input).toEqual({ job: 'nightly' });

    wf.shutdown();
  });

  it('does NOT spawn a next occurrence once count is exhausted', async () => {
    const wf = createWorkflow('recurring-finite', {
      steps: { tick: async () => 'ok' },
      autoExecute: false,
    });

    const draft = await wf.engine.start({}, { scheduledExecutionTime: new Date(Date.now() + 60_000) });
    await WorkflowRunModel.updateOne(
      { _id: draft._id },
      {
        $set: {
          'scheduling.scheduledFor': '2026-06-10T03:00:00',
          'scheduling.timezone': 'UTC',
          'scheduling.executionTime': new Date(Date.now() - 1_000),
          'scheduling.recurrence': { pattern: 'daily', count: 2, occurrences: 2 },
        },
      },
    );

    const result = await wf.engine.executeRetry(draft._id);
    expect(result?.status).toBe('done');

    const drafts = await WorkflowRunModel.find({
      workflowId: 'recurring-finite',
      status: 'draft',
    }).lean();
    expect(drafts).toHaveLength(0);

    wf.shutdown();
  });
});

// ============================================================================
// 4. Step middleware (observability seam)
// ============================================================================

describe('v2.6: step middleware', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('fires beforeStep/afterStep in order with output + durationMs', async () => {
    const calls: string[] = [];
    let observedOutput: unknown;
    let observedDuration: number | undefined;

    const wf = createWorkflow('mw-basic', {
      steps: {
        one: async () => ({ ok: 1 }),
        two: async () => ({ ok: 2 }),
      },
      middleware: [
        {
          name: 'recorder',
          beforeStep: ({ stepId }) => void calls.push(`before:${stepId}`),
          afterStep: ({ stepId, output, durationMs }) => {
            calls.push(`after:${stepId}`);
            if (stepId === 'two') {
              observedOutput = output;
              observedDuration = durationMs;
            }
          },
        },
        // Second middleware proves chain ordering.
        { name: 'second', beforeStep: ({ stepId }) => void calls.push(`before2:${stepId}`) },
      ],
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(calls).toEqual([
      'before:one',
      'before2:one',
      'after:one',
      'before:two',
      'before2:two',
      'after:two',
    ]);
    expect(observedOutput).toEqual({ ok: 2 });
    expect(typeof observedDuration).toBe('number');

    wf.shutdown();
  });

  it('fires onStepError for failures and onWait for suspensions', async () => {
    const events: string[] = [];

    const wf = createWorkflow('mw-error-wait', {
      steps: {
        gate: async (ctx) => {
          if (!(ctx.context as Record<string, unknown>).resumed) {
            return ctx.wait('needs approval');
          }
          return { gated: true };
        },
        boom: {
          handler: async () => {
            throw new Error('kaboom');
          },
          retries: 1,
        },
      },
      middleware: [
        {
          onWait: ({ stepId, waitType, reason }) =>
            void events.push(`wait:${stepId}:${waitType}:${reason}`),
          onStepError: ({ stepId, error }) => void events.push(`error:${stepId}:${error.message}`),
        },
      ],
      autoExecute: false,
    });

    const run = await wf.start({});
    let result = await wf.execute(run._id);
    expect(result.status).toBe('waiting');
    expect(events).toContain('wait:gate:human:needs approval');

    result = await wf.resume(run._id, { approved: true });
    expect(result.status).toBe('failed');
    expect(events).toContain('error:boom:kaboom');

    wf.shutdown();
  });

  it('swallows middleware errors — a throwing hook cannot fail the step', async () => {
    const wf = createWorkflow('mw-swallow', {
      steps: { fine: async () => 'ok' },
      middleware: [
        {
          name: 'broken',
          beforeStep: () => {
            throw new Error('middleware bug');
          },
          afterStep: async () => {
            throw new Error('async middleware bug');
          },
        },
      ],
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.steps[0]?.output).toBe('ok');

    wf.shutdown();
  });
});

// ============================================================================
// 5. ctx.stream — non-durable frames
// ============================================================================

describe('v2.6: ctx.stream', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('emits step:stream frames on the container bus with monotonic seq', async () => {
    const frames: Array<{ seq: number; frame: unknown; stepId: string }> = [];

    const wf = createWorkflow('stream-frames', {
      steps: {
        speak: async (ctx) => {
          ctx.stream({ token: 'frame-a' });
          ctx.stream({ token: 'frame-b' });
          ctx.stream({ token: 'frame-c' });
          return 'spoken';
        },
      },
      autoExecute: false,
    });

    wf.container.eventBus.on('step:stream', (p) => {
      frames.push({ seq: p.seq, frame: p.frame, stepId: p.stepId });
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(frames.map((f) => (f.frame as { token: string }).token)).toEqual([
      'frame-a',
      'frame-b',
      'frame-c',
    ]);
    expect(frames.every((f) => f.stepId === 'speak')).toBe(true);

    // Non-durable contract: nothing about the frames lands on the run doc.
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(JSON.stringify(doc)).not.toContain('frame-a');

    wf.shutdown();
  });
});

// ============================================================================
// 6. Abort semantics for the new primitives (AI-SDK-style discipline:
//    abort is NOT an error — frames drop, loops stop, no failed-state write)
// ============================================================================

describe('v2.6: abort semantics', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('cancel mid-loop stops iterations and leaves the run cancelled (not failed)', async () => {
    let iterations = 0;

    const wf = createWorkflow('loop-cancel', {
      steps: {
        spin: async (ctx) => {
          await ctx.loop(
            {},
            async () => {
              iterations += 1;
              await new Promise((r) => setTimeout(r, 30));
              return { state: {}, done: false };
            },
            { maxIterations: 1000 },
          );
          return 'unreachable';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    // Let a few iterations commit, then cancel.
    await new Promise((r) => setTimeout(r, 100));
    const cancelled = await wf.cancel(run._id);
    expect(cancelled.status).toBe('cancelled');

    await execPromise;
    const countAtCancel = iterations;

    // No zombie loop: iteration counter must stop advancing after cancel.
    await new Promise((r) => setTimeout(r, 150));
    expect(iterations).toBe(countAtCancel);

    // Abort is not a failure: final status stays cancelled, no failed write.
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.status).toBe('cancelled');

    wf.shutdown();
  });

  it('ctx.stream frames emitted after cancellation are dropped silently', async () => {
    const frames: number[] = [];
    let resumeAfterAbort: (() => void) | undefined;

    const wf = createWorkflow('stream-abort', {
      steps: {
        speak: async (ctx) => {
          ctx.stream({ token: 'pre-cancel' }); // seq 0 — delivered
          // Park until the abort signal fires, then try to stream again.
          await new Promise<void>((resolve) => {
            resumeAfterAbort = resolve;
            ctx.signal.addEventListener('abort', () => resolve());
          });
          ctx.stream({ token: 'post-cancel' }); // dropped, no throw
          return 'done-anyway';
        },
      },
      autoExecute: false,
    });

    wf.container.eventBus.on('step:stream', (p) => frames.push(p.seq));

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    await new Promise((r) => setTimeout(r, 50));
    await wf.cancel(run._id);
    resumeAfterAbort?.();
    await execPromise;

    // Only the pre-cancel frame arrived; the post-cancel one was dropped
    // without erroring the handler (abort ≠ error).
    expect(frames).toEqual([0]);

    wf.shutdown();
  });

  it('loop resumes exactly from committed state when cancel beats a checkpoint', async () => {
    // Sibling guarantee to crash-resume: checkpoint() refuses writes once
    // aborted, so a cancelled run can never commit a torn iteration.
    let observedCheckpointAfterCancel: unknown = 'not-read';

    const wf = createWorkflow('loop-cancel-checkpoint', {
      steps: {
        spin: async (ctx) => {
          await ctx.loop(
            { n: 0 },
            async (state) => {
              if (state.n >= 2) {
                // Cancel arrives while this iteration is in flight.
                await new Promise((r) => setTimeout(r, 120));
              }
              return { state: { n: state.n + 1 }, done: false };
            },
            { maxIterations: 10 },
          );
          return 'unreachable';
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    await wf.cancel(run._id);
    await execPromise;

    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.status).toBe('cancelled');
    // The persisted checkpoint reflects only COMMITTED iterations (n=2 from
    // iterations 0+1) — the in-flight third iteration never wrote.
    const output = doc!.steps[0]?.output as
      | { __checkpoint?: { state?: { n: number } } }
      | undefined;
    observedCheckpointAfterCancel = output?.__checkpoint?.state?.n;
    expect(observedCheckpointAfterCancel).toBe(2);

    wf.shutdown();
  });
});

// ============================================================================
// 7. Payload guards
// ============================================================================

describe('v2.6: payload size guards', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('fails a step NON-retriably when output exceeds maxPayloadBytes', async () => {
    const wf = createWorkflow('payload-cap-output', {
      steps: {
        big: {
          handler: async () => ({ blob: 'x'.repeat(5_000) }),
          retries: 5,
          retryDelay: 10,
        },
      },
      maxPayloadBytes: 1_000,
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('maxPayloadBytes');
    expect(result.steps[0]?.attempts).toBe(1); // non-retriable

    wf.shutdown();
  });

  it('fails a step NON-retriably when a checkpoint exceeds maxPayloadBytes', async () => {
    const wf = createWorkflow('payload-cap-checkpoint', {
      steps: {
        big: {
          handler: async (ctx) => {
            await ctx.checkpoint({ blob: 'x'.repeat(5_000) });
            return 'unreachable';
          },
          retries: 5,
          retryDelay: 10,
        },
      },
      maxPayloadBytes: 1_000,
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('maxPayloadBytes');
    expect(result.steps[0]?.attempts).toBe(1);

    wf.shutdown();
  });

  it('default is warn-only: large outputs still succeed without a configured cap', async () => {
    const wf = createWorkflow('payload-warn-only', {
      steps: {
        big: async () => ({ blob: 'x'.repeat(2_000_000) }), // > 1MB warn threshold
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');

    wf.shutdown();
  });
});
