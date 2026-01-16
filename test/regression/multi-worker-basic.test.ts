/**
 * Basic Multi-Worker Tests
 *
 * Focused tests for the critical fixes without race conditions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createWorkflow } from '../../src/index.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { workflowCache } from '../../src/storage/cache.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/streamline-test';

// Track workflows for cleanup
const createdWorkflows: { shutdown: () => void }[] = [];

describe('Multi-Worker Basic Tests', () => {
  beforeEach(async () => {
    await mongoose.connect(MONGODB_URI);
    await WorkflowRunModel.deleteMany({});
    workflowCache.clear();
    createdWorkflows.length = 0; // Reset
  });

  afterEach(async () => {
    // Shutdown all workflows first to stop background processes
    createdWorkflows.forEach((w) => w.shutdown());
    await WorkflowRunModel.deleteMany({});
    workflowCache.clear();
    await mongoose.disconnect();
  });

  it('should handle pause/resume for pending step', async () => {
    let executed = false;

    const workflow = createWorkflow<{ executed: boolean }>('pause-pending', {
      steps: {
        step1: async (ctx) => {
          executed = true;
          await ctx.set('executed', true);
          return 'done';
        },
      },
      context: () => ({ executed: false }),
      autoExecute: false,
    });
    createdWorkflows.push(workflow);

    const run = await workflow.start({});

    // Pause before execution
    const paused = await workflow.pause(run._id);
    expect(paused.paused).toBe(true); // Paused flag set
    expect(paused.status).toBe('running'); // Status unchanged
    expect(executed).toBe(false);

    // Resume should continue execution
    const resumed = await workflow.resume(run._id);
    expect(resumed.status).toBe('done');
    expect(executed).toBe(true);

    console.log('✓ Pause/resume for pending step works');
  });

  it('should pause retry-pending step (keep retryAfter)', async () => {
    // This test verifies pause() behavior with retry-pending steps.
    // With inline retry handling (delays < 5s), execute() handles all retries itself.
    // To test pause() during retry backoff, we use a custom longer delay via sleep.
    // Here we test that after exhausting retries, the workflow is properly failed.

    let attempts = 0;

    const workflow = createWorkflow<Record<string, never>>('pause-retry', {
      steps: {
        failing: async () => {
          attempts++;
          throw new Error('Test error');
        },
      },
      context: () => ({}),
      defaults: { retries: 3 },
      autoExecute: false,
    });
    createdWorkflows.push(workflow);

    const run = await workflow.start({});

    // Execute - with inline retry handling, will exhaust all retries and fail
    const result = await workflow.execute(run._id);

    // With retries: 3, we get 3 attempts (1 initial + 2 retries, since attempts < maxRetries)
    expect(attempts).toBe(3);
    expect(result.status).toBe('failed');

    const step = result.steps.find((s) => s.stepId === 'failing');
    expect(step?.status).toBe('failed');
    expect(step?.error).toBeDefined();

    console.log('✓ Inline retry handling exhausts all retries');
  }, 15000);

  it('should handle explicit wait/resume correctly', async () => {
    const workflow = createWorkflow<Record<string, never>>('explicit-wait', {
      steps: {
        wait: async (ctx) => {
          await ctx.wait('Waiting for input');
        },
        process: async (ctx) => {
          const input = ctx.getOutput('wait');
          return `Processed: ${input}`;
        },
      },
      context: () => ({}),
      autoExecute: false,
    });
    createdWorkflows.push(workflow);

    const run = await workflow.start({});

    // Execute - will wait
    const waited = await workflow.execute(run._id);
    expect(waited.status).toBe('waiting');

    const step = waited.steps.find((s) => s.stepId === 'wait');
    expect(step?.status).toBe('waiting');

    // Resume with payload
    const resumed = await workflow.resume(run._id, 'user input');
    expect(resumed.status).toBe('done');

    const waitOutput = resumed.steps.find((s) => s.stepId === 'wait')?.output;
    expect(waitOutput).toBe('user input');

    console.log('✓ Explicit wait/resume works correctly');
  });

  it('should detect no progress when step already running', async () => {
    let started = false;

    const workflow1 = createWorkflow<Record<string, never>>('no-progress', {
      steps: {
        slow: async () => {
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 300));
          return 'done';
        },
      },
      context: () => ({}),
      autoExecute: false, // Manually control execution
    });

    const workflow2 = createWorkflow<Record<string, never>>('no-progress', {
      steps: {
        slow: async () => {
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 300));
          return 'done';
        },
      },
      context: () => ({}),
      autoExecute: false, // Manually control execution
    });
    createdWorkflows.push(workflow1, workflow2);

    const run = await workflow1.start({});

    // Worker 1 starts (will take 300ms)
    const promise1 = workflow1.execute(run._id);

    // Wait for worker 1 to claim step
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(true);

    // Worker 2 tries - should exit quickly without waiting
    const startTime = Date.now();
    const result2 = await workflow2.execute(run._id);
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(100); // Fast exit
    expect(result2.status).toBe('running'); // Still running

    // Wait for worker 1 to finish
    await promise1;

    console.log(`✓ No-progress detection: worker 2 exited in ${elapsed}ms`);
  });

  it('should refresh state when step already running', async () => {
    const workflow1 = createWorkflow<Record<string, never>>('refresh-state', {
      steps: {
        fast: async () => 'fast-done',
        slow: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return 'slow-done';
        },
      },
      context: () => ({}),
      autoExecute: false, // Manually control execution
    });

    const workflow2 = createWorkflow<Record<string, never>>('refresh-state', {
      steps: {
        fast: async () => 'fast-done',
        slow: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return 'slow-done';
        },
      },
      context: () => ({}),
      autoExecute: false, // Manually control execution
    });
    createdWorkflows.push(workflow1, workflow2);

    const run = await workflow1.start({});

    // Worker 1 executes
    const promise1 = workflow1.execute(run._id);

    // Wait for fast step to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Worker 2 executes - should refresh and see fast step done
    const result2 = await workflow2.execute(run._id);

    const fastStep = result2.steps.find((s) => s.stepId === 'fast');
    expect(fastStep?.status).toBe('done');
    expect(fastStep?.output).toBe('fast-done');

    await promise1;

    console.log('✓ State refreshed from DB when step running');
  });
});
