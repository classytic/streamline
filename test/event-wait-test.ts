/**
 * Simple test to verify event-based waits work with globalEventBus.emit()
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createWorkflow, globalEventBus } from '../src/index.js';
import { setupTestDB, cleanupTestDB, teardownTestDB, waitFor } from './utils/setup.js';

describe('Event-Based Wait Fix', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await cleanupTestDB();
    await teardownTestDB();
  });

  it('should resume workflow when event is emitted via globalEventBus', async () => {
    let eventReceived = false;

    const workflow = createWorkflow('event-wait-test', {
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
          const eventData = ctx.getOutput<any>('waitForEvent');
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

    // Wait for event processing
    await waitFor(300);

    // Check that workflow resumed and completed
    const completed = await workflow.get(run._id);
    expect(completed?.status).toBe('done');
    expect(completed?.context.completed).toBe(true);
    expect(completed?.context.eventData).toEqual({ action: 'approved', userId: '123' });
    expect(eventReceived).toBe(true);

    workflow.shutdown();
  });
});
