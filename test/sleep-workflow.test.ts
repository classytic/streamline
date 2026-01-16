import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { sleepWorkflow } from '../docs/examples/sleep-workflow.js';

describe('Sleep Workflow', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/streamline-test');
  });

  afterAll(async () => {
    sleepWorkflow.shutdown();
    await mongoose.connection.close();
  });

  it('should handle sleep correctly', async () => {
    const run = await sleepWorkflow.start({ message: 'Testing sleep' });
    expect(run.status).toBe('running');

    // Execute manually - with inline sleep handling for delays <= 5s (2s here),
    // this should complete after ~2 seconds
    const startTime = Date.now();
    const result = await sleepWorkflow.execute(run._id);
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe('done');
    expect(result.context.startTime).toBeInstanceOf(Date);
    expect(result.context.endTime).toBeInstanceOf(Date);

    const duration =
      result.context.endTime!.getTime() - result.context.startTime!.getTime();
    expect(duration).toBeGreaterThanOrEqual(2000);
    expect(duration).toBeLessThan(3000);

    // Verify inline execution took roughly 2 seconds
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(3500);
  }, 15000);
});
