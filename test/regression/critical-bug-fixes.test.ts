/**
 * Critical Bug Fix Regression Tests
 *
 * Validates fixes for:
 * 1. Double-claim bug: scheduler + executeRetry() both claiming scheduled workflows
 * 2. Stale recovery wedge: step.status='running' blocks re-execution after crash
 * 3. Concurrent resume() race condition
 * 4. Pluggable signal store
 * 5. Write concern durability
 */

import { describe, expect, it } from 'vitest';
import type { SignalStore } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// ============================================================================
// Bug #1: Double-claim in scheduler for scheduled workflows
// ============================================================================

describe('Scheduled workflow execution (double-claim fix)', () => {
  it('should execute a scheduled workflow via executeRetry without double-claim', async () => {
    const workflow = env.workflow<{ executed: boolean }>('scheduled-exec', {
      steps: {
        run: async (ctx) => {
          await ctx.set('executed', true);
          return 'done';
        },
      },
      context: () => ({ executed: false }),
    });

    // Create a "draft" workflow with scheduling metadata to simulate a scheduled run
    const run = await workflow.start({});

    // Manually set it back to draft with scheduling (simulating SchedulingService behavior)
    const pastTime = new Date(Date.now() - 60_000);
    await env.runModel.updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'draft',
          scheduling: {
            scheduledFor: pastTime.toISOString(),
            timezone: 'UTC',
            localTimeDisplay: pastTime.toISOString(),
            executionTime: pastTime,
            isDSTTransition: false,
          },
        },
      },
    );

    // executeRetry should claim draft→running and execute
    const result = await workflow.engine.executeRetry(run._id);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('done');
    expect(result?.context.executed).toBe(true);
  });

  it('should not execute a scheduled workflow that is not yet due', async () => {
    const workflow = env.workflow('scheduled-not-due', {
      steps: {
        run: async () => 'done',
      },
    });

    const run = await workflow.start({});

    // Set to draft with FUTURE scheduling
    const futureTime = new Date(Date.now() + 60 * 60 * 1000);
    // (runs.update also clears the cache, so the engine reads from DB)
    await env.runs.update(run._id, {
      $set: {
        status: 'draft',
        scheduling: {
          scheduledFor: futureTime.toISOString(),
          timezone: 'UTC',
          localTimeDisplay: futureTime.toISOString(),
          executionTime: futureTime,
          isDSTTransition: false,
        },
      },
    });

    // executeRetry should NOT claim it (not yet due)
    const result = await workflow.engine.executeRetry(run._id);
    expect(result).toBeNull();

    // Verify still in draft (read directly from DB)
    const current = await env.runs.get(run._id);
    expect(current?.status).toBe('draft');
  });
});

// ============================================================================
// Bug #2: Stale recovery for mid-step crash
// ============================================================================

describe('Stale recovery (mid-step crash fix)', () => {
  it('should recover a workflow where step crashed mid-execution', async () => {
    let attempts = 0;

    const workflow = env.workflow<{ recovered: boolean }>('stale-mid-step', {
      steps: {
        crashable: async (ctx) => {
          attempts++;
          await ctx.set('recovered', true);
          return 'recovered';
        },
      },
      context: () => ({ recovered: false }),
    });

    // A mid-step crash: run `running`, step `running` (attempt 1), heartbeat stale.
    const run = await env.runs.staleRunning(workflow, {
      step: 'crashable',
      heartbeatAgeMs: 10 * 60 * 1000,
    });

    // recoverStale should reset step to pending and re-execute
    const recovered = await workflow.engine.recoverStale(run._id, 5 * 60 * 1000);
    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe('done');
    expect(recovered?.context.recovered).toBe(true);

    // Step should have been re-executed (attempt 2 after reset)
    expect(attempts).toBe(1); // Only 1 successful attempt after recovery
  });

  it('should NOT recover workflow with fresh heartbeat even if step is running', async () => {
    const workflow = env.workflow('stale-fresh-heartbeat', {
      steps: {
        step1: async () => 'done',
      },
    });

    // Running with a FRESH heartbeat (another worker is active)
    const run = await env.runs.staleRunning(workflow, { step: 'step1', heartbeatAgeMs: 0 });

    const result = await workflow.engine.recoverStale(run._id, 5 * 60 * 1000);
    expect(result).toBeNull(); // Should not recover
  });
});

