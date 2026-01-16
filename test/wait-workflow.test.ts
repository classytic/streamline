import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { approvalWorkflow } from '../docs/examples/wait-workflow.js';

describe('Wait Workflow', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/streamline_test');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('should wait for approval and resume', async () => {
    const run = await approvalWorkflow.start({
      request: 'Deploy to production',
      requestedBy: 'Alice',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const waiting = await approvalWorkflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.currentStepId).toBe('wait');

    const approval = {
      approved: true,
      approvedBy: 'Bob',
      reason: 'Looks good!',
    };

    await approvalWorkflow.resume(run._id, approval);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const completed = await approvalWorkflow.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.approval).toEqual(approval);

    approvalWorkflow.shutdown();
  }, 10000);

  it('should handle rejection', async () => {
    const run = await approvalWorkflow.start({
      request: 'Delete database',
      requestedBy: 'Mallory',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const rejection = {
      approved: false,
      approvedBy: 'Admin',
      reason: 'Too risky',
    };

    await approvalWorkflow.resume(run._id, rejection);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const completed = await approvalWorkflow.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.approval?.approved).toBe(false);

    approvalWorkflow.shutdown();
  });
});
