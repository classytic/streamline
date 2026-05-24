/**
 * `workflow.bindFailureTo()` — parent-doc failure bridge.
 *
 * Replaces the hand-rolled "subscribe to `workflow:failed` → match by
 * workflow id → look up parent → patch" boilerplate hosts otherwise repeat
 * once per workflow. Tests prove:
 *
 *   - Patches the parent doc when the workflow run fails (default 'input' source)
 *   - Source 'context' reads from run.context instead of run.input
 *   - Function key resolver handles nested / computed parent refs
 *   - `errorField` records the failure error message
 *   - `errorTransform` shapes the error before writing
 *   - DOES NOT patch when the workflow succeeds
 *   - DOES NOT patch when a DIFFERENT workflow's run fails on the same bus
 *   - DOES NOT patch when the parent ref is null/missing
 *   - Unsubscribe (`off()`) returned from bindFailureTo prevents future patches
 *   - Best-effort: model.findByIdAndUpdate throwing doesn't crash the bus
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema, type Model } from 'mongoose';
import { createWorkflow, configureStreamlineLogger } from '../../src/index.js';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitUntil } from '../utils/setup.js';

beforeAll(async () => {
  await setupTestDB();
  configureStreamlineLogger({ enabled: false });
});

afterAll(async () => {
  configureStreamlineLogger({ enabled: true });
  await teardownTestDB();
});

afterEach(async () => {
  await cleanupTestDB();
});

// ── Parent-doc model (one fresh model per test to avoid mongoose name clash) ─

interface ParentDoc {
  status: string;
  errorMessage?: string;
  errorDetails?: { code?: string; message?: string };
}

function makeParentModel(): Model<ParentDoc> {
  const name = `parent_${Math.random().toString(36).slice(2, 9)}`;
  const schema = new Schema<ParentDoc>({
    status: { type: String, default: 'running' },
    errorMessage: String,
    errorDetails: { code: String, message: String },
  });
  return mongoose.model<ParentDoc>(name, schema);
}

// ── Workflow that always fails (one fresh id per test) ──────────────────────

function makeFailingWorkflow<TInput = Record<string, unknown>>(
  contextBuilder?: (input: TInput) => Record<string, unknown>,
) {
  const id = `failing_${Math.random().toString(36).slice(2, 9)}`;
  return createWorkflow<Record<string, unknown>, TInput>(id, {
    steps: {
      explode: async () => {
        throw new Error('intentional failure for test');
      },
    },
    ...(contextBuilder && { context: contextBuilder }),
  });
}

function makeSucceedingWorkflow() {
  const id = `succeeding_${Math.random().toString(36).slice(2, 9)}`;
  return createWorkflow<Record<string, unknown>, Record<string, unknown>>(id, {
    steps: {
      ok: async () => ({ done: true }),
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.bindFailureTo — default source: input', () => {
  it('patches the parent doc when the workflow run fails', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    workflow.bindFailureTo({
      model: ParentModel,
      key: 'parentId',
      field: 'status',
      value: 'failed',
    });

    await workflow.start({ parentId: String(parent._id) });
    await waitUntil(async () => {
      const fresh = await ParentModel.findById(parent._id);
      return fresh?.status === 'failed';
    });

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('failed');

    workflow.shutdown();
  });

  it("defaults value to 'failed' when not specified", async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    workflow.bindFailureTo({
      model: ParentModel,
      key: 'parentId',
      field: 'status',
    });

    await workflow.start({ parentId: String(parent._id) });
    await waitUntil(async () => {
      const fresh = await ParentModel.findById(parent._id);
      return fresh?.status === 'failed';
    });

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('failed');

    workflow.shutdown();
  });
});

describe('workflow.bindFailureTo — source: context', () => {
  it('reads the parent id from run.context when source is "context"', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow<{ orderId: string }>((input) => ({
      derivedParentId: input.orderId,
    }));
    workflow.bindFailureTo({
      model: ParentModel,
      source: 'context',
      key: 'derivedParentId',
      field: 'status',
    });

    await workflow.start({ orderId: String(parent._id) });
    await waitUntil(async () => {
      const fresh = await ParentModel.findById(parent._id);
      return fresh?.status === 'failed';
    });

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('failed');

    workflow.shutdown();
  });
});

describe('workflow.bindFailureTo — function key resolver', () => {
  it('uses the function key to extract the parent id from nested input', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow<{ envelope: { parentId: string } }>();
    workflow.bindFailureTo({
      model: ParentModel,
      key: (run) => (run.input as { envelope: { parentId: string } }).envelope.parentId,
      field: 'status',
    });

    await workflow.start({ envelope: { parentId: String(parent._id) } });
    await waitUntil(async () => {
      const fresh = await ParentModel.findById(parent._id);
      return fresh?.status === 'failed';
    });

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('failed');

    workflow.shutdown();
  });
});

describe('workflow.bindFailureTo — errorField + errorTransform', () => {
  it('records the failure message at errorField', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    workflow.bindFailureTo({
      model: ParentModel,
      key: 'parentId',
      field: 'status',
      errorField: 'errorMessage',
    });

    await workflow.start({ parentId: String(parent._id) });
    await waitUntil(async () => {
      const fresh = await ParentModel.findById(parent._id);
      return fresh?.status === 'failed';
    });

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.errorMessage).toMatch(/intentional failure/);

    workflow.shutdown();
  });

  it('shapes the error via errorTransform before writing', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    workflow.bindFailureTo({
      model: ParentModel,
      key: 'parentId',
      field: 'status',
      errorField: 'errorDetails',
      errorTransform: (err) => ({
        code: 'WORKFLOW_FAILED',
        message: (err as Error).message,
      }),
    });

    await workflow.start({ parentId: String(parent._id) });
    await waitUntil(async () => {
      const fresh = await ParentModel.findById(parent._id);
      return fresh?.status === 'failed';
    });

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.errorDetails?.code).toBe('WORKFLOW_FAILED');
    expect(fresh?.errorDetails?.message).toMatch(/intentional failure/);

    workflow.shutdown();
  });
});

describe('workflow.bindFailureTo — does NOT patch when', () => {
  it('the workflow run completes successfully', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeSucceedingWorkflow();
    workflow.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' });

    const run = await workflow.start({ parentId: String(parent._id) });
    await workflow.waitFor(run._id, { timeout: 5000 });

    // Give the event bus a tick to deliver any spurious failed event
    await new Promise((r) => setTimeout(r, 50));
    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('running');

    workflow.shutdown();
  });

  it('a DIFFERENT workflow on the same bus fails (workflow-id filter)', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    // Bound workflow — never started, never fails
    const bound = makeFailingWorkflow();
    bound.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' });

    // Different workflow on the SAME container — fails
    const other = createWorkflow<Record<string, unknown>>(
      `other_${Math.random().toString(36).slice(2, 9)}`,
      {
        steps: {
          explode: async () => {
            throw new Error('other workflow failure');
          },
        },
        container: bound.container,
      },
    );
    const otherRun = await other.start({ parentId: String(parent._id) });
    await other.waitFor(otherRun._id, { timeout: 5000 }).catch(() => {});

    // Even though SOME workflow:failed event fired, the bound parent must
    // still be in 'running' state — bindFailureTo filtered it out.
    await new Promise((r) => setTimeout(r, 100));
    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('running');

    other.shutdown();
    bound.shutdown();
  });

  it('the parent id reference is missing from input', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    workflow.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' });

    // No parentId in input — bind should no-op
    await workflow.start({ somethingElse: 'irrelevant' });
    await new Promise((r) => setTimeout(r, 100));

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('running');

    workflow.shutdown();
  });
});

describe('workflow.bindFailureTo — unsubscribe', () => {
  it('off() returned from bindFailureTo stops future patches', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    const off = workflow.bindFailureTo({
      model: ParentModel,
      key: 'parentId',
      field: 'status',
    });

    off(); // Immediate unsubscribe

    await workflow.start({ parentId: String(parent._id) });
    await new Promise((r) => setTimeout(r, 150));

    const fresh = await ParentModel.findById(parent._id);
    // Bind was off before the failure event fired — parent untouched.
    expect(fresh?.status).toBe('running');

    workflow.shutdown();
  });
});

describe('workflow.bindFailureTo — best-effort failure isolation', () => {
  it('does not crash the bus when findByIdAndUpdate throws', async () => {
    const failingModel = {
      findByIdAndUpdate: vi.fn(() => {
        throw new Error('mongo connection lost');
      }),
    };

    const engineErrors: unknown[] = [];
    const workflow = makeFailingWorkflow();
    workflow.container.eventBus.on('engine:error', (payload: unknown) => {
      engineErrors.push(payload);
    });

    workflow.bindFailureTo({
      model: failingModel as unknown as Model<ParentDoc>,
      key: 'parentId',
      field: 'status',
    });

    // Workflow must still complete (in failed status) without the throw
    // bubbling up and tearing down the engine.
    const run = await workflow.start({ parentId: 'anything' });
    await workflow.waitFor(run._id, { timeout: 5000 });

    // The bindFailureTo handler ran and threw — must have surfaced via
    // engine:error rather than crashing.
    await new Promise((r) => setTimeout(r, 100));
    expect(failingModel.findByIdAndUpdate).toHaveBeenCalled();
    expect(engineErrors.some((e) => /bindFailureTo/.test(JSON.stringify(e)))).toBe(true);

    workflow.shutdown();
  });
});