// ============================================================================
// Bug #3: Concurrent resume() race condition
// ============================================================================

describe('Concurrent resume() atomic claim', () => {
  it('should atomically unpause — second resume gets current state, not double-execution', async () => {
    let executionCount = 0;

    const workflow = env.workflow('atomic-resume', {
      steps: {
        waitStep: async (ctx) => ctx.wait('approval'),
        after: async () => {
          executionCount++;
          return 'done';
        },
      },
    });

    const run = await workflow.start({});
    await workflow.execute(run._id);

    // Pause
    await workflow.pause(run._id);

    // Two concurrent resumes
    const [r1, r2] = await Promise.all([
      workflow.resume(run._id, { from: 'A' }),
      workflow.resume(run._id, { from: 'B' }),
    ]);

    // Both succeed, but only one unpause claim should win
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    await env.until(run._id, 'done');

    const final = await workflow.get(run._id);
    expect(final?.status).toBe('done');
    // The "after" step should only run once
    expect(executionCount).toBe(1);
  });
});

// ============================================================================
// Pluggable Signal Store
// ============================================================================

describe('Pluggable signal store', () => {
  it('should use default in-memory signal store', () => {
    const container = env.createContainer();
    expect(container.signalStore).toBeDefined();
    expect(typeof container.signalStore.publish).toBe('function');
    expect(typeof container.signalStore.subscribe).toBe('function');
  });

  it('should accept custom signal store (e.g., mock Redis adapter)', () => {
    const messages: Array<{ channel: string; data: unknown }> = [];
    const listeners = new Map<string, Set<(data: unknown) => void>>();

    const mockRedisStore: SignalStore = {
      publish(channel, data) {
        messages.push({ channel, data });
        const handlers = listeners.get(channel);
        if (handlers) for (const h of handlers) h(data);
      },
      subscribe(channel, handler) {
        let handlers = listeners.get(channel);
        if (!handlers) {
          handlers = new Set();
          listeners.set(channel, handlers);
        }
        handlers.add(handler);
        return () => {
          listeners.get(channel)?.delete(handler);
        };
      },
    };

    const container = env.createContainer({ signalStore: mockRedisStore });
    expect(container.signalStore).toBe(mockRedisStore);

    // Test pub/sub works
    const received: unknown[] = [];
    container.signalStore.subscribe('test-channel', (data) => received.push(data));
    container.signalStore.publish('test-channel', { msg: 'hello' });

    expect(received).toEqual([{ msg: 'hello' }]);
    expect(messages).toHaveLength(1);
  });

  it('should support unsubscribe via returned function', () => {
    const container = env.createContainer();
    const received: unknown[] = [];

    const unsub = container.signalStore.subscribe('ch', (data) => received.push(data));
    container.signalStore.publish('ch', 1);
    expect(received).toEqual([1]);

    // Unsubscribe
    (unsub as () => void)();
    container.signalStore.publish('ch', 2);
    expect(received).toEqual([1]); // No second message
  });
});

// ============================================================================
// Write Concern
// ============================================================================

describe('Write concern on schema', () => {
  it('should configure majority write concern with journaling', () => {
    const wc = env.runModel.schema.options.writeConcern;
    expect(wc).toBeDefined();
    expect(wc?.w).toBe('majority');
    expect(wc?.j).toBe(true);
  });
});

// ============================================================================
// Missing Indexes
// ============================================================================

describe('Compound indexes for scheduler/pagination', () => {
  it('should define keyset pagination compound indexes on the schema', () => {
    // Check schema-level index definitions (these get auto-created by Mongoose on ensureIndexes)
    const schemaIndexes = env.runModel.schema.indexes();
    const indexFields = schemaIndexes.map(([fields]) => Object.keys(fields));

    // Check for the compound indexes we added for keyset pagination
    const hasStatusPausedUpdated = indexFields.some(
      (keys) =>
        keys.includes('status') &&
        keys.includes('paused') &&
        keys.includes('updatedAt') &&
        keys.includes('_id'),
    );

    expect(hasStatusPausedUpdated).toBe(true);
  });
});
