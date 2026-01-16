/**
 * Critical Engine Fixes - Regression Tests
 *
 * Tests to verify the following critical fixes:
 * 1. Scheduled workflows have properly initialized steps (not empty)
 * 2. Atomic claim for scheduled workflow execution (race condition prevention)
 * 3. getScheduled() supports executionTimeRange and recurring filters
 * 4. Step context includes AbortSignal for timeout cancellation
 * 5. Step interface includes parallel/conditional properties
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import { workflowRunRepository } from '../../src/storage/run.repository.js';
import { SchedulingService } from '../../src/scheduling/scheduling.service.js';
import { createWorkflow, WorkflowEngine, createContainer } from '../../src/index.js';
import type { Step, StepContext } from '../../src/core/types.js';

// Track workflows for cleanup
const createdWorkflows: { shutdown: () => void }[] = [];

describe('Critical Engine Fixes', () => {
  // Test workflow definition using createWorkflow
  const workflow = createWorkflow<{ result?: string; signalReceived?: boolean }>('test-critical-fixes', {
    steps: {
      step1: async (ctx) => {
        await ctx.set('result', 'step1-done');
        return 'step1-output';
      },
      step2: async (ctx) => {
        // Verify AbortSignal is available
        await ctx.set('signalReceived', ctx.signal instanceof AbortSignal);
        return 'step2-output';
      },
      step3: async () => 'step3-output',
    },
    context: () => ({}),
    version: '1.0.0',
    autoExecute: false,
  });

  // Handlers for SchedulingService tests (separate from workflow)
  const handlers = {
    step1: async (ctx: StepContext<any>) => {
      await ctx.set('result', 'step1-done');
      return 'step1-output';
    },
    step2: async (ctx: StepContext<any>) => {
      // Verify AbortSignal is available
      await ctx.set('signalReceived', ctx.signal instanceof AbortSignal);
      return 'step2-output';
    },
    step3: async () => 'step3-output',
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_URI || 'mongodb://localhost:27017/streamline-test'
      );
    }
  });

  afterAll(async () => {
    // Shutdown all workflows first to stop background processes
    createdWorkflows.forEach((w) => w.shutdown());
    workflow.shutdown();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});
    createdWorkflows.length = 0;
  });

  describe('Fix 1: Scheduled Workflows Step Initialization', () => {
    it('should create scheduled workflow with properly initialized steps', async () => {
      const service = new SchedulingService(workflow.definition, handlers);
      const futureTime = new Date(Date.now() + 60000);

      const run = await service.schedule({
        scheduledFor: futureTime,
        timezone: 'UTC',
        input: { foo: 'bar' },
      });

      // Steps should be initialized from workflow definition
      expect(run.steps).toHaveLength(3);
      expect(run.steps[0].stepId).toBe('step1');
      expect(run.steps[0].status).toBe('pending');
      expect(run.steps[0].attempts).toBe(0);
      expect(run.steps[1].stepId).toBe('step2');
      expect(run.steps[2].stepId).toBe('step3');

      // currentStepId should be set to first step
      expect(run.currentStepId).toBe('step1');

      // Status should be draft (scheduled, not yet executed)
      expect(run.status).toBe('draft');
    });

    it('should initialize context using workflow createContext function', async () => {
      const workflowWithContext = createWorkflow<{ initialized: boolean; input: any }>('test-context-init', {
        steps: {
          step1: async () => 'done',
        },
        context: (input) => ({ initialized: true, input }),
        version: '1.0.0',
        autoExecute: false,
      });
      createdWorkflows.push(workflowWithContext);

      const service = new SchedulingService(workflowWithContext.definition, {
        step1: async () => 'done',
      });

      const run = await service.schedule({
        scheduledFor: new Date(Date.now() + 60000),
        timezone: 'UTC',
        input: { testData: 123 },
      });

      expect(run.context.initialized).toBe(true);
      expect(run.context.input).toEqual({ testData: 123 });
    });
  });

  describe('Fix 2: Atomic Claim for Scheduled Workflows', () => {
    it('should only allow one scheduler to claim a scheduled workflow', async () => {
      const pastTime = new Date(Date.now() - 1000);

      // Create a scheduled workflow ready to execute
      await WorkflowRunModel.create({
        _id: 'atomic-claim-test',
        workflowId: 'test-workflow',
        status: 'draft',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0 }],
        currentStepId: 'step1',
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        scheduling: {
          scheduledFor: pastTime,
          timezone: 'UTC',
          localTimeDisplay: 'test',
          executionTime: pastTime,
          isDSTTransition: false,
        },
      });

      // Simulate two schedulers trying to claim the same workflow
      const now = new Date();

      // First claim should succeed
      const claim1 = await workflowRunRepository.updateOne(
        {
          _id: 'atomic-claim-test',
          status: 'draft',
          'scheduling.executionTime': { $lte: now },
        },
        {
          status: 'running',
          startedAt: now,
          updatedAt: now,
        }
      );

      // Second claim should fail (workflow already claimed)
      const claim2 = await workflowRunRepository.updateOne(
        {
          _id: 'atomic-claim-test',
          status: 'draft', // This condition will fail - already 'running'
          'scheduling.executionTime': { $lte: now },
        },
        {
          status: 'running',
          startedAt: now,
          updatedAt: now,
        }
      );

      expect(claim1.modifiedCount).toBe(1);
      expect(claim2.modifiedCount).toBe(0);

      // Verify workflow is now running
      const workflowRun = await WorkflowRunModel.findById('atomic-claim-test');
      expect(workflowRun?.status).toBe('running');
    });
  });

  describe('Fix 3: getScheduled() Filter Support', () => {
    beforeEach(async () => {
      // Create test workflows with different execution times
      const baseDate = new Date('2024-06-15T12:00:00Z');

      await WorkflowRunModel.create([
        {
          _id: 'scheduled-early',
          workflowId: 'test',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          scheduling: {
            scheduledFor: new Date('2024-06-10T10:00:00Z'),
            timezone: 'UTC',
            localTimeDisplay: 'test',
            executionTime: new Date('2024-06-10T10:00:00Z'),
            isDSTTransition: false,
          },
        },
        {
          _id: 'scheduled-mid',
          workflowId: 'test',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          scheduling: {
            scheduledFor: new Date('2024-06-15T10:00:00Z'),
            timezone: 'UTC',
            localTimeDisplay: 'test',
            executionTime: new Date('2024-06-15T10:00:00Z'),
            isDSTTransition: false,
          },
        },
        {
          _id: 'scheduled-late',
          workflowId: 'test',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          scheduling: {
            scheduledFor: new Date('2024-06-20T10:00:00Z'),
            timezone: 'UTC',
            localTimeDisplay: 'test',
            executionTime: new Date('2024-06-20T10:00:00Z'),
            isDSTTransition: false,
          },
        },
        {
          _id: 'scheduled-recurring',
          workflowId: 'test',
          status: 'draft',
          steps: [],
          currentStepId: null,
          context: {},
          input: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          scheduling: {
            scheduledFor: new Date('2024-06-15T10:00:00Z'),
            timezone: 'UTC',
            localTimeDisplay: 'test',
            executionTime: new Date('2024-06-15T10:00:00Z'),
            isDSTTransition: false,
            recurrence: { pattern: 'daily' },
          },
        },
      ]);
    });

    it('should filter by executionTimeRange', async () => {
      const service = new SchedulingService(workflow.definition, handlers);

      const result = await service.getScheduled({
        executionTimeRange: {
          from: new Date('2024-06-14T00:00:00Z'),
          to: new Date('2024-06-16T23:59:59Z'),
        },
      });

      // Should only return workflows in the range (mid and recurring)
      expect(result.docs).toHaveLength(2);
      const ids = result.docs.map((d: any) => d._id);
      expect(ids).toContain('scheduled-mid');
      expect(ids).toContain('scheduled-recurring');
      expect(ids).not.toContain('scheduled-early');
      expect(ids).not.toContain('scheduled-late');
    });

    it('should filter by recurring=true', async () => {
      const service = new SchedulingService(workflow.definition, handlers);

      const result = await service.getScheduled({
        recurring: true,
      });

      // Should only return recurring workflows
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0]._id).toBe('scheduled-recurring');
    });

    it('should filter by recurring=false', async () => {
      const service = new SchedulingService(workflow.definition, handlers);

      const result = await service.getScheduled({
        recurring: false,
      });

      // Should only return non-recurring workflows
      expect(result.docs).toHaveLength(3);
      const ids = result.docs.map((d: any) => d._id);
      expect(ids).not.toContain('scheduled-recurring');
    });
  });

  describe('Fix 4: AbortSignal in StepContext', () => {
    it('should provide AbortSignal to step handlers', async () => {
      const run = await workflow.start({ test: true });
      await workflow.execute(run._id);

      const result = await workflow.get(run._id);

      // step2 handler sets signalReceived based on whether ctx.signal is an AbortSignal
      expect(result?.context.signalReceived).toBe(true);
    });

    it('should abort signal on timeout', async () => {
      let signalAborted = false;
      let abortReason: any = null;

      const timeoutWorkflow = createWorkflow<{}>('timeout-test', {
        steps: {
          slow: async (ctx) => {
            ctx.signal.addEventListener('abort', () => {
              signalAborted = true;
              abortReason = ctx.signal.reason;
            });

            // Wait longer than timeout
            await new Promise((resolve) => setTimeout(resolve, 500));
            return 'should not reach';
          },
        },
        context: () => ({}),
        version: '1.0.0',
        autoExecute: false,
      });
      createdWorkflows.push(timeoutWorkflow);

      // Access the engine to set step timeout (since createWorkflow doesn't support per-step timeout in steps object)
      // We need to use the engine directly with a modified definition
      const timeoutDefinition = {
        ...timeoutWorkflow.definition,
        steps: [{ id: 'slow', name: 'Slow Step', timeout: 100 }], // 100ms timeout
      };

      const engine = new WorkflowEngine(timeoutDefinition, {
        slow: async (ctx: StepContext<unknown>) => {
          ctx.signal.addEventListener('abort', () => {
            signalAborted = true;
            abortReason = ctx.signal.reason;
          });

          // Wait longer than timeout
          await new Promise((resolve) => setTimeout(resolve, 500));
          return 'should not reach';
        },
      }, createContainer(), {
        autoExecute: false,
      });
      createdWorkflows.push({ shutdown: () => engine.shutdown() });

      const run = await engine.start({});

      // Execute should fail with timeout
      try {
        await engine.execute(run._id);
      } catch {
        // Expected to throw
      }

      // Give time for abort event to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(signalAborted).toBe(true);
      expect(abortReason?.message).toContain('timeout');
    });
  });

  describe('Fix 5: Step Interface with Conditional Properties', () => {
    it('should accept condition property in Step definition', () => {
      const conditionalStep: Step = {
        id: 'conditional-test',
        name: 'Conditional Test',
        condition: (ctx, run) => ctx.shouldRun === true,
      };

      expect(typeof conditionalStep.condition).toBe('function');
    });

    it('should accept skipIf property in Step definition', () => {
      const skipStep: Step = {
        id: 'skip-test',
        name: 'Skip Test',
        skipIf: (ctx) => ctx.skip === true,
      };

      expect(typeof skipStep.skipIf).toBe('function');
    });

    it('should accept runIf property in Step definition', () => {
      const runIfStep: Step = {
        id: 'runif-test',
        name: 'RunIf Test',
        runIf: (ctx) => ctx.enabled === true,
      };

      expect(typeof runIfStep.runIf).toBe('function');
    });

    it('should work with createWorkflow using conditional step', async () => {
      // For conditional steps with runIf, we need to use WorkflowEngine directly
      // since createWorkflow's simple step object doesn't support runIf
      const conditionalDefinition = {
        id: 'conditional-workflow',
        name: 'Conditional Workflow',
        version: '1.0.0',
        steps: [
          {
            id: 'conditional',
            name: 'Conditional Step',
            runIf: (ctx: any) => ctx.shouldRun === true,
          },
          { id: 'always', name: 'Always Runs' },
        ],
        createContext: (input: any) => ({ shouldRun: input.shouldRun }),
      };

      const conditionalHandlers = {
        conditional: async (ctx: StepContext<any>) => {
          await ctx.set('executed', true);
          return 'conditional-done';
        },
        always: async () => 'always-done',
      };

      // Test with shouldRun = true
      const engine1 = new WorkflowEngine(conditionalDefinition, conditionalHandlers, createContainer(), {
        autoExecute: false,
      });
      createdWorkflows.push({ shutdown: () => engine1.shutdown() });
      const run1 = await engine1.start({ shouldRun: true });
      await engine1.execute(run1._id);
      const result1 = await engine1.get(run1._id);
      expect(result1?.context.executed).toBe(true);

      // Test with shouldRun = false
      const engine2 = new WorkflowEngine(conditionalDefinition, conditionalHandlers, createContainer(), {
        autoExecute: false,
      });
      createdWorkflows.push({ shutdown: () => engine2.shutdown() });
      const run2 = await engine2.start({ shouldRun: false });
      await engine2.execute(run2._id);
      const result2 = await engine2.get(run2._id);
      expect(result2?.context.executed).toBeUndefined(); // Step was skipped
    });
  });

  describe('Fix 6: Repository updateOne with MongoDB Operators', () => {
    it('should support simple object updates (wrapped in $set)', async () => {
      await WorkflowRunModel.create({
        _id: 'update-test-simple',
        workflowId: 'test',
        status: 'draft',
        steps: [],
        currentStepId: null,
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Simple object update (should be wrapped in $set)
      const result = await workflowRunRepository.updateOne(
        { _id: 'update-test-simple' },
        { status: 'running', startedAt: new Date() }
      );

      expect(result.modifiedCount).toBe(1);

      const updated = await WorkflowRunModel.findById('update-test-simple');
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should support MongoDB operators ($set, $unset)', async () => {
      await WorkflowRunModel.create({
        _id: 'update-test-operators',
        workflowId: 'test',
        status: 'draft',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0, error: { message: 'old' } }],
        currentStepId: 'step1',
        context: {},
        input: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Update with MongoDB operators
      const result = await workflowRunRepository.updateOne(
        { _id: 'update-test-operators' },
        {
          $set: { 'steps.0.status': 'running', 'steps.0.attempts': 1 },
          $unset: { 'steps.0.error': '' },
        }
      );

      expect(result.modifiedCount).toBe(1);

      const updated = await WorkflowRunModel.findById('update-test-operators');
      expect(updated?.steps[0].status).toBe('running');
      expect(updated?.steps[0].attempts).toBe(1);
      expect(updated?.steps[0].error).toBeUndefined();
    });
  });
});
