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

import { type Model, Schema } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureStreamlineLogger } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// Every workflow here shares the env container's bus. `shutdown()` (run by
// `env.clear()`) drops each workflow's own `bindFailureTo` subscriptions; this
// list also covers listeners a test adds to the bus directly.
const subscriptions: Array<() => void> = [];
const track = (off: () => void) => {
  subscriptions.push(off);
  return off;
};
afterEach(() => {
  for (const off of subscriptions.splice(0)) off();
});

beforeAll(() => {
  configureStreamlineLogger({ enabled: false });
});

afterAll(() => {
  configureStreamlineLogger({ enabled: true });
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
  return env.connection.model<ParentDoc>(name, schema);
}

async function expectParentFailed(model: Model<ParentDoc>, id: unknown): Promise<void> {
  await env.eventually(async () => {
    expect((await model.findById(id))?.status).toBe('failed');
  });
}

// ── Workflow that always fails (one fresh id per test) ──────────────────────

function makeFailingWorkflow<TInput = Record<string, unknown>>(
  contextBuilder?: (input: TInput) => Record<string, unknown>,
) {
  return env.workflow<Record<string, unknown>, TInput>('failing', {
    steps: {
      explode: async () => {
        throw new Error('intentional failure for test');
      },
    },
    ...(contextBuilder && { context: contextBuilder }),
    autoExecute: true,
  });
}

function makeSucceedingWorkflow() {
  return env.workflow<Record<string, unknown>, Record<string, unknown>>('succeeding', {
    steps: {
      ok: async () => ({ done: true }),
    },
    autoExecute: true,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.bindFailureTo — default source: input', () => {
  it('patches the parent doc when the workflow run fails', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    track(
      workflow.bindFailureTo({
        model: ParentModel,
        key: 'parentId',
        field: 'status',
        value: 'failed',
      }),
    );

    await workflow.start({ parentId: String(parent._id) });
    await expectParentFailed(ParentModel, parent._id);
  });

  it("defaults value to 'failed' when not specified", async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    track(
      workflow.bindFailureTo({
        model: ParentModel,
        key: 'parentId',
        field: 'status',
      }),
    );

    await workflow.start({ parentId: String(parent._id) });
    await expectParentFailed(ParentModel, parent._id);
  });
});

describe('workflow.bindFailureTo — source: context', () => {
  it('reads the parent id from run.context when source is "context"', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow<{ orderId: string }>((input) => ({
      derivedParentId: input.orderId,
    }));
    track(
      workflow.bindFailureTo({
        model: ParentModel,
        source: 'context',
        key: 'derivedParentId',
        field: 'status',
      }),
    );

    await workflow.start({ orderId: String(parent._id) });
    await expectParentFailed(ParentModel, parent._id);
  });
});

describe('workflow.bindFailureTo — function key resolver', () => {
  it('uses the function key to extract the parent id from nested input', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow<{ envelope: { parentId: string } }>();
    track(
      workflow.bindFailureTo({
        model: ParentModel,
        key: (run) => (run.input as { envelope: { parentId: string } }).envelope.parentId,
        field: 'status',
      }),
    );

    await workflow.start({ envelope: { parentId: String(parent._id) } });
    await expectParentFailed(ParentModel, parent._id);
  });
});

describe('workflow.bindFailureTo — errorField + errorTransform', () => {
  it('records the failure message at errorField', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    track(
      workflow.bindFailureTo({
        model: ParentModel,
        key: 'parentId',
        field: 'status',
        errorField: 'errorMessage',
      }),
    );

    await workflow.start({ parentId: String(parent._id) });
    await expectParentFailed(ParentModel, parent._id);

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.errorMessage).toMatch(/intentional failure/);
  });

  it('shapes the error via errorTransform before writing', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    track(
      workflow.bindFailureTo({
        model: ParentModel,
        key: 'parentId',
        field: 'status',
        errorField: 'errorDetails',
        errorTransform: (err) => ({
          code: 'WORKFLOW_FAILED',
          message: (err as Error).message,
        }),
      }),
    );

    await workflow.start({ parentId: String(parent._id) });
    await expectParentFailed(ParentModel, parent._id);

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.errorDetails?.code).toBe('WORKFLOW_FAILED');
    expect(fresh?.errorDetails?.message).toMatch(/intentional failure/);
  });
});

