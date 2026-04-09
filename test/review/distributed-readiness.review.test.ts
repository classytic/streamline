import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDB, setupTestDB, teardownTestDB, waitUntil } from '../utils/setup.js';
import { WorkflowRunModel, createContainer, createWorkflow } from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

describe('Distributed readiness review', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should allow reusing an idempotency key after the original run reaches a terminal state', async () => {
    const wf = createWorkflow('review-idempotency-reuse', {
      steps: {
        done: async () => 'ok',
      },
      autoExecute: false,
    });

    const first = await wf.start({}, { idempotencyKey: 'reusable-key' });
    const completed = await wf.execute(first._id);
    expect(completed.status).toBe('done');

    const second = await wf.start({}, { idempotencyKey: 'reusable-key' });

    expect(second._id).not.toBe(first._id);

    wf.shutdown();
  });

  it('should eventually promote queued concurrency-limited draft runs when capacity frees up', async () => {
    const wf = createWorkflow<{ tenantId: string }>('review-concurrency-promotion', {
      steps: {
        work: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'done';
        },
      },
      concurrency: { limit: 1, key: (input: { tenantId: string }) => input.tenantId },
      context: (input: { tenantId: string }) => ({ tenantId: input.tenantId }),
    });

    const first = await wf.start({ tenantId: 't-1' });
    const second = await wf.start({ tenantId: 't-1' });

    expect(first.status).toBe('running');
    expect(second.status).toBe('draft');

    await waitUntil(async () => {
      const run = await WorkflowRunModel.findById(second._id).lean();
      return run?.status === 'done';
    }, 4000);

    const finalSecond = await WorkflowRunModel.findById(second._id).lean();
    expect(finalSecond?.status).toBe('done');

    wf.shutdown();
  });

  it('should not remove other workflows trigger listeners when one workflow shuts down', async () => {
    const container = createContainer();

    const wfA = createWorkflow('review-trigger-a', {
      steps: { step: async () => 'a' },
      trigger: { event: 'shared.trigger' },
      container,
      autoExecute: false,
    });

    const wfB = createWorkflow('review-trigger-b', {
      steps: { step: async () => 'b' },
      trigger: { event: 'shared.trigger' },
      container,
      autoExecute: false,
    });

    wfA.shutdown();

    container.eventBus.emit('shared.trigger' as any, { data: { value: 1 } });

    await waitUntil(async () => {
      const count = await WorkflowRunModel.countDocuments({ workflowId: 'review-trigger-b' });
      return count > 0;
    }, 1500);

    const runsB = await WorkflowRunModel.countDocuments({ workflowId: 'review-trigger-b' });
    expect(runsB).toBeGreaterThan(0);

    wfB.shutdown();
  });
});
