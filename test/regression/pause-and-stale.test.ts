import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createWorkflow } from '../../src/index.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { setupTestDB, cleanupTestDB, teardownTestDB, waitFor, waitUntil } from '../utils/setup.js';

describe('Pause and Stale Recovery Regression', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterEach(async () => {
    await cleanupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  it('should not auto-resume a paused timer-based workflow', async () => {
    const workflow = createWorkflow<Record<string, never>>('pause-timer-test', {
      steps: {
        sleep: async (ctx) => {
          await ctx.sleep(6000);
        },
        finalize: async () => {
          return { ok: true };
        },
      },
      context: () => ({}),
    });

    const run = await workflow.start({});

    const reachedWaiting = await waitUntil(async () => {
      const latest = await workflow.get(run._id);
      return latest?.status === 'waiting';
    }, 2000);

    expect(reachedWaiting).toBe(true);

    await workflow.pause(run._id);

    // Wait past the timer resume point; it should still be paused and waiting
    await waitFor(6500);

    const pausedRun = await workflow.get(run._id);
    expect(pausedRun?.paused).toBe(true);
    expect(pausedRun?.status).toBe('waiting');

    // Manual resume should continue the workflow
    await workflow.resume(run._id);

    const resumed = await waitUntil(async () => {
      const latest = await workflow.get(run._id);
      return latest?.status === 'done';
    }, 2000);

    expect(resumed).toBe(true);

    workflow.shutdown();
  });

  it('should ignore paused runs in stale recovery queries', async () => {
    const now = new Date();
    const staleTime = new Date(Date.now() - 5000);

    await WorkflowRunModel.create({
      _id: 'stale-paused-run',
      workflowId: 'stale-test',
      status: 'running',
      steps: [
        {
          stepId: 'step-1',
          status: 'running',
          attempts: 1,
          startedAt: staleTime,
        },
      ],
      currentStepId: 'step-1',
      context: {},
      input: {},
      createdAt: now,
      updatedAt: now,
      lastHeartbeat: staleTime,
      paused: true,
    });

    await WorkflowRunModel.create({
      _id: 'stale-active-run',
      workflowId: 'stale-test',
      status: 'running',
      steps: [
        {
          stepId: 'step-1',
          status: 'running',
          attempts: 1,
          startedAt: staleTime,
        },
      ],
      currentStepId: 'step-1',
      context: {},
      input: {},
      createdAt: now,
      updatedAt: now,
      lastHeartbeat: staleTime,
      paused: false,
    });

    const stale = await workflowRunRepository.getStaleRunningWorkflows(1000, 10);
    const ids = stale.map((run) => run._id);

    expect(ids).toContain('stale-active-run');
    expect(ids).not.toContain('stale-paused-run');
  });
});
