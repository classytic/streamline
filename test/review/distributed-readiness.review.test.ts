import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Distributed readiness review', () => {
  it('should allow reusing an idempotency key after the original run reaches a terminal state', async () => {
    const wf = env.workflow('review-idempotency-reuse', {
      steps: {
        done: async () => 'ok',
      },
    });

    const first = await wf.start({}, { idempotencyKey: 'reusable-key' });
    const completed = await wf.execute(first._id);
    expect(completed.status).toBe('done');

    const second = await wf.start({}, { idempotencyKey: 'reusable-key' });

    expect(second._id).not.toBe(first._id);
  });

  it('should eventually promote queued concurrency-limited draft runs when capacity frees up', async () => {
    const wf = env.workflow<{ tenantId: string }, { tenantId: string }>(
      'review-concurrency-promotion',
      {
        steps: {
          work: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return 'done';
          },
        },
        concurrency: { limit: 1, key: (input) => input.tenantId },
        context: (input) => ({ tenantId: input.tenantId }),
        // The engine itself (not the test) must run the first and promote the second
        autoExecute: true,
      },
    );

    const first = await wf.start({ tenantId: 't-1' });
    const second = await wf.start({ tenantId: 't-1' });

    expect(first.status).toBe('running');
    expect(second.status).toBe('draft');

    const finalSecond = await env.until(second._id, 'done', { timeout: 4000 });
    expect(finalSecond.status).toBe('done');
  });

  it('should not remove other workflows trigger listeners when one workflow shuts down', async () => {
    // Both workflows share ONE container (the env's) and so one event bus.
    const wfA = env.workflow('review-trigger-a', {
      steps: { step: async () => 'a' },
      trigger: { event: 'shared.trigger' },
    });

    const wfB = env.workflow('review-trigger-b', {
      steps: { step: async () => 'b' },
      trigger: { event: 'shared.trigger' },
    });

    wfA.shutdown();

    env.container.eventBus.emit('shared.trigger', { data: { value: 1 } });

    const runsOfB = () => env.runModel.countDocuments({ workflowId: wfB.engine.definition.id });
    await env.eventually(async () => expect(await runsOfB()).toBeGreaterThan(0), { timeout: 1500 });

    expect(await runsOfB()).toBeGreaterThan(0);
  });
});
