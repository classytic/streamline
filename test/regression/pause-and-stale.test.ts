import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Pause and Stale Recovery Regression', () => {
  it('should not auto-resume a paused timer-based workflow', async () => {
    const workflow = env.workflow<Record<string, never>>('pause-timer-test', {
      steps: {
        sleep: async (ctx) => {
          await ctx.sleep(6000);
        },
        finalize: async () => {
          return { ok: true };
        },
      },
      context: () => ({}),
      autoExecute: true,
    });

    const run = await workflow.start({});

    await env.until(run._id, 'waiting', { timeout: 2000 });

    await workflow.pause(run._id);

    // Wait past the timer resume point (6s); it must stay paused and waiting
    // the whole time — any auto-resume fails this immediately.
    await expect(
      env.until(run._id, (r) => r.paused !== true || r.status !== 'waiting', { timeout: 6500 }),
    ).rejects.toThrow(/not reached within 6500ms/);

    const pausedRun = await workflow.get(run._id);
    expect(pausedRun?.paused).toBe(true);
    expect(pausedRun?.status).toBe('waiting');

    // Manual resume should continue the workflow
    await workflow.resume(run._id);

    await env.until(run._id, 'done', { timeout: 2000 });
  });

  it('should ignore paused runs in stale recovery queries', async () => {
    const staleTime = new Date(Date.now() - 5000);
    const staleStep = [
      { stepId: 'step-1', status: 'running' as const, attempts: 1, startedAt: staleTime },
    ];

    await env.runs.insert('stale-test', {
      _id: 'stale-paused-run',
      status: 'running',
      steps: staleStep,
      currentStepId: 'step-1',
      lastHeartbeat: staleTime,
      paused: true,
    });

    await env.runs.insert('stale-test', {
      _id: 'stale-active-run',
      status: 'running',
      steps: staleStep,
      currentStepId: 'step-1',
      lastHeartbeat: staleTime,
      paused: false,
    });

    const stale = await env.container.repository.getStaleRunningWorkflows(1000, 10);
    const ids = stale.map((run) => run._id);

    expect(ids).toContain('stale-active-run');
    expect(ids).not.toContain('stale-paused-run');
  });
});
