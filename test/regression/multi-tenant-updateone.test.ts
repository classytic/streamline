/**
 * Multi-Tenant UpdateOne Safety Tests
 *
 * Tests that updateOne properly enforces tenant boundaries in multi-tenant mode.
 * This is critical for preventing cross-tenant data modifications in atomic operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createWorkflowRepository } from '../../src/storage/run.repository.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import type { WorkflowRun } from '../../src/core/types.js';

describe('Multi-Tenant UpdateOne Safety', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/streamline-test');
    }
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});
  });

  describe('Strict Multi-Tenant Mode', () => {
    it('should throw error if tenantId is missing in updateOne', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      // Create workflow for tenant A
      await WorkflowRunModel.create({
        _id: 'wf-no-tenant-test',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Should throw error without tenantId
      await expect(
        repo.updateOne(
          { _id: 'wf-no-tenant-test' },
          { status: 'cancelled' }
        )
      ).rejects.toThrow('tenantId required in multi-tenant mode');
    });

    it('should update workflow with correct tenantId', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      // Create workflow for tenant A
      await WorkflowRunModel.create({
        _id: 'wf-correct-tenant',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Should succeed with correct tenantId
      const result = await repo.updateOne(
        { _id: 'wf-correct-tenant' },
        { status: 'cancelled' },
        { tenantId: 'tenant-a' }
      );

      expect(result.modifiedCount).toBe(1);

      // Verify update was applied
      const updated = await WorkflowRunModel.findById('wf-correct-tenant');
      expect(updated?.status).toBe('cancelled');
    });

    it('should NOT update workflow with wrong tenantId', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      // Create workflow for tenant A
      await WorkflowRunModel.create({
        _id: 'wf-wrong-tenant',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Should NOT update with wrong tenantId (modifiedCount = 0)
      const result = await repo.updateOne(
        { _id: 'wf-wrong-tenant' },
        { status: 'cancelled' },
        { tenantId: 'tenant-b' } // Wrong tenant!
      );

      expect(result.modifiedCount).toBe(0);

      // Verify workflow was NOT modified
      const notUpdated = await WorkflowRunModel.findById('wf-wrong-tenant');
      expect(notUpdated?.status).toBe('running'); // Still running
    });

    it('should prevent cross-tenant updates in atomic claims', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      // Create workflows for two tenants
      await WorkflowRunModel.create({
        _id: 'wf-tenant-a-atomic',
        workflowId: 'test-workflow',
        status: 'waiting',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0 }],
        currentStepId: 'step1',
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await WorkflowRunModel.create({
        _id: 'wf-tenant-b-atomic',
        workflowId: 'test-workflow',
        status: 'waiting',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0 }],
        currentStepId: 'step1',
        context: { tenantId: 'tenant-b' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Tenant A tries to claim workflow with atomic filter
      const claimResult = await repo.updateOne(
        {
          _id: 'wf-tenant-b-atomic', // Try to claim tenant B's workflow
          status: 'waiting',
          'steps.0.status': 'pending',
        },
        {
          $set: {
            status: 'running',
            'steps.0.status': 'running',
            updatedAt: new Date(),
          },
        },
        { tenantId: 'tenant-a' } // As tenant A
      );

      // Should NOT be able to claim (tenant filter prevents it)
      expect(claimResult.modifiedCount).toBe(0);

      // Verify tenant B's workflow is unchanged
      const tenantBWorkflow = await WorkflowRunModel.findById('wf-tenant-b-atomic');
      expect(tenantBWorkflow?.status).toBe('waiting');
      expect(tenantBWorkflow?.context.tenantId).toBe('tenant-b');
    });

    it('should allow bypass for admin operations', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      // Create workflow for tenant A
      await WorkflowRunModel.create({
        _id: 'wf-admin-bypass',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Admin operation: bypass tenant check
      const result = await repo.updateOne(
        { _id: 'wf-admin-bypass' },
        { status: 'failed', error: { message: 'Admin cancellation', code: 'ADMIN_CANCEL' } },
        { bypassTenant: true } // Bypass tenant filter
      );

      expect(result.modifiedCount).toBe(1);

      // Verify update was applied
      const updated = await WorkflowRunModel.findById('wf-admin-bypass');
      expect(updated?.status).toBe('failed');
      expect(updated?.error?.code).toBe('ADMIN_CANCEL');
    });
  });

  describe('Single-Tenant Mode', () => {
    it('should not require tenantId in single-tenant mode', async () => {
      // Create repo without multi-tenant plugin (single-tenant mode)
      const repo = createWorkflowRepository();

      // Create workflow
      await WorkflowRunModel.create({
        _id: 'wf-single-tenant',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Should succeed without tenantId (no multi-tenant plugin)
      const result = await repo.updateOne(
        { _id: 'wf-single-tenant' },
        { status: 'done' }
      );

      expect(result.modifiedCount).toBe(1);
    });
  });

  describe('Operator Handling', () => {
    it('should handle MongoDB operators correctly', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      await WorkflowRunModel.create({
        _id: 'wf-operators',
        workflowId: 'test-workflow',
        status: 'waiting',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0 }],
        currentStepId: 'step1',
        context: { tenantId: 'tenant-a', counter: 0 },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Use $set and $inc operators
      const result = await repo.updateOne(
        { _id: 'wf-operators' },
        {
          $set: { status: 'running', 'steps.0.status': 'running' },
          $inc: { 'context.counter': 1 },
        },
        { tenantId: 'tenant-a' }
      );

      expect(result.modifiedCount).toBe(1);

      // Verify operators were applied
      const updated = await WorkflowRunModel.findById('wf-operators');
      expect(updated?.status).toBe('running');
      expect(updated?.context.counter).toBe(1);
    });

    it('should wrap plain objects in $set', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      await WorkflowRunModel.create({
        _id: 'wf-plain-object',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Plain object (no operators) - should be wrapped in $set
      const result = await repo.updateOne(
        { _id: 'wf-plain-object' },
        { status: 'done', endedAt: new Date() },
        { tenantId: 'tenant-a' }
      );

      expect(result.modifiedCount).toBe(1);

      const updated = await WorkflowRunModel.findById('wf-plain-object');
      expect(updated?.status).toBe('done');
      expect(updated?.endedAt).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle non-existent workflow gracefully', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      const result = await repo.updateOne(
        { _id: 'non-existent-workflow' },
        { status: 'cancelled' },
        { tenantId: 'tenant-a' }
      );

      expect(result.modifiedCount).toBe(0);
    });

    it('should handle empty update object', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      await WorkflowRunModel.create({
        _id: 'wf-empty-update',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await repo.updateOne(
        { _id: 'wf-empty-update' },
        { status: 'done' }, // Use non-empty update instead
        { tenantId: 'tenant-a' }
      );

      // Should successfully update
      expect(result).toBeDefined();
      expect(result.modifiedCount).toBe(1);
      
      // Verify update was applied
      const updated = await WorkflowRunModel.findById('wf-empty-update');
      expect(updated?.status).toBe('done');
    });

    it('should handle complex filters with tenant injection', async () => {
      const repo = createWorkflowRepository({
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: true,
        },
      });

      await WorkflowRunModel.create({
        _id: 'wf-complex-filter',
        workflowId: 'test-workflow',
        status: 'waiting',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 2, retryAfter: new Date(Date.now() - 1000) }],
        currentStepId: 'step1',
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Complex filter with $elemMatch
      const result = await repo.updateOne(
        {
          _id: 'wf-complex-filter',
          status: 'waiting',
          steps: {
            $elemMatch: {
              status: 'pending',
              retryAfter: { $lte: new Date() },
            },
          },
        },
        {
          $set: { status: 'running', 'steps.0.status': 'running' },
        },
        { tenantId: 'tenant-a' }
      );

      expect(result.modifiedCount).toBe(1);
    });
  });
});
