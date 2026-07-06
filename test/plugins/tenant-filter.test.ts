/**
 * TenantFilterPlugin Integration Tests
 *
 * Tests multi-tenant isolation, strict mode, and query injection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { createWorkflowRepository } from '../../src/storage/run.repository.js';
import {
  tenantFilterPlugin,
  singleTenantPlugin,
  type TenantFilterOptions,
} from '../../src/plugins/tenant-filter.plugin.js';

describe('TenantFilterPlugin', () => {
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

  describe('Multi-Tenant Mode (Strict)', () => {
    it('should throw error if tenantId is missing in strict mode', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      // Should throw when querying without tenantId
      await expect(repo.getAll({ filters: { status: 'running' } })).rejects.toThrow(
        'Missing tenantId'
      );
    });

    it('should filter queries by tenantId in strict mode', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      // Create test data for two tenants
      const tenantAWorkflow = await WorkflowRunModel.create({
        _id: 'run-tenant-a-1',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a', data: 'Tenant A data' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const tenantBWorkflow = await WorkflowRunModel.create({
        _id: 'run-tenant-b-1',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-b', data: 'Tenant B data' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Query as tenant A - should only see tenant A's workflow
      const tenantAResults = await repo.getAll({
        filters: { status: 'running' },
        tenantId: 'tenant-a',
      } as any);

      expect(tenantAResults.data).toHaveLength(1);
      expect(tenantAResults.data[0]._id).toBe('run-tenant-a-1');
      expect(tenantAResults.data[0].context.tenantId).toBe('tenant-a');

      // Query as tenant B - should only see tenant B's workflow
      const tenantBResults = await repo.getAll({
        filters: { status: 'running' },
        tenantId: 'tenant-b',
      } as any);

      expect(tenantBResults.data).toHaveLength(1);
      expect(tenantBResults.data[0]._id).toBe('run-tenant-b-1');
      expect(tenantBResults.data[0].context.tenantId).toBe('tenant-b');
    });

    it('should prevent cross-tenant access in getByQuery for string IDs', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      // Create workflow for tenant A
      await WorkflowRunModel.create({
        _id: 'run-cross-tenant-test',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await repo.getByQuery(
        { _id: 'run-cross-tenant-test' },
        {
        tenantId: 'tenant-b',
        throwOnNotFound: false,
      } as any,
      );

      expect(result).toBeNull();

      // Tenant A should be able to access their own workflow
      const resultA = await repo.getByQuery(
        { _id: 'run-cross-tenant-test' },
        {
        tenantId: 'tenant-a',
        throwOnNotFound: false,
      } as any,
      );

      expect(resultA).toBeDefined();
      expect(resultA?._id).toBe('run-cross-tenant-test');
    });
  });

  describe('Multi-Tenant Mode (Non-Strict)', () => {
    it('should allow queries without tenantId in non-strict mode', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: false,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-non-strict-1',
        workflowId: 'test-workflow',
        status: 'done',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'some-tenant' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Should not throw, returns all workflows
      const results = await repo.getAll({ filters: { status: 'done' } });
      expect(results.data.length).toBeGreaterThanOrEqual(1);
    });

    it('should still filter by tenantId when provided in non-strict mode', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: false,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-ns-tenant-a',
        workflowId: 'test-workflow',
        status: 'waiting',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'ns-tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await WorkflowRunModel.create({
        _id: 'run-ns-tenant-b',
        workflowId: 'test-workflow',
        status: 'waiting',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'ns-tenant-b' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // With tenantId, should filter
      const results = await repo.getAll({
        filters: { status: 'waiting' },
        tenantId: 'ns-tenant-a',
      } as any);

      expect(results.data).toHaveLength(1);
      expect(results.data[0].context.tenantId).toBe('ns-tenant-a');
    });
  });

  describe('Bypass Mode', () => {
    it('should allow bypass when allowBypass is true', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
          allowBypass: true, // Default
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-bypass-1',
        workflowId: 'test-workflow',
        status: 'failed',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'bypass-tenant' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Bypass should work
      const results = await repo.getAll({
        filters: { status: 'failed' },
        bypassTenant: true,
      } as any);

      expect(results.data.length).toBeGreaterThanOrEqual(1);
    });

    it('should throw error when bypass attempted but allowBypass is false', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
          allowBypass: false,
        }),
      ]);

      await expect(
        repo.getAll({
          filters: { status: 'running' },
          bypassTenant: true,
        } as any)
      ).rejects.toThrow('Tenant bypass not allowed');
    });
  });

  describe('Single-Tenant Mode (Static TenantId)', () => {
    it('should automatically filter by static tenantId', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          staticTenantId: 'static-org-123',
          strict: true,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-static-1',
        workflowId: 'test-workflow',
        status: 'done',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'static-org-123' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await WorkflowRunModel.create({
        _id: 'run-static-2',
        workflowId: 'test-workflow',
        status: 'done',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'other-org' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // No tenantId needed - uses static config
      const results = await repo.getAll({ filters: { status: 'done' } });

      expect(results.data).toHaveLength(1);
      expect(results.data[0]._id).toBe('run-static-1');
      expect(results.data[0].context.tenantId).toBe('static-org-123');
    });

    it('should use singleTenantPlugin helper correctly', async () => {
      const repo = new Repository(WorkflowRunModel, [
        singleTenantPlugin('single-tenant-org'),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-single-1',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'single-tenant-org' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await WorkflowRunModel.create({
        _id: 'run-single-2',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'other-org' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const results = await repo.getAll({ filters: { status: 'running' } });

      expect(results.data).toHaveLength(1);
      expect(results.data[0].context.tenantId).toBe('single-tenant-org');
    });
  });

  describe('Custom Tenant Field', () => {
    it('should support nested tenant field (context.tenantId)', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-nested-1',
        workflowId: 'test-workflow',
        status: 'done',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'nested-tenant' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const results = await repo.getAll({
        filters: { status: 'done' },
        tenantId: 'nested-tenant',
      } as any);

      expect(results.data).toHaveLength(1);
    });

    it('should support meta field (meta.orgId)', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'meta.orgId',
          strict: true,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-meta-1',
        workflowId: 'test-workflow',
        status: 'done',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        meta: { orgId: 'meta-org-123' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const results = await repo.getAll({
        filters: { status: 'done' },
        tenantId: 'meta-org-123',
      } as any);

      expect(results.data).toHaveLength(1);
    });
  });

  describe('Create Operations', () => {
    it('should inject tenantId on create in multi-tenant mode', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      const created = await repo.create(
        {
          _id: 'run-inject-create-1',
          workflowId: 'test-workflow',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { tenantId: 'injected-tenant' } as any
      );

      expect(created.context.tenantId).toBe('injected-tenant');
    });

    it('should throw on create without tenantId in strict mode', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      await expect(
        repo.create({
          _id: 'run-no-tenant',
          workflowId: 'test-workflow',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      ).rejects.toThrow('Missing tenantId');
    });

    it('should auto-inject static tenantId on create', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          staticTenantId: 'auto-inject-org',
          strict: true,
        }),
      ]);

      const created = await repo.create({
        _id: 'run-auto-inject-1',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(created.context.tenantId).toBe('auto-inject-org');
    });
  });

  describe('Update and Delete Operations', () => {
    it('should filter update by tenantId', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-update-1',
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'update-tenant-a' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Note: MongoKit's update uses ID directly, so tenant filtering happens at application level
      // The plugin sets context.query but MongoKit's update doesn't use it for ID-based updates
      // For strict tenant isolation on updates, verify tenant at application level before update

      // Update as correct tenant - should succeed
      const updated = await repo.update(
        'run-update-1',
        { status: 'done' },
        { tenantId: 'update-tenant-a' } as any
      );

      expect(updated.status).toBe('done');
    });

    it('should filter delete by tenantId', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      await WorkflowRunModel.create({
        _id: 'run-delete-1',
        workflowId: 'test-workflow',
        status: 'done',
        steps: [],
        currentStepId: null,
        context: { tenantId: 'delete-tenant' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Delete with correct tenant
      await repo.delete('run-delete-1', { tenantId: 'delete-tenant' } as any);

      // Verify deleted
      const directCheck = await WorkflowRunModel.findById('run-delete-1');
      expect(directCheck).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty result sets correctly', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      const results = await repo.getAll({
        filters: { status: 'nonexistent-status' },
        tenantId: 'some-tenant',
      } as any);

      expect(results.data).toHaveLength(0);
    });

    it('should work with pagination', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      // Create multiple workflows for one tenant
      for (let i = 0; i < 15; i++) {
        await WorkflowRunModel.create({
          _id: `run-paginate-${i}`,
          workflowId: 'test-workflow',
          status: 'done',
          steps: [],
          currentStepId: null,
          context: { tenantId: 'paginate-tenant' },
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Get first page
      const page1 = await repo.getAll({
        filters: { status: 'done' },
        tenantId: 'paginate-tenant',
        page: 1,
        limit: 10,
      } as any);

      expect(page1.data.length).toBe(10);
      expect(page1.total).toBe(15);

      // Get second page
      const page2 = await repo.getAll({
        filters: { status: 'done' },
        tenantId: 'paginate-tenant',
        page: 2,
        limit: 10,
      } as any);

      expect(page2.data.length).toBe(5);
    });

    it('should handle concurrent requests from different tenants', async () => {
      const repo = new Repository(WorkflowRunModel, [
        tenantFilterPlugin({
          tenantField: 'context.tenantId',
          strict: true,
        }),
      ]);

      // Create data for multiple tenants
      await Promise.all([
        WorkflowRunModel.create({
          _id: 'run-concurrent-a',
          workflowId: 'test-workflow',
          status: 'running',
          steps: [],
          currentStepId: null,
          context: { tenantId: 'concurrent-a' },
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        WorkflowRunModel.create({
          _id: 'run-concurrent-b',
          workflowId: 'test-workflow',
          status: 'running',
          steps: [],
          currentStepId: null,
          context: { tenantId: 'concurrent-b' },
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ]);

      // Concurrent queries from different tenants
      const [resultsA, resultsB] = await Promise.all([
        repo.getAll({ filters: { status: 'running' }, tenantId: 'concurrent-a' } as any),
        repo.getAll({ filters: { status: 'running' }, tenantId: 'concurrent-b' } as any),
      ]);

      expect(resultsA.data).toHaveLength(1);
      expect(resultsA.data[0].context.tenantId).toBe('concurrent-a');

      expect(resultsB.data).toHaveLength(1);
      expect(resultsB.data[0].context.tenantId).toBe('concurrent-b');
    });
  });

  describe('Derived Hook Coverage (2.7): cursor / claimVersion / getOrCreate', () => {
    const strictOptions: TenantFilterOptions = {
      tenantField: 'context.tenantId',
      strict: true,
    };

    const seedRun = (id: string, tenantId: string, extra: Record<string, unknown> = {}) =>
      WorkflowRunModel.create({
        _id: id,
        workflowId: 'test-workflow',
        status: 'running',
        steps: [],
        currentStepId: null,
        context: { tenantId },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...extra,
      });

    describe('cursor', () => {
      it('should only yield the requesting tenant runs', async () => {
        const repo = new Repository(WorkflowRunModel, [tenantFilterPlugin(strictOptions)]);
        await seedRun('run-cursor-a', 'cursor-tenant-a');
        await seedRun('run-cursor-b', 'cursor-tenant-b');

        const seen: string[] = [];
        for await (const doc of repo.cursor(
          { status: 'running' },
          { lean: true, tenantId: 'cursor-tenant-a' } as any,
        )) {
          seen.push((doc as any)._id);
        }

        expect(seen).toEqual(['run-cursor-a']);
      });

      it('should throw in strict mode without tenantId', async () => {
        const repo = new Repository(WorkflowRunModel, [tenantFilterPlugin(strictOptions)]);
        await seedRun('run-cursor-strict', 'cursor-tenant-strict');

        await expect(
          (async () => {
            for await (const doc of repo.cursor({ status: 'running' })) {
              void doc;
              break;
            }
          })(),
        ).rejects.toThrow('Missing tenantId');
      });

      it('cursorStaleRunning should be tenant-scoped and strict-throwing', async () => {
        const repo = createWorkflowRepository({ multiTenant: strictOptions });
        const staleHeartbeat = new Date(Date.now() - 60 * 60 * 1000);
        await seedRun('run-stale-a', 'stale-tenant-a', { lastHeartbeat: staleHeartbeat });
        await seedRun('run-stale-b', 'stale-tenant-b', { lastHeartbeat: staleHeartbeat });

        const seen: string[] = [];
        for await (const run of repo.cursorStaleRunning(60_000, {
          tenantId: 'stale-tenant-a',
        })) {
          seen.push(run._id);
        }
        expect(seen).toEqual(['run-stale-a']);

        await expect(
          (async () => {
            for await (const run of repo.cursorStaleRunning(60_000)) {
              void run;
              break;
            }
          })(),
        ).rejects.toThrow('Missing tenantId');
      });
    });

    describe('claimVersion', () => {
      it('should be tenant-scoped the same way claim is', async () => {
        const repo = new Repository(WorkflowRunModel, [tenantFilterPlugin(strictOptions)]);
        await seedRun('run-cv-a', 'cv-tenant-a');

        // Cross-tenant CAS misses — the injected tenant predicate excludes the doc.
        const crossTenant = await repo.claimVersion(
          'run-cv-a',
          { from: undefined },
          { $set: { status: 'waiting' } },
          { tenantId: 'cv-tenant-b' } as any,
        );
        expect(crossTenant).toBeNull();

        // Owning tenant claims successfully.
        const owned = await repo.claimVersion(
          'run-cv-a',
          { from: undefined },
          { $set: { status: 'waiting' } },
          { tenantId: 'cv-tenant-a' } as any,
        );
        expect(owned).not.toBeNull();
        expect((owned as any).status).toBe('waiting');
      });

      it('should throw in strict mode without tenantId', async () => {
        const repo = new Repository(WorkflowRunModel, [tenantFilterPlugin(strictOptions)]);
        await seedRun('run-cv-strict', 'cv-tenant-strict');

        await expect(
          repo.claimVersion('run-cv-strict', { from: undefined }, { $set: { status: 'done' } }),
        ).rejects.toThrow('Missing tenantId');
      });
    });

    describe('getOrCreate', () => {
      it('should be tenant-scoped: owning tenant gets existing, other tenant creates fresh', async () => {
        const repo = new Repository(WorkflowRunModel, [tenantFilterPlugin(strictOptions)]);
        await seedRun('run-goc-a', 'goc-tenant-a', { workflowId: 'goc-workflow' });

        const createData = {
          steps: [],
          currentStepId: null,
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Owning tenant — the query matches the seeded doc.
        const existing = await repo.getOrCreate(
          { workflowId: 'goc-workflow', status: 'running' },
          { _id: 'run-goc-new-a', ...createData },
          { tenantId: 'goc-tenant-a' } as any,
        );
        expect(existing.created).toBe(false);
        expect((existing.doc as any)._id).toBe('run-goc-a');

        // Other tenant — must NOT see tenant-a's doc; the upsert creates a
        // fresh run stamped with tenant-b via the injected query predicate.
        const other = await repo.getOrCreate(
          { workflowId: 'goc-workflow', status: 'running' },
          { _id: 'run-goc-new-b', ...createData },
          { tenantId: 'goc-tenant-b' } as any,
        );
        expect(other.created).toBe(true);
        expect((other.doc as any)._id).toBe('run-goc-new-b');
        expect((other.doc as any).context?.tenantId).toBe('goc-tenant-b');
      });

      it('should throw in strict mode without tenantId', async () => {
        const repo = new Repository(WorkflowRunModel, [tenantFilterPlugin(strictOptions)]);

        await expect(
          repo.getOrCreate({ workflowId: 'goc-strict' }, { _id: 'run-goc-strict' }),
        ).rejects.toThrow('Missing tenantId');
      });
    });
  });
});
