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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Step,
  StepContext,
  WorkflowDefinition,
  WorkflowHandlers,
} from '../../src/core/types.js';
import { WorkflowEngine } from '../../src/index.js';
import { SchedulingService } from '../../src/scheduling/scheduling.service.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

type Ctx = { result?: string; signalReceived?: boolean };

// Engines built directly (outside env.workflow — env.worker only wraps
// createWorkflow) — each on its own env container, like a separate process, on
// the env's database. The env disposes the containers; the engines are shut
// down here after each test.
const engines: Array<{ shutdown(): void }> = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.shutdown();
});
function engineOnOwnContainer<TContext>(
  definition: WorkflowDefinition<TContext>,
  handlers: WorkflowHandlers<TContext>,
): WorkflowEngine<TContext> {
  const engine = new WorkflowEngine(definition, handlers, env.createContainer(), {
    autoExecute: false,
  });
  engines.push(engine);
  return engine;
}

/** Scheduled draft fields for a run due at `at`. */
const scheduledAt = (at: Date, extra: Record<string, unknown> = {}) => ({
  scheduledFor: at.toISOString(),
  timezone: 'UTC',
  localTimeDisplay: 'test',
  executionTime: at,
  isDSTTransition: false,
  ...extra,
});

describe('Critical Engine Fixes', () => {
  // Handlers for SchedulingService tests (separate from workflow)
  const handlers: WorkflowHandlers<Ctx> = {
    step1: async (ctx: StepContext<Ctx>) => {
      await ctx.set('result', 'step1-done');
      return 'step1-output';
    },
    step2: async (ctx: StepContext<Ctx>) => {
      // Verify AbortSignal is available
      await ctx.set('signalReceived', ctx.signal instanceof AbortSignal);
      return 'step2-output';
    },
    step3: async () => 'step3-output',
  };

  // Test workflow definition using createWorkflow (per test — the env shuts it down)
  const criticalWorkflow = () =>
    env.workflow<Ctx>('test-critical-fixes', {
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
    });

  describe('Fix 1: Scheduled Workflows Step Initialization', () => {
    it('should create scheduled workflow with properly initialized steps', async () => {
      const service = new SchedulingService(criticalWorkflow().definition, handlers, {
        container: env.container,
      });
      const futureTime = new Date(Date.now() + 60000);

      const run = await service.schedule({
        scheduledFor: futureTime,
        timezone: 'UTC',
        input: { foo: 'bar' },
      });

      // Steps should be initialized from workflow definition
      expect(run.steps).toHaveLength(3);
      expect(run.steps[0]?.stepId).toBe('step1');
      expect(run.steps[0]?.status).toBe('pending');
      expect(run.steps[0]?.attempts).toBe(0);
      expect(run.steps[1]?.stepId).toBe('step2');
      expect(run.steps[2]?.stepId).toBe('step3');

      // currentStepId should be set to first step
      expect(run.currentStepId).toBe('step1');

      // Status should be draft (scheduled, not yet executed)
      expect(run.status).toBe('draft');
    });

    it('should initialize context using workflow createContext function', async () => {
      type InitCtx = { initialized: boolean; input: unknown };
      const workflowWithContext = env.workflow<InitCtx>('test-context-init', {
        steps: {
          step1: async () => 'done',
        },
        context: (input) => ({ initialized: true, input }),
        version: '1.0.0',
      });

      const service = new SchedulingService(
        workflowWithContext.definition,
        { step1: async () => 'done' },
        { container: env.container },
      );

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
      await env.runs.insert('test-workflow', {
        _id: 'atomic-claim-test',
        status: 'draft',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0 }],
        currentStepId: 'step1',
        scheduling: scheduledAt(pastTime),
      });

      // Simulate two schedulers trying to claim the same workflow
      const now = new Date();
      const repository = env.container.repository;

      // First claim should succeed
      const claim1 = await repository.updateOne(
        {
          _id: 'atomic-claim-test',
          status: 'draft',
          'scheduling.executionTime': { $lte: now },
        },
        {
          status: 'running',
          startedAt: now,
          updatedAt: now,
        },
      );

      // Second claim should fail (workflow already claimed)
      const claim2 = await repository.updateOne(
        {
          _id: 'atomic-claim-test',
          status: 'draft', // This condition will fail - already 'running'
          'scheduling.executionTime': { $lte: now },
        },
        {
          status: 'running',
          startedAt: now,
          updatedAt: now,
        },
      );

      expect(claim1.modifiedCount).toBe(1);
      expect(claim2.modifiedCount).toBe(0);

      // Verify workflow is now running
      const workflowRun = await env.runs.get('atomic-claim-test');
      expect(workflowRun?.status).toBe('running');
    });
  });

  describe('Fix 3: getScheduled() Filter Support', () => {
    beforeEach(async () => {
      // Create test workflows with different execution times
      const draft = (id: string, at: string, extra: Record<string, unknown> = {}) =>
        env.runs.insert('test', {
          _id: id,
          status: 'draft',
          steps: [],
          currentStepId: null,
          scheduling: scheduledAt(new Date(at), extra),
        });

      await draft('scheduled-early', '2024-06-10T10:00:00Z');
      await draft('scheduled-mid', '2024-06-15T10:00:00Z');
      await draft('scheduled-late', '2024-06-20T10:00:00Z');
      await draft('scheduled-recurring', '2024-06-15T10:00:00Z', {
        recurrence: { pattern: 'daily' },
      });
    });

    it('should filter by executionTimeRange', async () => {
      const service = new SchedulingService(criticalWorkflow().definition, handlers, {
        container: env.container,
      });

      const result = await service.getScheduled({
        executionTimeRange: {
          from: new Date('2024-06-14T00:00:00Z'),
          to: new Date('2024-06-16T23:59:59Z'),
        },
      });

      // Should only return workflows in the range (mid and recurring)
      expect(result.data).toHaveLength(2);
      const ids = result.data.map((d) => d._id);
      expect(ids).toContain('scheduled-mid');
      expect(ids).toContain('scheduled-recurring');
      expect(ids).not.toContain('scheduled-early');
      expect(ids).not.toContain('scheduled-late');
    });

    it('should filter by recurring=true', async () => {
      const service = new SchedulingService(criticalWorkflow().definition, handlers, {
        container: env.container,
      });

      const result = await service.getScheduled({
        recurring: true,
      });

      // Should only return recurring workflows
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?._id).toBe('scheduled-recurring');
    });

    it('should filter by recurring=false', async () => {
      const service = new SchedulingService(criticalWorkflow().definition, handlers, {
        container: env.container,
      });

      const result = await service.getScheduled({
        recurring: false,
      });

      // Should only return non-recurring workflows
      expect(result.data).toHaveLength(3);
      const ids = result.data.map((d) => d._id);
      expect(ids).not.toContain('scheduled-recurring');
    });
  });

  describe('Fix 4: AbortSignal in StepContext', () => {
    it('should provide AbortSignal to step handlers', async () => {
      const workflow = criticalWorkflow();
      const run = await workflow.start({ test: true });
      await workflow.execute(run._id);

      const result = await workflow.get(run._id);

      // step2 handler sets signalReceived based on whether ctx.signal is an AbortSignal
      expect(result?.context.signalReceived).toBe(true);
    });

    it('should abort signal on timeout', async () => {
      let signalAborted = false;
      let abortReason: unknown = null;

      const timeoutWorkflow = env.workflow<Record<string, never>>('timeout-test', {
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
      });

      // Access the engine to set step timeout (since createWorkflow doesn't support per-step timeout in steps object)
      // We need to use the engine directly with a modified definition
      const timeoutDefinition = {
        ...timeoutWorkflow.definition,
        steps: [{ id: 'slow', name: 'Slow Step', timeout: 100 }], // 100ms timeout
      };

      const engine = engineOnOwnContainer(timeoutDefinition, {
        slow: async (ctx: StepContext<Record<string, never>>) => {
          ctx.signal.addEventListener('abort', () => {
            signalAborted = true;
            abortReason = ctx.signal.reason;
          });

          // Wait longer than timeout
          await new Promise((resolve) => setTimeout(resolve, 500));
          return 'should not reach';
        },
      });

      const run = await engine.start({});

      // Execute should fail with timeout
      try {
        await engine.execute(run._id);
      } catch {
        // Expected to throw
      }

      // The abort event fires on the timeout — wait for it, not a guessed delay.
      await env.eventually(() => expect(signalAborted).toBe(true), { timeout: 1000 });

      expect(signalAborted).toBe(true);
      expect((abortReason as Error | null)?.message).toContain('timeout');
    });
  });

  describe('Fix 5: Step Interface with Conditional Properties', () => {
    it('should accept condition property in Step definition', () => {
      const conditionalStep: Step = {
        id: 'conditional-test',
        name: 'Conditional Test',
        condition: (ctx) => (ctx as { shouldRun?: boolean }).shouldRun === true,
      };

      expect(typeof conditionalStep.condition).toBe('function');
    });

    it('should accept skipIf property in Step definition', () => {
      const skipStep: Step = {
        id: 'skip-test',
        name: 'Skip Test',
        skipIf: (ctx) => (ctx as { skip?: boolean }).skip === true,
      };

      expect(typeof skipStep.skipIf).toBe('function');
    });

    it('should accept runIf property in Step definition', () => {
      const runIfStep: Step = {
        id: 'runif-test',
        name: 'RunIf Test',
        runIf: (ctx) => (ctx as { enabled?: boolean }).enabled === true,
      };

      expect(typeof runIfStep.runIf).toBe('function');
    });

    it('should work with createWorkflow using conditional step', async () => {
      type CondCtx = { shouldRun: boolean; executed?: boolean };

      // For conditional steps with runIf, we need to use WorkflowEngine directly
      // since createWorkflow's simple step object doesn't support runIf
      const conditionalDefinition: WorkflowDefinition<CondCtx> = {
        id: 'conditional-workflow',
        name: 'Conditional Workflow',
        version: '1.0.0',
        steps: [
          {
            id: 'conditional',
            name: 'Conditional Step',
            runIf: (ctx) => (ctx as CondCtx).shouldRun === true,
          },
          { id: 'always', name: 'Always Runs' },
        ],
        createContext: (input) => ({ shouldRun: (input as { shouldRun: boolean }).shouldRun }),
      };

      const conditionalHandlers: WorkflowHandlers<CondCtx> = {
        conditional: async (ctx) => {
          await ctx.set('executed', true);
          return 'conditional-done';
        },
        always: async () => 'always-done',
      };

      // Test with shouldRun = true
      const engine1 = engineOnOwnContainer(conditionalDefinition, conditionalHandlers);
      const run1 = await engine1.start({ shouldRun: true });
      await engine1.execute(run1._id);
      const result1 = await engine1.get(run1._id);
      expect(result1?.context.executed).toBe(true);

      // Test with shouldRun = false
      const engine2 = engineOnOwnContainer(conditionalDefinition, conditionalHandlers);
      const run2 = await engine2.start({ shouldRun: false });
      await engine2.execute(run2._id);
      const result2 = await engine2.get(run2._id);
      expect(result2?.context.executed).toBeUndefined(); // Step was skipped
    });
  });

  describe('Fix 6: Repository updateOne with MongoDB Operators', () => {
    it('should support simple object updates (wrapped in $set)', async () => {
      await env.runs.insert('test', {
        _id: 'update-test-simple',
        status: 'draft',
        steps: [],
        currentStepId: null,
      });

      // Simple object update (should be wrapped in $set)
      const result = await env.container.repository.updateOne(
        { _id: 'update-test-simple' },
        { status: 'running', startedAt: new Date() },
      );

      expect(result.modifiedCount).toBe(1);

      const updated = await env.runs.get('update-test-simple');
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should support MongoDB operators ($set, $unset)', async () => {
      await env.runs.insert('test', {
        _id: 'update-test-operators',
        status: 'draft',
        steps: [{ stepId: 'step1', status: 'pending', attempts: 0, error: { message: 'old' } }],
        currentStepId: 'step1',
      });

      // Update with MongoDB operators
      const result = await env.container.repository.updateOne(
        { _id: 'update-test-operators' },
        {
          $set: { 'steps.0.status': 'running', 'steps.0.attempts': 1 },
          $unset: { 'steps.0.error': '' },
        },
      );

      expect(result.modifiedCount).toBe(1);

      const updated = await env.runs.get('update-test-operators');
      expect(updated?.steps[0]?.status).toBe('running');
      expect(updated?.steps[0]?.attempts).toBe(1);
      expect(updated?.steps[0]?.error).toBeUndefined();
    });
  });
});
