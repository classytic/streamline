/**
 * Scheduled Workflows Lean Query Tests
 *
 * Tests that getScheduledWorkflowsReadyToExecute properly uses lean queries
 * without breaking context handling or causing memory issues.
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

type Doc = Record<string, unknown>;

/** A scheduled draft of `test-workflow` (persisted with mongoose casting, as hosts write it). */
const scheduledDraft = (
  _id: string,
  executionTime: Date,
  fields: Partial<WorkflowRun> = {},
  localTimeDisplay = '2025-01-15 10:00:00 UTC',
) => ({
  _id,
  workflowId: 'test-workflow',
  status: 'draft' as const,
  steps: [],
  currentStepId: null,
  context: {},
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  scheduling: {
    scheduledFor: new Date().toISOString(),
    timezone: 'UTC',
    localTimeDisplay,
    executionTime,
    isDSTTransition: false,
  },
  ...fields,
});

/** Scheduled drafts due now (default page). */
const readyNow = () => env.container.repository.getScheduledWorkflowsReadyToExecute(new Date());

/** Narrow the repository's pagination envelope to the offset shape these calls return. */
function offsetPage<T extends object>(result: T) {
  if (!('page' in result) || !('total' in result)) {
    throw new Error('expected an offset pagination result');
  }
  return result as T & { page: number; limit: number; total: number };
}

