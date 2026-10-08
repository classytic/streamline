/**
 * Saga compensation under owned attempts.
 *
 *   - A crash between the `failed` write and `failed → compensating` leaves a
 *     durable `compensationDue` marker; recovery enters the saga. A historic
 *     `failed` run WITHOUT the marker is never compensated retroactively.
 *   - The walk is owned (`compensationAttemptId`): after a recovery reclaim the
 *     old walker's writes are refused and it never settles the run.
 *   - `cancel()` aborts the compensation handler's `ctx.signal` and stops the walk.
 *   - Attempts are persisted per try; a re-entered walk resumes the budget.
 *   - Documented defaults (3 attempts) hold; `compensateTimeout` aborts one try.
 *
 * Crash shapes are persisted directly (as in saga-compensation.test.ts) and
 * driven through `engine.recoverCompensation` — the verb the scheduler calls.
 */

import { describe, expect, it } from 'vitest';
import type { StepState, WorkflowRun } from '../../src/core/types.js';
import type { RunFields, WorkflowLike } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const OLD = new Date(Date.now() - 10 * 60 * 1000);

/** Persist a post-crash run: steps `a`,`b` done, `c` failed. Returns the run id. */
async function persistRun(
  wf: WorkflowLike,
  fields: RunFields & { status: WorkflowRun['status'] },
  compensation: Partial<Record<'a' | 'b', StepState['compensation']>> = {},
): Promise<string> {
  const step = (stepId: string, status: StepState['status']): StepState => {
    const comp = compensation[stepId as 'a' | 'b'];
    return { stepId, status, attempts: 1, startedAt: OLD, ...(comp ? { compensation: comp } : {}) };
  };
  const run = await env.runs.insert(wf, {
    steps: [step('a', 'done'), step('b', 'done'), step('c', 'failed')],
    currentStepId: 'c',
    createdAt: OLD,
    startedAt: OLD,
    lastHeartbeat: OLD,
    ...fields,
    updatedAt: fields.updatedAt ?? OLD,
  });
  return run._id;
}

/** A promise plus the function that resolves it — for "the handler got here". */
function signal(): { reached: Promise<void>; reach: () => void } {
  let reach!: () => void;
  const reached = new Promise<void>((r) => {
    reach = r;
  });
  return { reached, reach };
}

describe('saga — failed → compensating crash window', () => {
  it('a failure write marks compensationDue in the same update (inline path clears it)', async () => {
    const wf = env.workflow('due', {
      steps: {
        a: { handler: async () => 'a', onCompensate: async () => {} },
        c: {
          handler: async () => {
            throw new Error('boom');
          },
          retries: 1,
        },
      },
    });
    const seen: unknown[] = [];
    const onFailed = async (p: { runId: string }) => {
      seen.push((await env.runs.get(p.runId))?.compensationDue);
    };
    wf.container.eventBus.on('workflow:failed', onFailed);

    try {
      const run = await wf.start({});
      const result = await wf.execute(run._id);

      expect(result.status).toBe('compensated');
      expect(seen[0]).toBe(true); // durable before the saga was entered
      const stored = await env.runs.get(run._id);
      expect(stored?.compensationDue).toBeUndefined();
      expect(stored?.compensationAttemptId).toBeUndefined();
    } finally {
      wf.container.eventBus.off('workflow:failed', onFailed);
    }
  });

  it('recovery enters the saga for a stale failed run carrying the marker', async () => {
    const compensated: string[] = [];
    const wf = env.workflow('crash-window', {
      steps: {
        a: { handler: async () => 'a', onCompensate: async () => void compensated.push('a') },
        b: { handler: async () => 'b', onCompensate: async () => void compensated.push('b') },
        c: async () => 'c',
      },
    });
    const runId = await persistRun(wf, { status: 'failed', compensationDue: true });

    const swept = await env.container.repository.getStaleCompensatingRuns(60_000, 10, {
      bypassTenant: true,
      workflowId: wf.engine.definition.id,
    });
    expect(swept.map((r) => r._id)).toEqual([runId]);

    const result = await wf.engine.recoverCompensation(runId, 60_000);
    expect(result?.status).toBe('compensated');
    expect(compensated).toEqual(['b', 'a']);
  });

  it('never compensates a historic failed run without the marker, nor a fresh one', async () => {
    const compensated: string[] = [];
    const wf = env.workflow('historic', {
      steps: {
        a: { handler: async () => 'a', onCompensate: async () => void compensated.push('a') },
        b: async () => 'b',
        c: async () => 'c',
      },
    });
    const historic = await persistRun(wf, { status: 'failed' });
    const fresh = await persistRun(wf, {
      status: 'failed',
      compensationDue: true,
      updatedAt: new Date(), // the inline entry is milliseconds away
    });

    const swept = await env.container.repository.getStaleCompensatingRuns(60_000, 10, {
      bypassTenant: true,
      workflowId: wf.engine.definition.id,
    });
    expect(swept).toEqual([]);
    expect(await wf.engine.recoverCompensation(historic, 60_000)).toBeNull();
    expect(await wf.engine.recoverCompensation(fresh, 60_000)).toBeNull();
    expect(compensated).toEqual([]);
  });
});