describe('workflow.bindFailureTo — does NOT patch when', () => {
  it('the workflow run completes successfully', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeSucceedingWorkflow();
    track(workflow.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' }));

    const run = await workflow.start({ parentId: String(parent._id) });
    await env.until(run._id, 'done');

    // Negative window (kept deliberately): give the event bus a tick to
    // deliver any spurious failed event.
    await new Promise((r) => setTimeout(r, 50));
    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('running');
  });

  it('a DIFFERENT workflow on the same bus fails (workflow-id filter)', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    // Bound workflow — never started, never fails
    const bound = makeFailingWorkflow();
    track(bound.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' }));

    // Different workflow on the SAME container — fails
    const other = env.workflow<Record<string, unknown>>('other', {
      steps: {
        explode: async () => {
          throw new Error('other workflow failure');
        },
      },
      autoExecute: true,
    });
    expect(other.container).toBe(bound.container);
    const otherRun = await other.start({ parentId: String(parent._id) });
    await env.until(otherRun._id, 'failed');

    // Even though SOME workflow:failed event fired, the bound parent must
    // still be in 'running' state — bindFailureTo filtered it out.
    // Negative window (kept deliberately).
    await new Promise((r) => setTimeout(r, 100));
    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('running');
  });

  it('the parent id reference is missing from input', async () => {
    const ParentModel = makeParentModel();
    const parent = await ParentModel.create({ status: 'running' });

    const workflow = makeFailingWorkflow();
    track(workflow.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' }));

    // No parentId in input — bind should no-op
    const run = await workflow.start({ somethingElse: 'irrelevant' });
    await env.until(run._id, 'failed');
    // Negative window (kept deliberately): the failed event has been emitted.
    await new Promise((r) => setTimeout(r, 100));

    const fresh = await ParentModel.findById(parent._id);
    expect(fresh?.status).toBe('running');
  });
});

describe('workflow.bindFailureTo — lifecycle', () => {
  it('shutdown() removes the workflow’s bindings from the shared bus', async () => {
    const ParentModel = makeParentModel();
    const bus = env.container.eventBus;
    const before = bus.listenerCount('workflow:failed');

    const workflow = makeFailingWorkflow();
    workflow.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' });
    workflow.bindFailureTo({ model: ParentModel, key: 'parentId', field: 'status' });
    expect(bus.listenerCount('workflow:failed')).toBe(before + 2);

    workflow.shutdown();
    expect(bus.listenerCount('workflow:failed')).toBe(before);
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

    const run = await workflow.start({ parentId: String(parent._id) });
    await env.until(run._id, 'failed');
    // Negative window (kept deliberately): nothing may patch the parent.
    await new Promise((r) => setTimeout(r, 150));

    const fresh = await ParentModel.findById(parent._id);
    // Bind was off before the failure event fired — parent untouched.
    expect(fresh?.status).toBe('running');
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
    const onEngineError = (payload: unknown) => {
      engineErrors.push(payload);
    };
    workflow.container.eventBus.on('engine:error', onEngineError);
    track(() => workflow.container.eventBus.off('engine:error', onEngineError));

    track(
      workflow.bindFailureTo({
        model: failingModel as unknown as Model<ParentDoc>,
        key: 'parentId',
        field: 'status',
      }),
    );

    // Workflow must still complete (in failed status) without the throw
    // bubbling up and tearing down the engine.
    const run = await workflow.start({ parentId: 'anything' });
    await env.until(run._id, 'failed');

    // The bindFailureTo handler ran and threw — must have surfaced via
    // engine:error rather than crashing.
    await env.eventually(async () => {
      expect(failingModel.findByIdAndUpdate).toHaveBeenCalled();
      expect(engineErrors.some((e) => /bindFailureTo/.test(JSON.stringify(e)))).toBe(true);
    });
  });
});
