/**
 * LEGACY SETUP (global connection) on purpose: the subject is the exported
 * `approvalWorkflow` docs example, a module-level singleton created without a
 * container — bound to the default mongoose connection by construction.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorkflow } from '../../../docs/examples/wait-workflow.js';
import { setupTestDB, waitUntil } from '../../utils/setup.js';

const statusIs = (runId: string, status: string) => () =>
  approvalWorkflow.get(runId).then((r) => r?.status === status);

describe('Wait Workflow', () => {
  beforeAll(setupTestDB);

  it('should wait for approval and resume', async () => {
    const run = await approvalWorkflow.start({
      request: 'Deploy to production',
      requestedBy: 'Alice',
    });

    await waitUntil(statusIs(run._id, 'waiting'), 5000, 20);

    const waiting = await approvalWorkflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.currentStepId).toBe('wait');

    const approval = {
      approved: true,
      approvedBy: 'Bob',
      reason: 'Looks good!',
    };

    await approvalWorkflow.resume(run._id, approval);
    await waitUntil(statusIs(run._id, 'done'), 5000, 20);

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

    await waitUntil(statusIs(run._id, 'waiting'), 5000, 20);

    const rejection = {
      approved: false,
      approvedBy: 'Admin',
      reason: 'Too risky',
    };

    await approvalWorkflow.resume(run._id, rejection);
    await waitUntil(statusIs(run._id, 'done'), 5000, 20);

    const completed = await approvalWorkflow.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.approval?.approved).toBe(false);

    approvalWorkflow.shutdown();
  });
});
