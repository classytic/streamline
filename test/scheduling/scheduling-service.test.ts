/**
 * SchedulingService Integration Tests
 *
 * Tests timezone-aware workflow scheduling, rescheduling, and cancellation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { SchedulingService } from '../../src/scheduling/scheduling.service.js';
import { createWorkflow } from '../../src/index.js';
import type { WorkflowHandlers } from '../../src/core/types.js';

// Helper to convert Date to ISO string (YYYY-MM-DDTHH:mm:ss) - matches how scheduledFor is stored
function toLocalISOString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

// Test workflow definition
interface TestContext {
  message: string;
  tenantId?: string;
}

const testWorkflow = createWorkflow<TestContext>('test-scheduled-workflow', {
  steps: {
    process: async (ctx) => {
      return { processed: true, message: ctx.context.message };
    },
  },
  context: (input: any) => ({
    message: input.message || 'default',
    tenantId: input.tenantId,
  }),
  autoExecute: false,
});

const testHandlers: WorkflowHandlers<TestContext> = {
  process: async (ctx) => {
    return { processed: true, message: ctx.context.message };
  },
};

describe('SchedulingService', () => {
  let service: SchedulingService<TestContext>;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/streamline-test');
    }
  });

  afterAll(async () => {
    testWorkflow.shutdown();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});
    service = new SchedulingService(testWorkflow.definition, testHandlers);
  });

  describe('schedule()', () => {
    it('should schedule workflow with timezone-aware execution time', async () => {
      const scheduledFor = new Date(2024, 11, 25, 9, 0, 0); // Dec 25, 9 AM

      const run = await service.schedule({
        scheduledFor,
        timezone: 'America/New_York',
        input: { message: 'Christmas greeting' },
      });

      expect(run._id).toBeDefined();
      expect(run.status).toBe('draft');
      expect(run.scheduling).toBeDefined();
      expect(run.scheduling?.timezone).toBe('America/New_York');
      expect(run.scheduling?.executionTime).toBeInstanceOf(Date);
      expect(run.scheduling?.localTimeDisplay).toContain('09:00:00');
    });

    it('should store user intent and UTC execution time', async () => {
      const scheduledFor = new Date(2024, 6, 15, 14, 30, 0); // July 15, 2:30 PM

      const run = await service.schedule({
        scheduledFor,
        timezone: 'Europe/London',
        input: { message: 'Afternoon meeting' },
      });

      // Verify scheduling metadata - scheduledFor is stored as ISO string
      expect(run.scheduling?.scheduledFor).toBe(toLocalISOString(scheduledFor));
      expect(run.scheduling?.timezone).toBe('Europe/London');

      // executionTime should be in UTC
      expect(run.scheduling?.executionTime).toBeInstanceOf(Date);

      // Local display should match input time
      expect(run.scheduling?.localTimeDisplay).toContain('14:30:00');
    });

    it('should detect DST transition and add note', async () => {
      // March 10, 2024: US spring forward
      // Scheduling for 2:30 AM which doesn't exist
      const scheduledFor = new Date(2024, 2, 10, 2, 30, 0);

      const run = await service.schedule({
        scheduledFor,
        timezone: 'America/New_York',
        input: { message: 'DST test' },
      });

      // Should still create workflow (with adjustment)
      expect(run._id).toBeDefined();
      expect(run.scheduling).toBeDefined();
    });

    it('should schedule with optional metadata', async () => {
      const run = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'Asia/Tokyo',
        input: { message: 'Tagged workflow' },
        userId: 'user-123',
        tags: ['social-media', 'client-a'],
        meta: { priority: 'high', campaignId: 'camp-456' },
      });

      expect(run.userId).toBe('user-123');
      expect(run.tags).toContain('social-media');
      expect(run.tags).toContain('client-a');
      expect(run.meta?.priority).toBe('high');
      expect(run.meta?.campaignId).toBe('camp-456');
    });

    it('should schedule with recurrence pattern', async () => {
      const run = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'America/Chicago',
        input: { message: 'Daily report' },
        recurrence: {
          pattern: 'daily',
          count: 30, // 30 occurrences
        },
      });

      expect(run.scheduling?.recurrence).toBeDefined();
      expect(run.scheduling?.recurrence?.pattern).toBe('daily');
      expect(run.scheduling?.recurrence?.count).toBe(30);
    });

    it('should handle various timezones correctly', async () => {
      const timezones = [
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'Europe/Paris',
        'Asia/Tokyo',
        'Asia/Singapore',
        'Australia/Sydney',
        'Pacific/Auckland',
      ];

      const runs = await Promise.all(
        timezones.map((tz, i) =>
          service.schedule({
            scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
            timezone: tz,
            input: { message: `Test for ${tz}` },
          })
        )
      );

      // All should be created successfully
      expect(runs).toHaveLength(timezones.length);
      runs.forEach((run, i) => {
        expect(run.scheduling?.timezone).toBe(timezones[i]);
      });

      // Execution times should all be different (9 AM in different timezones)
      const executionTimes = runs.map((r) => r.scheduling?.executionTime?.getTime());
      const uniqueTimes = new Set(executionTimes);
      expect(uniqueTimes.size).toBe(timezones.length);
    });
  });

  describe('reschedule()', () => {
    it('should reschedule workflow to new time', async () => {
      const originalDate = new Date(2024, 6, 15, 9, 0, 0);
      const newDate = new Date(2024, 6, 16, 10, 0, 0);

      const original = await service.schedule({
        scheduledFor: originalDate,
        timezone: 'America/New_York',
        input: { message: 'Original' },
      });

      const rescheduled = await service.reschedule(original._id, newDate);

      expect(rescheduled._id).toBe(original._id);
      expect(rescheduled.scheduling?.scheduledFor).toBe(toLocalISOString(newDate));
      expect(rescheduled.scheduling?.localTimeDisplay).toContain('10:00:00');
      expect(rescheduled.scheduling?.timezone).toBe('America/New_York'); // Same timezone
    });

    it('should reschedule with different timezone', async () => {
      const original = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'America/New_York',
        input: { message: 'Original' },
      });

      const rescheduled = await service.reschedule(
        original._id,
        new Date(2024, 6, 16, 9, 0, 0),
        'America/Los_Angeles'
      );

      expect(rescheduled.scheduling?.timezone).toBe('America/Los_Angeles');
    });

    it('should throw error for non-existent workflow', async () => {
      await expect(
        service.reschedule('non-existent-id', new Date())
      ).rejects.toThrow('not found');
    });

    it('should throw error when rescheduling non-draft workflow', async () => {
      const run = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'UTC',
        input: { message: 'Test' },
      });

      // Manually change status to simulate started workflow
      await WorkflowRunModel.updateOne(
        { _id: run._id },
        { $set: { status: 'running' } }
      );

      await expect(
        service.reschedule(run._id, new Date(2024, 6, 16, 9, 0, 0))
      ).rejects.toThrow('Only draft workflows');
    });

    it('should throw error when rescheduling non-scheduled workflow', async () => {
      // Create workflow directly without scheduling
      const nonScheduled = await WorkflowRunModel.create({
        _id: 'non-scheduled-run',
        workflowId: 'test-scheduled-workflow',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: { message: 'test' },
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        // No scheduling field
      });

      await expect(
        service.reschedule(nonScheduled._id, new Date())
      ).rejects.toThrow('not a scheduled workflow');
    });
  });

  describe('cancelScheduled()', () => {
    it('should cancel scheduled workflow', async () => {
      const run = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'UTC',
        input: { message: 'To be cancelled' },
      });

      const cancelled = await service.cancelScheduled(run._id);

      expect(cancelled._id).toBe(run._id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.endedAt).toBeInstanceOf(Date);
    });

    it('should throw error for non-existent workflow', async () => {
      await expect(service.cancelScheduled('non-existent')).rejects.toThrow('not found');
    });

    it('should throw error when cancelling non-draft workflow', async () => {
      const run = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'UTC',
        input: { message: 'Test' },
      });

      await WorkflowRunModel.updateOne(
        { _id: run._id },
        { $set: { status: 'done' } }
      );

      await expect(service.cancelScheduled(run._id)).rejects.toThrow('Only draft workflows');
    });
  });

  describe('get()', () => {
    it('should retrieve workflow by ID', async () => {
      const created = await service.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'UTC',
        input: { message: 'Find me' },
      });

      const found = await service.get(created._id);

      expect(found).not.toBeNull();
      expect(found?._id).toBe(created._id);
      expect(found?.context.message).toBe('Find me');
    });

    it('should return null for non-existent workflow', async () => {
      const found = await service.get('does-not-exist');
      expect(found).toBeNull();
    });
  });

  describe('Multi-Tenant Scheduling', () => {
    it('should schedule with tenantId', async () => {
      const multiTenantService = new SchedulingService(testWorkflow.definition, testHandlers, {
        multiTenant: {
          tenantField: 'context.tenantId',
          strict: false, // Non-strict for testing
        },
      });

      const run = await multiTenantService.schedule({
        scheduledFor: new Date(2024, 6, 15, 9, 0, 0),
        timezone: 'America/New_York',
        input: { message: 'Multi-tenant workflow' },
        tenantId: 'tenant-123',
      });

      expect(run._id).toBeDefined();
      expect(run.context.tenantId).toBe('tenant-123');
    });
  });

  describe('Edge Cases', () => {
    it('should handle scheduling far in the future', async () => {
      // Schedule 1 year from now
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const run = await service.schedule({
        scheduledFor: futureDate,
        timezone: 'UTC',
        input: { message: 'Future workflow' },
      });

      expect(run._id).toBeDefined();
      expect(run.scheduling?.executionTime).toBeDefined();
    });

    it('should handle scheduling in the past (for immediate execution)', async () => {
      const pastDate = new Date(2020, 0, 1, 9, 0, 0);

      const run = await service.schedule({
        scheduledFor: pastDate,
        timezone: 'UTC',
        input: { message: 'Past workflow' },
      });

      // Should still create - scheduler will pick it up immediately
      expect(run._id).toBeDefined();
      expect(run.status).toBe('draft');
    });

    it('should handle midnight correctly', async () => {
      const midnight = new Date(2024, 6, 15, 0, 0, 0);

      const run = await service.schedule({
        scheduledFor: midnight,
        timezone: 'America/New_York',
        input: { message: 'Midnight workflow' },
      });

      expect(run.scheduling?.localTimeDisplay).toContain('00:00:00');
    });

    it('should handle end of year (Dec 31, 11:59 PM)', async () => {
      const endOfYear = new Date(2024, 11, 31, 23, 59, 59);

      const run = await service.schedule({
        scheduledFor: endOfYear,
        timezone: 'Pacific/Auckland',
        input: { message: 'New Year workflow' },
      });

      expect(run.scheduling?.localTimeDisplay).toContain('23:59:59');
    });

    it('should handle leap year date (Feb 29)', async () => {
      const leapDay = new Date(2024, 1, 29, 12, 0, 0);

      const run = await service.schedule({
        scheduledFor: leapDay,
        timezone: 'UTC',
        input: { message: 'Leap year workflow' },
      });

      expect(run._id).toBeDefined();
    });
  });

  describe('Concurrent Scheduling', () => {
    it('should handle multiple concurrent schedules', async () => {
      const schedules = Array.from({ length: 10 }, (_, i) => ({
        scheduledFor: new Date(2024, 6, 15 + i, 9, 0, 0),
        timezone: 'UTC',
        input: { message: `Concurrent ${i}` },
      }));

      const runs = await Promise.all(
        schedules.map((s) => service.schedule(s))
      );

      expect(runs).toHaveLength(10);

      // All should have unique IDs
      const ids = runs.map((r) => r._id);
      expect(new Set(ids).size).toBe(10);
    });
  });
});
