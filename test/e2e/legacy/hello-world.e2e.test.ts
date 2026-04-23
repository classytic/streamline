import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDB, waitUntil } from '../../utils/setup.js';
import { helloWorld } from '../../../docs/examples/hello-world.js';

describe('Hello World Workflow', () => {
  beforeAll(setupTestDB);

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
