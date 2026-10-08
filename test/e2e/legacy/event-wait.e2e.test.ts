/**
 * Verifies that `ctx.waitFor(eventName)` resumes workflows when the event is
 * emitted on `globalEventBus` — even when the workflow's container uses an
 * isolated bus (the default; the env's container is one).
 *
 * Fixed in v2.2: `handleEventWait()` now also subscribes on `globalEventBus`
 * (unless the container is already using it), so out-of-container emissions
 * wake the run.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { globalEventBus } from '../../../src/index.js';
import { useStreamlineEnv } from '../../helpers/index.js';

const env = useStreamlineEnv();

interface EventWaitContext {
  started: boolean;
  completed: boolean;
  eventData: unknown;
}

describe('Event-Based Wait Fix', () => {
  // The e2e tier runs in a singleFork — module state (including
  // `globalEventBus` and the global `workflowRegistry`) persists across
  // files. Strip any leftover `'user-action'` listeners a prior test left
  // behind so this test owns the event.
  afterEach(() => {
    globalEventBus.removeAllListeners('user-action');
  });

  it('should resume workflow when event is emitted via globalEventBus', async () => {
    globalEventBus.removeAllListeners('user-action'); // defensive entry

    let eventReceived = false;

    const workflow = env.workflow<EventWaitContext>('event-wait-test', {
      steps: {
        start: async (ctx) => {
          await ctx.set('started', true);
          return { ready: true };
        },
        waitForEvent: async (ctx) => {
          // Wait for 'user-action' event
          return await ctx.waitFor('user-action', 'Waiting for user action');
        },
        complete: async (ctx) => {
          eventReceived = true;
          const eventData = ctx.getOutput<unknown>('waitForEvent');
          await ctx.set('completed', true);
          await ctx.set('eventData', eventData);
          return { done: true };
        },
      },
      context: () => ({ started: false, completed: false, eventData: null }),
    });

    // Start workflow
    const run = await workflow.start({});

    // Execute until it waits
    await workflow.execute(run._id);

    // Check that workflow is waiting
    const waiting = await workflow.get(run._id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.currentStepId).toBe('waitForEvent');
    expect(waiting?.steps[1]?.waitingFor?.type).toBe('event');
    expect(waiting?.steps[1]?.waitingFor?.eventName).toBe('user-action');

    // Emit event via globalEventBus
    globalEventBus.emit('user-action', {
      runId: run._id,
      data: { action: 'approved', userId: '123' },
    });

    // Wait for the event to be processed, then check the run resumed and completed
    await env.until(run._id, 'done');
    const completed = await workflow.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.completed).toBe(true);
    expect(completed?.context.eventData).toEqual({ action: 'approved', userId: '123' });
    expect(eventReceived).toBe(true);
  });
});