describe('saga — owned walk', () => {
  it('a superseded walker cannot mark steps done or settle the run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const walkerAInHandler = signal();
    let calls = 0;
    const settled: string[] = [];
    const onCompensated = (p: { runId: string }) => void settled.push(p.runId);
    env.container.eventBus.on('workflow:compensated', onCompensated);

    try {
      const wf = env.workflow('superseded', {
        steps: {
          a: {
            handler: async () => 'a',
            onCompensate: async () => {
              calls++;
              if (calls === 1) {
                walkerAInHandler.reach();
                await gate; // walker A stalls inside its handler
              }
            },
          },
          b: async () => 'b',
          c: async () => 'c',
        },
      });
      const runId = await persistRun(wf, { status: 'failed', compensationDue: true });

      // Walker A enters and blocks in the handler.
      const walkerA = wf.engine.recoverCompensation(runId, 60_000);
      await walkerAInHandler.reached;
      expect(calls).toBe(1);

      // A looks dead (stale heartbeat) → walker B reclaims with a new token.
      const tokenA = (await env.runs.get(runId))?.compensationAttemptId;
      await env.runs.update(runId, { lastHeartbeat: OLD });
      const resultB = await wf.engine.recoverCompensation(runId, 60_000);
      expect(resultB?.status).toBe('compensated');
      expect(calls).toBe(2); // at-least-once: B re-ran the step A had not finished

      // A wakes up: its done-flip and settle are refused.
      release();
      const resultA = await walkerA;
      expect(resultA?.status).toBe('compensated'); // B's outcome, read back
      expect(tokenA).toBeDefined();

      const stored = await env.runs.get(runId);
      expect(stored?.steps[0]?.compensation?.attempts).toBe(1); // only B's flip landed
      expect(settled).toEqual([runId]); // settled exactly once, by B
    } finally {
      env.container.eventBus.off('workflow:compensated', onCompensated);
    }
  });

  it('cancel() aborts the compensation handler signal and stops the walk', async () => {
    const ran: string[] = [];
    const bInHandler = signal();
    let aborted = false;
    const wf = env.workflow('cancel', {
      steps: {
        a: { handler: async () => 'a', onCompensate: async () => void ran.push('a') },
        b: {
          handler: async () => 'b',
          onCompensate: async (ctx) => {
            ran.push('b');
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                aborted = true;
                resolve();
              });
              bInHandler.reach();
            });
          },
        },
        c: async () => 'c',
      },
    });
    const runId = await persistRun(wf, { status: 'failed', compensationDue: true });

    const walk = wf.engine.recoverCompensation(runId, 60_000);
    await bInHandler.reached;
    await wf.cancel(runId);
    const result = await walk;

    expect(aborted).toBe(true);
    expect(ran).toEqual(['b']); // `a` never compensated after the cancel
    expect(result?.status).toBe('cancelled');
  });
});

describe('saga — retries, defaults, timeout', () => {
  it('defaults to the documented 3 attempts', async () => {
    let calls = 0;
    const wf = env.workflow('defaults', {
      steps: {
        a: {
          handler: async () => 'a',
          compensateRetryDelay: 1,
          onCompensate: async () => {
            calls++;
            if (calls < 3) throw new Error(`transient ${calls}`);
          },
        },
        b: async () => 'b',
        c: async () => 'c',
      },
    });
    const runId = await persistRun(wf, { status: 'failed', compensationDue: true });

    const result = await wf.engine.recoverCompensation(runId, 60_000);
    expect(result?.status).toBe('compensated');
    expect(calls).toBe(3);
    const stored = await env.runs.get(runId);
    expect(stored?.steps[0]?.compensation?.attempts).toBe(3);
  });

  it('a re-entered walk resumes the persisted attempt budget', async () => {
    let calls = 0;
    const wf = env.workflow('budget', {
      steps: {
        a: {
          handler: async () => 'a',
          compensateRetries: 3,
          compensateRetryDelay: 1,
          onCompensate: async () => {
            calls++;
            throw new Error('still down');
          },
        },
        b: async () => 'b',
        c: async () => 'c',
      },
    });
    // Crashed after spending 2 of 3 attempts.
    const runId = await persistRun(
      wf,
      { status: 'compensating', lastHeartbeat: OLD },
      { a: { status: 'pending', attempts: 2, startedAt: OLD } },
    );

    const result = await wf.engine.recoverCompensation(runId, 60_000);
    expect(calls).toBe(1); // one attempt left, not a fresh three
    expect(result?.status).toBe('compensation_failed');
    const stored = await env.runs.get(runId);
    expect(stored?.steps[0]?.compensation?.attempts).toBe(3);
    expect(stored?.steps[0]?.compensation?.status).toBe('failed');
  });

  it('compensateTimeout aborts one attempt and the retry succeeds', async () => {
    let calls = 0;
    let firstAborted = false;
    const wf = env.workflow('timeout', {
      steps: {
        a: {
          handler: async () => 'a',
          compensateTimeout: 50,
          compensateRetryDelay: 1,
          onCompensate: async (ctx) => {
            calls++;
            if (calls === 1) {
              await new Promise<void>((resolve) => {
                ctx.signal.addEventListener('abort', () => {
                  firstAborted = true;
                  resolve();
                });
              });
            }
          },
        },
        b: async () => 'b',
        c: async () => 'c',
      },
    });
    const runId = await persistRun(wf, { status: 'failed', compensationDue: true });

    const result = await wf.engine.recoverCompensation(runId, 60_000);
    expect(result?.status).toBe('compensated');
    expect(firstAborted).toBe(true);
    expect(calls).toBe(2);
  });
});
