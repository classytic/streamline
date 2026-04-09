/**
 * E2E tests for distributed primitives (v2.1):
 * 1. NonRetriableError
 * 2. Idempotency key
 * 3. cancelOn (reactive cancellation)
 * 4. Concurrency control (per-key limits)
 * 5. Event trigger
 * 6. Priority
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  NonRetriableError,
  WorkflowRunModel,
  configureStreamlineLogger,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
  configureStreamlineLogger({ enabled: false });
});

afterAll(async () => {
  configureStreamlineLogger({ enabled: true });
  await teardownTestDB();
});

// ============================================================================
// 1. NonRetriableError
// ============================================================================

describe('NonRetriableError', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should immediately fail step without retrying', async () => {
    let attempts = 0;

    const wf = createWorkflow('non-retriable-test', {
      steps: {
        validate: {
          handler: async () => {
            attempts++;
            throw new NonRetriableError('Invalid credentials — retrying won\'t help');
          },
          retries: 5,
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(1); // No retries
    expect(result.steps[0].error?.message).toContain('Invalid credentials');

    wf.shutdown();
  });

  it('should have retriable=false on the error instance', () => {
    const err = new NonRetriableError('test');
    expect(err.retriable).toBe(false);
    expect(err.name).toBe('NonRetriableError');
    expect(err).toBeInstanceOf(Error);
  });
});

// ============================================================================
// 2. Idempotency Key
// ============================================================================

describe('Idempotency key', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should return existing run when starting with duplicate key', async () => {
    const wf = createWorkflow('idemp-test', {
      steps: {
        step1: async () => 'ok',
      },
      autoExecute: false,
    });

    // First start — creates the run
    const run1 = await wf.start({}, { idempotencyKey: 'order:123' });
    expect(run1._id).toBeDefined();

    // Second start with same key — should return existing
    const run2 = await wf.start({}, { idempotencyKey: 'order:123' });
    expect(run2._id).toBe(run1._id);

    // Different key — should create new
    const run3 = await wf.start({}, { idempotencyKey: 'order:456' });
    expect(run3._id).not.toBe(run1._id);

    wf.shutdown();
  });

  it('should store idempotencyKey in the run document', async () => {
    const wf = createWorkflow('idemp-store-test', {
      steps: { a: async () => 'ok' },
      autoExecute: false,
    });

    const run = await wf.start({}, { idempotencyKey: 'unique-key-1' });
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.idempotencyKey).toBe('unique-key-1');

    wf.shutdown();
  });
});

// ============================================================================
// 3. cancelOn — Reactive Cancellation
// ============================================================================

describe('cancelOn', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should auto-cancel workflow when matching event fires', async () => {
    const wf = createWorkflow('cancel-on-test', {
      steps: {
        slow: async (ctx) => {
          await new Promise((r) => setTimeout(r, 10000));
          return 'should not complete';
        },
      },
      cancelOn: [{ event: 'order.cancelled' }],
      autoExecute: false,
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    // Give step time to start
    await waitFor(50);

    // Fire the cancel event
    wf.container.eventBus.emit('order.cancelled' as any, { runId: run._id });

    await waitFor(100);
    await execPromise;

    const final = await WorkflowRunModel.findById(run._id).lean();
    expect(final!.status).toBe('cancelled');

    wf.shutdown();
  });
});

// ============================================================================
// 4. Concurrency Control
// ============================================================================

describe('Concurrency control', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should queue runs as draft when concurrency limit reached', async () => {
    const wf = createWorkflow<{ userId: string }>('concurrency-test', {
      steps: {
        process: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'done';
        },
      },
      concurrency: { limit: 2, key: (input: { userId: string }) => input.userId },
      context: (input: { userId: string }) => ({ userId: input.userId }),
      autoExecute: false,
    });

    // Start 2 runs for user-A — should both be running
    const run1 = await wf.start({ userId: 'user-A' });
    const run2 = await wf.start({ userId: 'user-A' });
    expect(run1.status).toBe('running');
    expect(run2.status).toBe('running');

    // 3rd run for same user — should be queued as draft
    const run3 = await wf.start({ userId: 'user-A' });
    expect(run3.status).toBe('draft');

    // Different user — should be running (separate key)
    const run4 = await wf.start({ userId: 'user-B' });
    expect(run4.status).toBe('running');

    wf.shutdown();
  });
});

// ============================================================================
// 5. Event Trigger
// ============================================================================

describe('Event trigger', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should auto-start workflow when trigger event fires', async () => {
    let started = false;

    const wf = createWorkflow('trigger-test', {
      steps: {
        process: async () => {
          started = true;
          return 'triggered';
        },
      },
      trigger: { event: 'user.created' },
      autoExecute: false,
    });

    // Fire the trigger event
    wf.container.eventBus.emit('user.created' as any, { data: { name: 'Alice' } });

    // Wait for async start
    await waitFor(200);

    // A run should have been created
    const runs = await WorkflowRunModel.find({ workflowId: 'trigger-test' }).lean();
    expect(runs.length).toBeGreaterThanOrEqual(1);

    wf.shutdown();
  });
});

// ============================================================================
// 6. Priority
// ============================================================================

describe('Priority', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should store priority on the run document', async () => {
    const wf = createWorkflow('priority-test', {
      steps: { a: async () => 'ok' },
      autoExecute: false,
    });

    const run = await wf.start({}, { priority: 10 });
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.priority).toBe(10);

    wf.shutdown();
  });

  it('should default priority to 0', async () => {
    const wf = createWorkflow('priority-default-test', {
      steps: { a: async () => 'ok' },
      autoExecute: false,
    });

    const run = await wf.start({});
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.priority).toBe(0);

    wf.shutdown();
  });
});

// ============================================================================
// Smoke: All Primitives Combined
// ============================================================================

describe('Smoke: combined distributed primitives', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should support idempotency + priority + cancelOn in one workflow', async () => {
    const wf = createWorkflow('combined-test', {
      steps: {
        process: async (ctx) => {
          await ctx.wait('Waiting for approval');
        },
        finalize: async () => 'done',
      },
      cancelOn: [{ event: 'order.cancelled' }],
      autoExecute: false,
    });

    // Start with idempotency + priority
    const run1 = await wf.start({}, {
      idempotencyKey: 'combined:1',
      priority: 5,
    });
    expect(run1.priority).toBe(5);
    expect(run1.idempotencyKey).toBe('combined:1');

    // Duplicate start returns same run
    const run2 = await wf.start({}, { idempotencyKey: 'combined:1' });
    expect(run2._id).toBe(run1._id);

    // Execute to waiting state
    await wf.execute(run1._id);

    // Cancel via event
    wf.container.eventBus.emit('order.cancelled' as any, { runId: run1._id });
    await waitFor(100);

    const final = await WorkflowRunModel.findById(run1._id).lean();
    expect(final!.status).toBe('cancelled');

    wf.shutdown();
  });
});
