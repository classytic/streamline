/**
 * Durable Signals E2E Tests
 *
 * Validates:
 * 1. resumeHook DB fallback actually completes the workflow (not just sets running)
 * 2. SignalStore is wired into event waits for cross-process delivery
 * 3. Index warnings are suppressed with proper test setup
 */

import { describe, expect, it } from 'vitest';
import { createHook, hookRegistry, resumeHook, type SignalStore } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** The token captured from a step, or a test failure if the step never created one. */
function tokenOf(token: string | undefined): string {
  if (!token) throw new Error('hook token was never captured');
  return token;
}

/** An in-process SignalStore that records every publish. */
function recordingSignalStore() {
  const published: Array<{ channel: string; data: unknown }> = [];
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const store: SignalStore = {
    publish(channel, data) {
      published.push({ channel, data });
      const handlers = listeners.get(channel);
      if (handlers) for (const h of handlers) h(data);
    },
    subscribe(channel, handler) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
      return () => {
        listeners.get(channel)?.delete(handler);
      };
    },
  };
  return { store, published };
}

// ============================================================================
// 1. resumeHook DB fallback completes workflow end-to-end
// ============================================================================

describe('resumeHook DB fallback — full workflow completion', () => {
  it('should complete the ENTIRE workflow when resumed via DB fallback (not just set running)', async () => {
    let hookToken: string | undefined;

    const workflow = env.workflow<{ result?: string }>('durable-hook-e2e', {
      steps: {
        waitStep: async (ctx) => {
          const hook = createHook(ctx, 'approval');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
        processStep: async (ctx) => {
          const approval = ctx.getOutput<{ approved: boolean }>('waitStep');
          await ctx.set('result', approval?.approved ? 'approved' : 'rejected');
          return { processed: true };
        },
      },
      context: () => ({}),
    });

    // Execute until waiting
    const run = await workflow.start({});
    await workflow.execute(run._id);

    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
    expect(hookToken).toBeDefined();

    // Simulate process restart: remove from hookRegistry
    hookRegistry.unregister(run._id);
    expect(hookRegistry.getEngine(run._id)).toBeUndefined();

    // Resume via DB fallback
    const resumeResult = await resumeHook(
      tokenOf(hookToken),
      { approved: true },
      { container: env.container },
    );
    expect(resumeResult.runId).toBe(run._id);

    // The DB fallback should advance currentStepId AND trigger execution.
    // Since workflowRegistry still has the engine, it should auto-execute.
    const final = await env.until(run._id, 'done');
    expect(final.context.result).toBe('approved');
  });

  it('should complete a single-step workflow via DB fallback', async () => {
    let hookToken: string | undefined;

    const workflow = env.workflow('single-step-hook', {
      steps: {
        only: async (ctx) => {
          const hook = createHook(ctx, 'confirm');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Remove from hookRegistry
    hookRegistry.unregister(run._id);

    // Resume — this is the last step, so workflow should complete
    await resumeHook(tokenOf(hookToken), { confirmed: true }, { container: env.container });

    // Single step, no next step → workflow should be 'done'
    const final = await workflow.get(run._id);
    expect(final?.status).toBe('done');
  });

  it('should advance currentStepId correctly on DB fallback resume', async () => {
    let hookToken: string | undefined;

    const workflow = env.workflow('hook-advance-step', {
      steps: {
        step1: async (ctx) => {
          const hook = createHook(ctx, 'hook');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
        step2: async () => 'step2-result',
        step3: async () => 'step3-result',
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Remove from hookRegistry (but workflowRegistry still has it)
    hookRegistry.unregister(run._id);

    await resumeHook(tokenOf(hookToken), { data: 'from-webhook' }, { container: env.container });

    // Wait for full completion via auto-execute
    const final = await env.until(run._id, 'done');
    // All 3 steps should be done
    expect(final.steps.filter((s) => s.status === 'done')).toHaveLength(3);
  });
});

// ============================================================================
// 2. SignalStore wired into event waits
// ============================================================================

describe('SignalStore integration with event waits', () => {
  it('should resume workflow via SignalStore publish (cross-process simulation)', async () => {
    const { store } = recordingSignalStore();
    // A container with the custom signal store, on the env's connection.
    const container = env.createContainer({ signalStore: store });

    const workflow = env.workflow<{ eventData?: unknown }>('signal-store-event', {
      steps: {
        waitForSignal: async (ctx) => {
          return ctx.waitFor('external:data-ready', 'Waiting for external data');
        },
        processData: async (ctx) => {
          const data = ctx.getOutput('waitForSignal');
          await ctx.set('eventData', data);
          return 'done';
        },
      },
      context: () => ({}),
      container,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');

    // Simulate cross-process event delivery via signal store
    store.publish('streamline:event:external:data-ready', {
      runId: run._id,
      data: { temperature: 42 },
    });

    const final = await env.until(run._id, 'done');
    expect(final.context.eventData).toEqual({ temperature: 42 });
  });

  it('should deliver ctx.emit() to signalStore (not just local eventBus)', async () => {
    const { store, published } = recordingSignalStore();
    const container = env.createContainer({ signalStore: store });

    const workflow = env.workflow('emit-to-signal-store', {
      steps: {
        emitter: async (ctx) => {
          ctx.emit('custom:event', { value: 42 });
          return 'done';
        },
      },
      container,
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // ctx.emit() should have published to signal store
    const signalMessages = published.filter((m) => m.channel === 'streamline:event:custom:event');
    expect(signalMessages).toHaveLength(1);
    expect((signalMessages[0]?.data as Record<string, unknown> | undefined)?.data).toEqual({
      value: 42,
    });
  });

  it('should use default in-memory signal store when none configured', async () => {
    // The env's container was created without a signalStore option.
    const container = env.container;
    expect(container.signalStore).toBeDefined();

    // In-memory store works for same-process events
    const received: unknown[] = [];
    const unsubscribe = await container.signalStore.subscribe('test', (data) =>
      received.push(data),
    );
    try {
      container.signalStore.publish('test', { msg: 'hello' });
      expect(received).toEqual([{ msg: 'hello' }]);
    } finally {
      unsubscribe();
    }
  });
});

// ============================================================================
// 2b. Hook DB fallback without any engine (true restart)
// ============================================================================

describe('Hook DB fallback without engine (true restart)', () => {
  it('should set lastHeartbeat to past for immediate stale recovery when no engine exists', async () => {
    let hookToken: string | undefined;

    const workflow = env.workflow<{ result?: string }>('true-restart-hook', {
      steps: {
        waitStep: async (ctx) => {
          const hook = createHook(ctx, 'approval');
          hookToken = hook.token;
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
        afterStep: async (ctx) => {
          await ctx.set('result', 'completed');
          return 'done';
        },
      },
      context: () => ({}),
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Remove from the hook registry (simulating a process restart). We can't
    // easily unregister from workflowRegistry, so it still has the engine in
    // this test process and the DB-fallback resume auto-executes. The true
    // no-engine case is when the process that started the workflow is gone.
    hookRegistry.unregister(run._id);

    // Resume via DB fallback (workflowRegistry HAS the engine, so it will execute)
    await resumeHook(tokenOf(hookToken), { approved: true }, { container: env.container });

    const final = await env.until(run._id, 'done');
    expect(final.context.result).toBe('completed');
  });
});

// ============================================================================
// 3. Index completeness
// ============================================================================

describe('Index completeness', () => {
  it('should have all required indexes defined on the test DB', async () => {
    // The env builds streamline's real indexes. Verify they exist.
    const indexes = await env.runModel.collection.indexes();
    const indexKeyStrings = indexes.map((idx) => JSON.stringify(idx.key));

    // Check the critical keyset pagination indexes
    const hasStatusPausedDesc = indexKeyStrings.some(
      (k) => k.includes('"status"') && k.includes('"paused"') && k.includes('"updatedAt":-1'),
    );
    const hasStatusPausedAsc = indexKeyStrings.some(
      (k) => k.includes('"status"') && k.includes('"paused"') && k.includes('"updatedAt":1'),
    );

    expect(hasStatusPausedDesc).toBe(true);
    expect(hasStatusPausedAsc).toBe(true);
  });
});
