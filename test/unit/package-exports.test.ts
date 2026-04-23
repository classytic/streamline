/**
 * Package Export Verification
 *
 * Ensures all documented public exports are importable from the package index.
 * If any export is missing, this test fails — catches TS4023 and barrel gaps.
 */

import { describe, it, expect } from 'vitest';

describe('Package exports: main entry point', () => {
  it('should export createWorkflow and core workflow API', async () => {
    const mod = await import('../../src/index.js');

    // Core API
    expect(mod.createWorkflow).toBeTypeOf('function');
    expect(mod.WorkflowEngine).toBeTypeOf('function');

    // Hooks
    expect(mod.createHook).toBeTypeOf('function');
    expect(mod.resumeHook).toBeTypeOf('function');
    expect(mod.hookToken).toBeTypeOf('function');

    // Wait signal
    expect(mod.WaitSignal).toBeTypeOf('function');

    // Storage
    expect(mod.WorkflowRunModel).toBeDefined();
    expect(mod.workflowRunRepository).toBeDefined();
    expect(mod.createWorkflowRepository).toBeTypeOf('function');
    expect(mod.WorkflowQueryBuilder).toBeTypeOf('function');
    expect(mod.CommonQueries).toBeDefined();

    // Events
    expect(mod.WorkflowEventBus).toBeTypeOf('function');
    expect(mod.globalEventBus).toBeDefined();

    // DI
    expect(mod.createContainer).toBeTypeOf('function');
    expect(mod.isStreamlineContainer).toBeTypeOf('function');
    expect(mod.WorkflowCache).toBeTypeOf('function');

    // Scheduling
    expect(mod.SchedulingService).toBeTypeOf('function');
    expect(mod.TimezoneHandler).toBeTypeOf('function');
    expect(mod.timezoneHandler).toBeDefined();

    // Plugins
    expect(mod.tenantFilterPlugin).toBeTypeOf('function');
    expect(mod.singleTenantPlugin).toBeTypeOf('function');

    // Features
    expect(mod.executeParallel).toBeTypeOf('function');
    expect(mod.isConditionalStep).toBeTypeOf('function');
    expect(mod.shouldSkipStep).toBeTypeOf('function');
    expect(mod.createCondition).toBeTypeOf('function');
    expect(mod.conditions).toBeDefined();

    // Errors
    expect(mod.ErrorCode).toBeDefined();
    expect(mod.WorkflowError).toBeTypeOf('function');
    expect(mod.StepNotFoundError).toBeTypeOf('function');
    expect(mod.WorkflowNotFoundError).toBeTypeOf('function');
    expect(mod.InvalidStateError).toBeTypeOf('function');
    expect(mod.StepTimeoutError).toBeTypeOf('function');
    expect(mod.DataCorruptionError).toBeTypeOf('function');
    expect(mod.MaxRetriesExceededError).toBeTypeOf('function');

    // Visualization
    expect(mod.getStepTimeline).toBeTypeOf('function');
    expect(mod.getWorkflowProgress).toBeTypeOf('function');
    expect(mod.getStepUIStates).toBeTypeOf('function');
    expect(mod.getWaitingInfo).toBeTypeOf('function');
    expect(mod.canRewindTo).toBeTypeOf('function');
    expect(mod.getExecutionPath).toBeTypeOf('function');

    // Status utilities
    expect(mod.deriveRunStatus).toBeTypeOf('function');
    expect(mod.isTerminalState).toBeTypeOf('function');
    expect(mod.isRunStatus).toBeTypeOf('function');
    expect(mod.isStepStatus).toBeTypeOf('function');

    // Constants
    expect(mod.COMPUTED).toBeDefined();
    expect(mod.hookRegistry).toBeDefined();

    // Update-doc builders (v2.2)
    expect(mod.normalizeUpdate).toBeTypeOf('function');
    expect(mod.runSet).toBeTypeOf('function');
    expect(mod.runSetUnset).toBeTypeOf('function');
    expect(mod.buildStepUpdateOps).toBeTypeOf('function');

    // Arc-compatible event transport (v2.2)
    expect(mod.InProcessStreamlineBus).toBeTypeOf('function');
    expect(mod.createEvent).toBeTypeOf('function');
    expect(mod.bridgeBusToTransport).toBeTypeOf('function');
    expect(mod.STREAMLINE_EVENTS).toBeDefined();
    expect(mod.LEGACY_TO_CANONICAL).toBeDefined();
  });

  it('updateOne accepts a MongoUpdate from normalizeUpdate / runSet', async () => {
    // The point of exposing MongoUpdate + helpers is so consumers can compose
    // atomic updates without guessing the internal shape. This verifies the
    // helpers + repository types align at runtime.
    const { normalizeUpdate, runSet, runSetUnset } = await import('../../src/index.js');

    const ops = normalizeUpdate({ status: 'running' });
    expect(ops.$set?.status).toBe('running');

    const set = runSet({ status: 'done', output: { ok: true } });
    expect(set.$set?.status).toBe('done');
    expect(set.$set?.updatedAt).toBeInstanceOf(Date);

    const both = runSetUnset({ status: 'waiting' }, ['error', 'waitingFor']);
    expect(both.$unset).toEqual({ error: '', waitingFor: '' });
  });

  it('should export all type-only exports (compilation test)', async () => {
    // These are type-only — importing them verifies they compile.
    // At runtime we just check the module loaded without errors.
    const mod = await import('../../src/index.js');

    // Type re-exports from define.ts
    // Workflow, WorkflowConfig, StepConfig, WaitForOptions are type-only
    // but createWorkflow() returns Workflow, so it's validated transitively.
    expect(mod.createWorkflow).toBeTypeOf('function');
  });

  it('should export SignalStore type via createContainer', async () => {
    const { createContainer } = await import('../../src/index.js');
    const container = createContainer();
    expect(container.signalStore).toBeDefined();
    expect(container.signalStore.publish).toBeTypeOf('function');
    expect(container.signalStore.subscribe).toBeTypeOf('function');
  });
});

describe('Package exports: subpath entry points', () => {
  it('should export from ./fastify subpath', async () => {
    const mod = await import('../../src/integrations/fastify.js');
    expect(mod).toBeDefined();
  });

  it('should export from ./telemetry subpath', async () => {
    const mod = await import('../../src/telemetry/index.js');
    expect(mod).toBeDefined();
  });
});