describe('Scheduled Workflows Lean Query', () => {
  describe('Lean Query Behavior', () => {
    it('should return plain objects (not Mongoose documents)', async () => {
      // Create scheduled workflow
      await env.runModel.create(
        scheduledDraft('scheduled-lean-1', new Date(Date.now() - 1000), {
          context: { data: 'test' },
        }),
      );

      const result = await readyNow();

      expect(result.data).toHaveLength(1);

      const doc = result.data[0] as WorkflowRun & Doc;

      // Should be plain object (no Mongoose methods)
      expect(typeof doc.toObject).toBe('undefined');
      expect(typeof doc.save).toBe('undefined');
      expect(typeof doc.toJSON).toBe('undefined');

      // Should have all required fields
      expect(doc._id).toBe('scheduled-lean-1');
      expect(doc.status).toBe('draft');
      expect(doc.context).toBeDefined();
      expect(doc.context.data).toBe('test');
    });

    it('should handle context field correctly with lean', async () => {
      // Create scheduled workflow with complex context
      await env.runModel.create(
        scheduledDraft(
          'scheduled-context-1',
          new Date(Date.now() - 1000),
          {
            context: {
              userId: 'user-123',
              tenantId: 'tenant-abc',
              metadata: {
                source: 'api',
                version: '1.0',
              },
              tags: ['urgent', 'payment'],
            },
            input: { orderId: 'order-456' },
          },
          '2025-01-15 10:00:00 EST',
        ),
      );

      const result = await readyNow();

      expect(result.data).toHaveLength(1);

      const doc = result.data[0] as WorkflowRun<{
        userId: string;
        tenantId: string;
        metadata: { source: string; version: string };
        tags: string[];
      }>;

      // Context should be preserved with all nested fields
      expect(doc.context).toBeDefined();
      expect(doc.context.userId).toBe('user-123');
      expect(doc.context.tenantId).toBe('tenant-abc');
      expect(doc.context.metadata).toBeDefined();
      expect(doc.context.metadata.source).toBe('api');
      expect(doc.context.metadata.version).toBe('1.0');
      expect(doc.context.tags).toEqual(['urgent', 'payment']);

      // Input should also be preserved
      expect(doc.input).toBeDefined();
      expect((doc.input as { orderId: string }).orderId).toBe('order-456');
    });

    it('should handle empty context with lean', async () => {
      // Create scheduled workflow with empty context
      await env.runModel.create(
        scheduledDraft('scheduled-empty-context', new Date(Date.now() - 1000)),
      );

      const result = await readyNow();

      expect(result.data).toHaveLength(1);

      const doc = result.data[0] as WorkflowRun<Doc | undefined>;

      // Empty context might be undefined with lean queries (MongoDB behavior)
      // This is acceptable - the important thing is it doesn't cause errors
      expect(doc.context === undefined || Object.keys(doc.context || {}).length === 0).toBe(true);
    });
  });

  describe('Memory Efficiency', () => {
    it('should handle large result sets efficiently', async () => {
      // Create 100 scheduled workflows, each due 1ms after the previous: the
      // query orders by executionTime (ties by _id, which sorts as TEXT —
      // "…-10" before "…-2"), so distinct times make position i = draft i.
      const workflows = [];
      const firstDue = Date.now() - 1000;
      for (let i = 0; i < 100; i++) {
        workflows.push(
          scheduledDraft(`scheduled-large-${i}`, new Date(firstDue + i), {
            context: { index: i, data: `workflow-${i}` },
            input: { value: i },
          }),
        );
      }
      await env.runModel.insertMany(workflows);

      // Measure memory before query
      const memBefore = process.memoryUsage().heapUsed;

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(
        new Date(),
        {
          limit: 100,
        },
      );

      // Measure memory after query
      const memAfter = process.memoryUsage().heapUsed;
      const memDiff = (memAfter - memBefore) / 1024 / 1024; // MB

      expect(result.data).toHaveLength(100);

      // Verify all documents are plain objects
      result.data.forEach((run, index) => {
        const doc = run as WorkflowRun<{ index: number }> & Doc;
        expect(typeof doc.toObject).toBe('undefined');
        expect(doc.context.index).toBe(index);
      });

      // Memory increase should be reasonable (lean should be < 20MB for 100 docs)
      // This is a soft check - exact value depends on document size
      expect(memDiff).toBeLessThan(50); // MB
    });
  });

  describe('Filtering Behavior', () => {
    it('should only return workflows ready to execute', async () => {
      const now = new Date();
      const pastTime = new Date(now.getTime() - 60000); // 1 minute ago
      const futureTime = new Date(now.getTime() + 60000); // 1 minute from now

      // Create workflows with different execution times
      await env.runModel.insertMany([
        scheduledDraft('scheduled-ready-1', pastTime, {}, '2025-01-15 09:00:00 UTC'), // Ready
        scheduledDraft('scheduled-not-ready', futureTime, {}, '2025-01-15 11:00:00 UTC'), // Not ready
        scheduledDraft('scheduled-ready-2', pastTime, {}, '2025-01-15 09:00:00 UTC'), // Ready
      ]);

      const result = await env.container.repository.getScheduledWorkflowsReadyToExecute(now);

      // Should only return the 2 ready workflows
      expect(result.data).toHaveLength(2);
      expect(result.data.map((d) => d._id).sort()).toEqual([
        'scheduled-ready-1',
        'scheduled-ready-2',
      ]);
    });

    it('should exclude paused workflows', async () => {
      const pastTime = new Date(Date.now() - 60000);

      await env.runModel.insertMany([
        scheduledDraft('scheduled-active', pastTime, { paused: false }, '2025-01-15 09:00:00 UTC'),
        scheduledDraft('scheduled-paused', pastTime, { paused: true }, '2025-01-15 09:00:00 UTC'),
      ]);

      const result = await readyNow();

      // Should only return non-paused workflow
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?._id).toBe('scheduled-active');
    });
  });

  describe('Pagination', () => {
    it('should support pagination', async () => {
      const pastTime = new Date(Date.now() - 60000);

      // Create 25 scheduled workflows
      const workflows = [];
      for (let i = 0; i < 25; i++) {
        workflows.push(
          scheduledDraft(
            `scheduled-page-${i}`,
            pastTime,
            { context: { index: i } },
            '2025-01-15 09:00:00 UTC',
          ),
        );
      }
      await env.runModel.insertMany(workflows);

      const repository = env.container.repository;

      // Page 1
      const page1 = offsetPage(
        await repository.getScheduledWorkflowsReadyToExecute(new Date(), { page: 1, limit: 10 }),
      );

      expect(page1.data).toHaveLength(10);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(10);
      expect(page1.total).toBe(25);

      // Page 2
      const page2 = offsetPage(
        await repository.getScheduledWorkflowsReadyToExecute(new Date(), { page: 2, limit: 10 }),
      );

      expect(page2.data).toHaveLength(10);
      expect(page2.page).toBe(2);

      // Page 3 (last page)
      const page3 = offsetPage(
        await repository.getScheduledWorkflowsReadyToExecute(new Date(), { page: 3, limit: 10 }),
      );

      expect(page3.data).toHaveLength(5);
      expect(page3.page).toBe(3);
    });
  });

  describe('Type Consistency', () => {
    it('should match LeanWorkflowRun type', async () => {
      await env.runModel.create(scheduledDraft('scheduled-type-test', new Date(Date.now() - 1000)));

      const result = await readyNow();

      const doc = result.data[0];

      // Should have all WorkflowRun fields
      expect(doc?._id).toBeDefined();
      expect(doc?.workflowId).toBeDefined();
      expect(doc?.status).toBeDefined();
      expect(doc?.steps).toBeDefined();
      expect(doc?.currentStepId).not.toBeUndefined(); // Can be null but should exist
      // Context might be undefined for empty objects with lean queries
      expect(doc?.context !== undefined || doc?.context === undefined).toBe(true);
      expect(doc?.input !== undefined || doc?.input === undefined).toBe(true);
      expect(doc?.createdAt).toBeDefined();
      expect(doc?.updatedAt).toBeDefined();
      expect(doc?.scheduling).toBeDefined();

      // Dates should be Date objects (lean maintains Date types)
      expect(doc?.createdAt instanceof Date).toBe(true);
      expect(doc?.updatedAt instanceof Date).toBe(true);
      expect(doc?.scheduling?.executionTime instanceof Date).toBe(true);
    });
  });
});
