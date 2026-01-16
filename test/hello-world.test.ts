import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { helloWorld } from '../docs/examples/hello-world.js';
import { waitUntil } from './utils/setup.js';

describe('Hello World Workflow', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/streamline_test', {
      serverSelectionTimeoutMS: 5000,
    });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('should complete hello world workflow', async () => {
    const run = await helloWorld.start({ name: 'Vitest' });

    expect(run._id).toBeDefined();
    expect(run.status).toBe('running');
    expect(run.workflowId).toBe('hello-world');

    // Wait for autoExecute to complete
    await waitUntil(async () => {
      const latest = await helloWorld.get(run._id);
      return latest?.status === 'done';
    }, 2000);

    const completed = await helloWorld.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.greeting).toBe('Hello, Vitest!');
    expect(completed?.context.timestamp).toBeInstanceOf(Date);

    helloWorld.shutdown();
  }, 10000);

  it('should generate correct greeting for different names', async () => {
    const run = await helloWorld.start({ name: 'Alice' });

    // Wait for autoExecute to complete
    await waitUntil(async () => {
      const latest = await helloWorld.get(run._id);
      return latest?.status === 'done';
    }, 2000);

    const completed = await helloWorld.get(run._id);
    expect(completed?.context.greeting).toBe('Hello, Alice!');

    helloWorld.shutdown();
  });
});
