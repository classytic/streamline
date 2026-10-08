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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SchedulingInfo } from '../../src/core/types.js';
import {
  computeNextOccurrence,
  configureStreamlineLogger,
  validateRecurrence,
} from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

beforeAll(() => {
  configureStreamlineLogger({ enabled: false });
});

afterAll(() => {
  configureStreamlineLogger({ enabled: true });
});

/** The loop checkpoint `ctx.loop` persists on the step's output. */
const checkpointN = (output: unknown) =>
  (output as { __checkpoint?: { state?: { n: number } } } | undefined)?.__checkpoint?.state?.n;

// ============================================================================
// 1. Typed step outputs — ctx.outputs
// ============================================================================

describe('v2.6: ctx.outputs typed proxy', () => {
  it('resolves sibling step outputs by property access (typed when TOutputs declared)', async () => {
    interface Outputs {
      fetch: { html: string };
      parse: { items: number };
      save: { saved: boolean };
    }

    const wf = env.workflow<Record<string, never>, unknown, Outputs>('outputs-proxy', {
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
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.steps.find((s) => s.stepId === 'parse')?.output).toEqual({ items: 2 });
    expect(result.steps.find((s) => s.stepId === 'save')?.output).toEqual({ saved: true });
  });

  it('enumerates step ids and returns undefined for unknown/incomplete steps', async () => {
    let observedKeys: string[] = [];
    let unknownValue: unknown = 'sentinel';

    const wf = env.workflow('outputs-proxy-enum', {
      steps: {
        first: async () => ({ ok: 1 }),
        second: async (ctx) => {
          observedKeys = Object.keys(ctx.outputs);
          unknownValue = (ctx.outputs as Record<string, unknown>).nonexistent;
          return { ok: 2 };
        },
      },
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    expect(observedKeys).toEqual(['first', 'second']);
    expect(unknownValue).toBeUndefined();
  });
});

// ============================================================================
// 2. ctx.loop — durable loop primitive
// ============================================================================

describe('v2.6: ctx.loop durable loop', () => {
  it('runs body until done, threading state, and returns the final state', async () => {
    const iterations: number[] = [];

    const wf = env.workflow('loop-basic', {
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
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    // 0+1+2+3+4 = 10 → done at iteration 4 (five iterations: 0..4)
    expect(iterations).toEqual([0, 1, 2, 3, 4]);
    expect(result.steps[0]?.output).toEqual({ total: 10 });
  });

  it('resumes from the last committed iteration after a mid-loop failure (crash recovery)', async () => {
    const executed: number[] = [];
    let crashed = false;

    const wf = env.workflow('loop-resume', {
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
    });

    const run = await wf.start({});
    let result = await wf.execute(run._id);

    // First attempt failed at iteration 2 → step scheduled for retry.
    // Drive the retry (waiting → running with retryAfter elapsed).
    if (result.status !== 'done') {
      // Deliberate: let the 10ms retryDelay elapse (a clock wait, not an outcome).
      await new Promise((r) => setTimeout(r, 50));
      result = (await wf.engine.executeRetry(run._id)) ?? result;
    }

    expect(result.status).toBe('done');
    // Iterations 0,1 ran exactly once (committed before the crash); the
    // retry resumed AT iteration 2 — not from scratch.
    expect(executed).toEqual([0, 1, 2, 3]);
    expect(result.steps[0]?.output).toEqual({ log: [0, 1, 2, 3] });
  });

  it('fails the step NON-retriably when maxIterations is exceeded', async () => {
    const wf = env.workflow('loop-runaway', {
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
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('maxIterations');
    // Non-retriable: exactly one attempt despite retries: 5.
    expect(result.steps[0]?.attempts).toBe(1);
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
    expect(() => validateRecurrence({ pattern: 'custom', cronExpression: 'not a cron' })).toThrow(
      /Invalid recurrence.cronExpression/,
    );
    expect(() => validateRecurrence({ pattern: 'weekly', daysOfWeek: [9] })).toThrow(/daysOfWeek/);
    expect(() => validateRecurrence({ pattern: 'monthly', dayOfMonth: 0 })).toThrow(/dayOfMonth/);
    expect(() => validateRecurrence({ pattern: 'daily', count: 0 })).toThrow(/count/);
    expect(() => validateRecurrence({ pattern: 'daily' })).not.toThrow();
  });
});

describe('v2.6: engine drives recurring schedules', () => {
  it('spawns the next occurrence as an idempotency-keyed draft on scheduled pickup', async () => {
    let runs = 0;

    const wf = env.workflow('recurring-job', {
      steps: {
        tick: async () => {
          runs += 1;
          return { ran: runs };
        },
      },
    });
    const wfId = wf.engine.definition.id;

    // Create a scheduled draft, then stamp a recurrence + past fire time
    // (simulating a SchedulingService-created recurring run that is now due).
    const draft = await wf.engine.start(
      { job: 'nightly' },
      { scheduledExecutionTime: new Date(Date.now() + 60_000) },
    );
    await env.runs.update(draft._id, {
      'scheduling.scheduledFor': '2026-06-10T03:00:00',
      'scheduling.timezone': 'UTC',
      'scheduling.executionTime': new Date(Date.now() - 1_000),
      'scheduling.recurrence': { pattern: 'daily', occurrences: 1 },
    });

    const result = await wf.engine.executeRetry(draft._id);

    expect(result?.status).toBe('done');
    expect(runs).toBe(1);

    // Exactly one NEXT occurrence queued, advanced a day, dedup-keyed.
    const next = await env.runModel.find({ workflowId: wfId, status: 'draft' }).lean();
    expect(next).toHaveLength(1);
    expect(next[0]?.scheduling?.recurrence?.occurrences).toBe(2);
    expect(next[0]?.scheduling?.executionTime.getTime()).toBeGreaterThan(Date.now());
    expect(next[0]?.idempotencyKey?.startsWith(`${wfId}:recur:`)).toBe(true);
    expect(next[0]?.input).toEqual({ job: 'nightly' });
  });

  it('does NOT spawn a next occurrence once count is exhausted', async () => {
    const wf = env.workflow('recurring-finite', {
      steps: { tick: async () => 'ok' },
    });

    const draft = await wf.engine.start(
      {},
      { scheduledExecutionTime: new Date(Date.now() + 60_000) },
    );
    await env.runs.update(draft._id, {
      'scheduling.scheduledFor': '2026-06-10T03:00:00',
      'scheduling.timezone': 'UTC',
      'scheduling.executionTime': new Date(Date.now() - 1_000),
      'scheduling.recurrence': { pattern: 'daily', count: 2, occurrences: 2 },
    });

    const result = await wf.engine.executeRetry(draft._id);
    expect(result?.status).toBe('done');

    const drafts = await env.runModel
      .find({ workflowId: wf.engine.definition.id, status: 'draft' })
      .lean();
    expect(drafts).toHaveLength(0);
  });
});

// ============================================================================
// 4. Step middleware (observability seam)
// ============================================================================

describe('v2.6: step middleware', () => {
  it('fires beforeStep/afterStep in order with output + durationMs', async () => {
    const calls: string[] = [];
    let observedOutput: unknown;
    let observedDuration: number | undefined;

    const wf = env.workflow('mw-basic', {
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
  });

  it('fires onStepError for failures and onWait for suspensions', async () => {
    const events: string[] = [];

    const wf = env.workflow('mw-error-wait', {
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
    });

    const run = await wf.start({});
    let result = await wf.execute(run._id);
    expect(result.status).toBe('waiting');
    expect(events).toContain('wait:gate:human:needs approval');

    result = await wf.resume(run._id, { approved: true });
    expect(result.status).toBe('failed');
    expect(events).toContain('error:boom:kaboom');
  });

  it('swallows middleware errors — a throwing hook cannot fail the step', async () => {
    const wf = env.workflow('mw-swallow', {
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
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.steps[0]?.output).toBe('ok');
  });
});

// ============================================================================
// 5. ctx.stream — non-durable frames
// ============================================================================

describe('v2.6: ctx.stream', () => {
  it('emits step:stream frames on the container bus with monotonic seq', async () => {
    const frames: Array<{ seq: number; frame: unknown; stepId: string }> = [];

    const wf = env.workflow('stream-frames', {
      steps: {
        speak: async (ctx) => {
          ctx.stream({ token: 'frame-a' });
          ctx.stream({ token: 'frame-b' });
          ctx.stream({ token: 'frame-c' });
          return 'spoken';
        },
      },
    });

    const listener = (p: { seq: number; frame: unknown; stepId: string }) => {
      frames.push({ seq: p.seq, frame: p.frame, stepId: p.stepId });
    };
    wf.container.eventBus.on('step:stream', listener);

    try {
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
      const doc = await env.runs.get(run._id);
      expect(JSON.stringify(doc)).not.toContain('frame-a');
    } finally {
      // The env's container (and its bus) outlives this test.
      wf.container.eventBus.off('step:stream', listener);
    }
  });
});

// ============================================================================
// 6. Abort semantics for the new primitives (AI-SDK-style discipline:
//    abort is NOT an error — frames drop, loops stop, no failed-state write)
// ============================================================================

describe('v2.6: abort semantics', () => {
  it('cancel mid-loop stops iterations and leaves the run cancelled (not failed)', async () => {
    let iterations = 0;

    const wf = env.workflow('loop-cancel', {
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
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    // Let a few iterations commit, then cancel.
    await env.eventually(() => expect(iterations).toBeGreaterThanOrEqual(3));
    const cancelled = await wf.cancel(run._id);
    expect(cancelled.status).toBe('cancelled');

    await execPromise;
    const countAtCancel = iterations;

    // No zombie loop: iteration counter must stop advancing after cancel.
    // Deliberate window (several 30ms iterations long) where nothing may happen.
    await new Promise((r) => setTimeout(r, 150));
    expect(iterations).toBe(countAtCancel);

    // Abort is not a failure: final status stays cancelled, no failed write.
    const doc = await env.runs.get(run._id);
    expect(doc?.status).toBe('cancelled');
  });

  it('ctx.stream frames emitted after cancellation are dropped silently', async () => {
    const frames: number[] = [];
    let resumeAfterAbort: (() => void) | undefined;

    const wf = env.workflow('stream-abort', {
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
    });

    const listener = (p: { seq: number }) => frames.push(p.seq);
    wf.container.eventBus.on('step:stream', listener);

    try {
      const run = await wf.start({});
      const execPromise = wf.execute(run._id).catch(() => {});

      // The step is parked (pre-cancel frame sent, abort listener attached).
      await env.eventually(() => expect(resumeAfterAbort).toBeDefined());
      await wf.cancel(run._id);
      resumeAfterAbort?.();
      await execPromise;

      // Only the pre-cancel frame arrived; the post-cancel one was dropped
      // without erroring the handler (abort ≠ error).
      expect(frames).toEqual([0]);
    } finally {
      wf.container.eventBus.off('step:stream', listener);
    }
  });

  it('loop resumes exactly from committed state when cancel beats a checkpoint', async () => {
    // Sibling guarantee to crash-resume: checkpoint() refuses writes once
    // aborted, so a cancelled run can never commit a torn iteration.
    const wf = env.workflow('loop-cancel-checkpoint', {
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
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});
    // Iterations 0+1 committed (n=2) → the third iteration is now in flight.
    await env.until(run._id, (r) => checkpointN(r.steps[0]?.output) === 2);
    await wf.cancel(run._id);
    await execPromise;

    const doc = await env.runs.get(run._id);
    expect(doc?.status).toBe('cancelled');
    // The persisted checkpoint reflects only COMMITTED iterations (n=2 from
    // iterations 0+1) — the in-flight third iteration never wrote.
    expect(checkpointN(doc?.steps[0]?.output)).toBe(2);
  });
});

// ============================================================================
// 7. Payload guards
// ============================================================================

describe('v2.6: payload size guards', () => {
  it('fails a step NON-retriably when output exceeds maxPayloadBytes', async () => {
    const wf = env.workflow('payload-cap-output', {
      steps: {
        big: {
          handler: async () => ({ blob: 'x'.repeat(5_000) }),
          retries: 5,
          retryDelay: 10,
        },
      },
      maxPayloadBytes: 1_000,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('maxPayloadBytes');
    expect(result.steps[0]?.attempts).toBe(1); // non-retriable
  });

  it('fails a step NON-retriably when a checkpoint exceeds maxPayloadBytes', async () => {
    const wf = env.workflow('payload-cap-checkpoint', {
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
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toContain('maxPayloadBytes');
    expect(result.steps[0]?.attempts).toBe(1);
  });

  it('default is warn-only: large outputs still succeed without a configured cap', async () => {
    const wf = env.workflow('payload-warn-only', {
      steps: {
        big: async () => ({ blob: 'x'.repeat(2_000_000) }), // > 1MB warn threshold
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
  });
});
