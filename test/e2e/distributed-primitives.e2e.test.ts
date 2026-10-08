/**
 * E2E tests for distributed primitives (v2.1):
 * 1. NonRetriableError
 * 2. Idempotency key
 * 3. cancelOn (reactive cancellation)
 * 4. Concurrency control (per-key limits)
 * 5. Event trigger
 * 6. Priority
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureStreamlineLogger, NonRetriableError } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

beforeAll(() => {
  configureStreamlineLogger({ enabled: false });
});

afterAll(() => {
  configureStreamlineLogger({ enabled: true });
});

/** A promise plus the function that resolves it — "the step is in flight". */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ============================================================================
// 1. NonRetriableError
// ============================================================================

describe('NonRetriableError', () => {
  it('should immediately fail step without retrying', async () => {
    let attempts = 0;

    const wf = env.workflow('non-retriable-test', {
      steps: {
        validate: {
          handler: async () => {
            attempts++;
            throw new NonRetriableError("Invalid credentials — retrying won't help");
          },
          retries: 5,
        },
      },
    });

    const run = await wf.start({});
    const result = await wf.execute(run._id);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(1); // No retries
    expect(result.steps[0]?.error?.message).toContain('Invalid credentials');
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
  it('should return existing run when starting with duplicate key', async () => {
    const wf = env.workflow('idemp-test', {
      steps: {
        step1: async () => 'ok',
      },
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
  });

  it('should store idempotencyKey in the run document', async () => {
    const wf = env.workflow('idemp-store-test', {
      steps: { a: async () => 'ok' },
    });

    const run = await wf.start({}, { idempotencyKey: 'unique-key-1' });
    const doc = await env.runs.get(run._id);
    expect(doc?.idempotencyKey).toBe('unique-key-1');
  });
});

// ============================================================================
// 3. cancelOn — Reactive Cancellation
// ============================================================================

describe('cancelOn', () => {
  it('should auto-cancel workflow when matching event fires', async () => {
    const started = deferred();
    const wf = env.workflow('cancel-on-test', {
      steps: {
        slow: async (ctx) => {
          started.resolve();
          // A 10s step that returns early once aborted — the run must stay
          // cancelled even though the handler then returns a value.
          await new Promise<void>((r) => {
            const timer = setTimeout(r, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              r();
            });
          });
          return 'should not complete';
        },
      },
      cancelOn: [{ event: 'order.cancelled' }],
    });

    const run = await wf.start({});
    const execPromise = wf.execute(run._id).catch(() => {});

    // Fire only once the step is in flight
    await started.promise;

    // Fire the cancel event
    wf.container.eventBus.emit('order.cancelled', { runId: run._id });

    await env.until(run._id, 'cancelled');
    await execPromise;

    const final = await env.runs.get(run._id);
    expect(final?.status).toBe('cancelled');
  });
});

// ============================================================================
// 4. Concurrency Control
// ============================================================================

describe('Concurrency control', () => {
  it('should queue runs as draft when concurrency limit reached', async () => {
    const wf = env.workflow<{ userId: string }, { userId: string }>('concurrency-test', {
      steps: {
        process: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'done';
        },
      },
      concurrency: { limit: 2, key: (input) => input.userId },
      context: (input) => ({ userId: input.userId }),
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
  });
});

// ============================================================================
// 5. Event Trigger
// ============================================================================

describe('Event trigger', () => {
  it('should auto-start workflow when trigger event fires', async () => {
    const wf = env.workflow('trigger-test', {
      steps: {
        process: async () => 'triggered',
      },
      trigger: { event: 'user.created' },
    });
    const workflowId = wf.engine.definition.id;

    // Fire the trigger event
    wf.container.eventBus.emit('user.created', { data: { name: 'Alice' } });

    // Wait for the async start to create a run
    const runs = await env.untilCount({ workflowId }, 1);

    // A run should have been created
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// 6. Priority
// ============================================================================

describe('Priority', () => {
  it('should store priority on the run document', async () => {
    const wf = env.workflow('priority-test', {
      steps: { a: async () => 'ok' },
    });

    const run = await wf.start({}, { priority: 10 });
    const doc = await env.runs.get(run._id);
    expect(doc?.priority).toBe(10);
  });

  it('should default priority to 0', async () => {
    const wf = env.workflow('priority-default-test', {
      steps: { a: async () => 'ok' },
    });

    const run = await wf.start({});
    const doc = await env.runs.get(run._id);
    expect(doc?.priority).toBe(0);
  });
});

// ============================================================================
// Smoke: All Primitives Combined
// ============================================================================

describe('Smoke: combined distributed primitives', () => {
  it('should support idempotency + priority + cancelOn in one workflow', async () => {
    const wf = env.workflow('combined-test', {
      steps: {
        process: async (ctx) => {
          await ctx.wait('Waiting for approval');
        },
        finalize: async () => 'done',
      },
      cancelOn: [{ event: 'order.cancelled' }],
    });

    // Start with idempotency + priority
    const run1 = await wf.start(
      {},
      {
        idempotencyKey: 'combined:1',
        priority: 5,
      },
    );
    expect(run1.priority).toBe(5);
    expect(run1.idempotencyKey).toBe('combined:1');

    // Duplicate start returns same run
    const run2 = await wf.start({}, { idempotencyKey: 'combined:1' });
    expect(run2._id).toBe(run1._id);

    // Execute to waiting state
    await wf.execute(run1._id);

    // Cancel via event
    wf.container.eventBus.emit('order.cancelled', { runId: run1._id });

    const final = await env.until(run1._id, 'cancelled');
    expect(final.status).toBe('cancelled');
  });
});
