import { describe, it, expect, vi } from 'vitest';
import { executeParallel } from '../../src/features/parallel.js';
import { StepContextImpl } from '../../src/execution/context.js';
import { WorkflowEventBus } from '../../src/core/events.js';
import type { WorkflowRun, WorkflowRunRepository } from '../../src/core/types.js';

describe('Review Claims Fixes', () => {
  it('should throw error when using race mode with concurrency limits', async () => {
    const tasks = [
      () => Promise.resolve('fast'),
      () => Promise.resolve('slow-1'),
      () => Promise.resolve('slow-2'),
    ];

    await expect(
      executeParallel(tasks, { mode: 'race', concurrency: 2 })
    ).rejects.toThrow("mode 'race' cannot be combined with concurrency limiting");
  });

  it('should throw error when using any mode with concurrency limits', async () => {
    const tasks = [
      () => Promise.resolve('fast'),
      () => Promise.reject(new Error('slow-fail')),
      () => Promise.resolve('slow-2'),
    ];

    await expect(
      executeParallel(tasks, { mode: 'any', concurrency: 2 })
    ).rejects.toThrow("mode 'any' cannot be combined with concurrency limiting");
  });

  // Note: handleShortDelayOrSchedule test removed - function is now an internal implementation detail

  it('should nest log metadata under data key to prevent override', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const run: WorkflowRun = {
        _id: 'run-1',
        workflowId: 'wf-1',
        status: 'running',
        steps: [{ stepId: 'step-1', status: 'running', attempts: 1 }],
        currentStepId: 'step-1',
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const repository = {
        update: async () => run,
      } as unknown as WorkflowRunRepository;

      const ctx = new StepContextImpl(
        run._id,
        'step-1',
        run.context,
        run.input,
        1,
        run,
        repository,
        new WorkflowEventBus()
      );

      // Pass data that tries to override reserved fields
      ctx.log('test', { runId: 'spoof', stepId: 'spoof', attempt: 99 });

      const payload = JSON.parse(infoSpy.mock.calls[0]?.[0] as string);

      // Reserved fields should NOT be overridden
      expect(payload.runId).toBe(run._id);
      expect(payload.stepId).toBe('step-1');
      expect(payload.attempt).toBe(1);

      // User data should be nested under 'data' key
      expect(payload.data).toEqual({ runId: 'spoof', stepId: 'spoof', attempt: 99 });
    } finally {
      infoSpy.mockRestore();
    }
  });
});
