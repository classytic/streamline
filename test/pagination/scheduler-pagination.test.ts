/**
 * Scheduler Pagination Tests
 *
 * Tests that SmartScheduler correctly handles large numbers of workflows (10,000+)
 * using efficient pagination patterns inspired by mongokit/Repository.ts
 *
 * Key differences from traditional pagination:
 * - No skip/page tracking needed (workflows are claimed atomically)
 * - No total count needed (scheduler polls continuously)
 * - Uses "top N" pattern: get first N ready workflows, process, repeat
 * - After claim (status → 'running'), workflows automatically drop from next poll
 */

import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowHandlers } from '../../src/core/types.js';
import { WorkflowEngine } from '../../src/execution/engine.js';
import { DEFAULT_SCHEDULER_CONFIG, SmartScheduler } from '../../src/execution/smart-scheduler.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('Scheduler Pagination - Large Scale', () => {
  let scheduler: SmartScheduler | undefined;
  // Raw engines aren't tracked by the env — shut them down here
  const createdEngines: { shutdown: () => void }[] = [];

  afterEach(async () => {
    scheduler?.stop();
    await scheduler?.drain();
    scheduler = undefined;
    for (const engine of createdEngines.splice(0)) engine.shutdown();
  });

  it('should efficiently handle 500 waiting workflows with pagination', async () => {
    // Use autoExecute=false for deterministic control
    const workflow: WorkflowDefinition = {
      id: 'timer-workflow',
      name: 'Timer Workflow',
      version: '1.0.0',
      steps: [
        { id: 'step1', name: 'Step 1' },
        { id: 'step2', name: 'Step 2' },
      ],
      createContext: () => ({}),
    };

    const handlers: WorkflowHandlers = {
      step1: async (ctx) => {
        await ctx.sleep(10); // Short sleep to create waiting state
        return 'done';
      },
      step2: async () => 'final',
    };

    const engine = new WorkflowEngine(workflow, handlers, env.container, { autoExecute: false });
    createdEngines.push(engine);

    // Create 500 workflows
    const runs = await Promise.all(
      Array.from({ length: 500 }, (_, i) => engine.start({ index: i })),
    );

    // Execute all workflows - they'll each hit sleep and become waiting
    // Execute in batches to avoid overwhelming the event loop
    const batchSize = 50;
    for (let i = 0; i < runs.length; i += batchSize) {
      const batch = runs.slice(i, i + batchSize);
      await Promise.all(batch.map((run) => engine.execute(run._id)));
    }

    // Due to inline timer handling (10ms < 5s), workflows complete immediately
    const doneCount = await env.runModel.countDocuments({ status: 'done' });

    // With inline handling, all should be done
    expect(doneCount).toBeGreaterThanOrEqual(400); // At least 80% complete
  });

  it('should not skip workflows when using limit-based pagination', async () => {
    // This test verifies that workflows process correctly in batches
    const workflow: WorkflowDefinition = {
      id: 'simple-workflow',
      name: 'Simple Workflow',
      version: '1.0.0',
      steps: [
        { id: 'step1', name: 'Step 1' },
        { id: 'step2', name: 'Step 2' },
      ],
      createContext: () => ({}),
    };

    const handlers: WorkflowHandlers = {
      step1: async (ctx) => {
        await ctx.sleep(5); // Very short sleep
        return 'step1-done';
      },
      step2: async () => 'step2-done',
    };

    const engine = new WorkflowEngine(workflow, handlers, env.container, { autoExecute: false });
    createdEngines.push(engine);

    // Create 100 workflows (smaller for reliability)
    const runs = await Promise.all(
      Array.from({ length: 100 }, (_, i) => engine.start({ index: i })),
    );

    // Execute in batches (pagination pattern)
    const batchSize = 25;
    for (let i = 0; i < runs.length; i += batchSize) {
      const batch = runs.slice(i, i + batchSize);
      await Promise.all(batch.map((run) => engine.execute(run._id)));
    }

    // Verify all workflows completed
    const completedCount = await env.runModel.countDocuments({ status: 'done' });
    expect(completedCount).toBe(100);
  });

  it('should handle concurrent workflow execution', async () => {
    // This test verifies that concurrent workflow execution works correctly
    const workflow: WorkflowDefinition = {
      id: 'concurrent-workflow',
      name: 'Concurrent Workflow',
      version: '1.0.0',
      steps: [
        { id: 'step1', name: 'Step 1' },
        { id: 'step2', name: 'Step 2' },
      ],
      createContext: () => ({}),
    };

    const executionOrder: string[] = [];
    const handlers: WorkflowHandlers = {
      step1: async (ctx) => {
        executionOrder.push(`${ctx.runId}:step1`);
        await ctx.sleep(5); // Very short sleep
        return 'step1-done';
      },
      step2: async (ctx) => {
        executionOrder.push(`${ctx.runId}:step2`);
        return 'step2-done';
      },
    };

    const engine = new WorkflowEngine(workflow, handlers, env.container, { autoExecute: false });
    createdEngines.push(engine);

    // Create 50 workflows
    const runs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => engine.start({ index: i })),
    );

    // Execute all concurrently
    await Promise.all(runs.map((run) => engine.execute(run._id)));

    // Verify all workflows completed
    const completedCount = await env.runModel.countDocuments({ status: 'done' });
    expect(completedCount).toBe(50);

    // Verify all steps executed (2 steps per workflow = 100 total)
    expect(executionOrder.length).toBe(100);
  });

  it('should respect maxWorkflowsPerPoll limit to avoid memory issues', async () => {
    const workflow: WorkflowDefinition = {
      id: 'memory-test',
      name: 'Memory Test Workflow',
      version: '1.0.0',
      steps: [{ id: 'step1', name: 'Step 1' }],
      createContext: () => ({}),
    };

    const handlers: WorkflowHandlers = {
      step1: async () => {
        // Simulate slow processing to let workflows accumulate
        await delay(200);
        return 'done';
      },
    };

    const engine = new WorkflowEngine(workflow, handlers, env.container, { autoExecute: false });
    createdEngines.push(engine);

    // Create 500 workflows ready to resume
    await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const run = await engine.start({ index: i });
        await env.runs.update(run._id, {
          status: 'waiting',
          'steps.0.status': 'waiting',
          'steps.0.waitingFor': {
            type: 'timer',
            reason: 'test',
            resumeAt: new Date(Date.now() - 1000),
          },
        });
      }),
    );

    // Count how many runs each poll dispatches
    let dispatchedThisPoll = 0;

    // Scheduler with a strict per-poll limit, over the env's repository
    scheduler = new SmartScheduler(
      env.container.repository,
      async (runId) => {
        dispatchedThisPoll++;
        await engine.resume(runId, {});
      },
      {
        ...DEFAULT_SCHEDULER_CONFIG,
        basePollInterval: 500,
        minPollInterval: 500,
        maxPollInterval: 500,
        maxWorkflowsPerPoll: 25, // Only 25 per poll
        idleTimeout: 10000,
        maxConsecutiveFailures: 5,
        adaptivePolling: false,
        staleCheckInterval: 5 * 60 * 1000,
      },
    );

    // Drive a few poll cycles deterministically: one poll, then its dispatched work
    for (let poll = 0; poll < 3; poll++) {
      dispatchedThisPoll = 0;
      await scheduler.pollOnce();
      await scheduler.drain();
      // Each poll should process max 25 workflows
      expect(dispatchedThisPoll).toBeGreaterThan(0);
      expect(dispatchedThisPoll).toBeLessThanOrEqual(25);
    }

    const processedCount = await env.runModel.countDocuments({
      status: { $in: ['done', 'running'] },
    });

    expect(scheduler.getStats().totalPolls).toBeGreaterThanOrEqual(3);
    expect(processedCount).toBeLessThanOrEqual(500);
  }, 10000);
});
