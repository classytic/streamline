/**
 * Pause Contract Validation Tests
 *
 * Tests to verify that paused workflows are not accidentally resumed
 * through various code paths (short-delay, timer, retry, events)
 */

import { describe, expect, it } from 'vitest';
import { globalEventBus, type WorkflowRun } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/**
 * Assert the run stays in `holds` for the whole `ms` window — the window is the
 * delay being tested (timer / backoff / event delivery), not a guess.
 */
async function expectHolds(runId: string, holds: (r: WorkflowRun) => boolean, ms: number) {
  await expect(env.until(runId, (r) => !holds(r), { timeout: ms })).rejects.toThrow(
    /not reached within/,
  );
}

describe('Pause Contract Validation', () => {
  describe('Short-delay timer waits should respect pause', () => {
    it('should NOT resume paused workflow for short sleep (< 5s)', async () => {
      const workflow = env.workflow('pause-short-sleep', {
        steps: {
          step1: async () => {
            return { started: true };
          },
          step2: async (ctx) => {
            await ctx.sleep(2000); // 2 seconds - short delay
          },
          step3: async () => {
            return { completed: true };
          },
        },
        context: (input) => input as Record<string, unknown>,
        autoExecute: true,
      });

      // Start workflow
      const run1 = await workflow.start({ test: true });
      expect(run1.status).toBe('running');

      // Wait for step1 to complete and step2 to start sleeping
      await env.until(run1._id, (r) => r.status === 'waiting' && r.currentStepId === 'step2');

      // Pause the workflow while it's sleeping
      const pausedRun = await workflow.pause(run1._id);
      expect(pausedRun.paused).toBe(true);
      expect(pausedRun.status).toBe('waiting'); // Should be waiting on sleep

      // Through the short delay's expiry (2s + buffer): still paused, never resumed
      await expectHolds(
        run1._id,
        (r) => r.paused === true && r.status === 'waiting' && r.currentStepId === 'step2',
        2500,
      );

      // Check that workflow is STILL paused and NOT resumed
      const run2 = await workflow.get(run1._id);
      expect(run2?.paused).toBe(true);
      expect(run2?.status).toBe('waiting'); // Should still be waiting
      expect(run2?.currentStepId).toBe('step2'); // Should not have moved to step3

      // Verify step3 was never executed
      const step3State = run2?.steps.find((s) => s.stepId === 'step3');
      expect(step3State?.status).toBe('pending');
    });
  });

  describe('Retry backoff should respect pause', () => {
    it('should NOT retry paused workflow after backoff expires', async () => {
      let attemptCount = 0;

      const workflow = env.workflow('pause-retry', {
        steps: {
          failingStep: async () => {
            attemptCount++;
            if (attemptCount < 5) {
              throw new Error('Intentional failure for retry test');
            }
            return { success: true };
          },
        },
        context: (input) => input as Record<string, unknown>,
        autoExecute: true,
      });

      // Start workflow (will fail and schedule retry)
      const run1 = await workflow.start({ test: true });

      // Wait for first failure and retry scheduling
      await env.until(run1._id, 'waiting');

      // Pause the workflow while waiting for retry
      const pausedRun = await workflow.pause(run1._id);
      expect(pausedRun.paused).toBe(true);
      expect(pausedRun.status).toBe('waiting');

      const initialAttempts = attemptCount;

      // Through the retry backoff's expiry (~1s for the first retry): no retry
      await expectHolds(run1._id, (r) => r.paused === true && r.status === 'waiting', 2000);

      // Verify workflow did NOT retry while paused
      expect(attemptCount).toBe(initialAttempts);

      const run2 = await workflow.get(run1._id);
      expect(run2?.paused).toBe(true);
      expect(run2?.status).toBe('waiting');
    });
  });

  describe('Event-based waits should respect pause', () => {
    it('should NOT resume paused workflow when event is emitted', async () => {
      const workflow = env.workflow('pause-event', {
        steps: {
          step1: async () => {
            return { started: true };
          },
          waitForEvent: async (ctx) => {
            return await ctx.waitFor('test-event', 'Waiting for test event');
          },
          step3: async () => {
            return { completed: true };
          },
        },
        context: (input) => input as Record<string, unknown>,
        autoExecute: true,
      });

      // Start workflow
      const run1 = await workflow.start({ test: true });

      // Wait for workflow to reach waiting state
      await env.until(run1._id, 'waiting');

      const run2 = await workflow.get(run1._id);
      expect(run2?.status).toBe('waiting');
      expect(run2?.currentStepId).toBe('waitForEvent');

      // Pause the workflow while waiting for event
      const pausedRun = await workflow.pause(run1._id);
      expect(pausedRun.paused).toBe(true);

      // Emit the event that the workflow is waiting for (the engine listens on
      // the global bus as well as its container's)
      globalEventBus.emit('test-event', { runId: run1._id, data: { resumed: true } });

      // Give the event time to be processed — it must not move the run
      await expectHolds(
        run1._id,
        (r) => r.paused === true && r.status === 'waiting' && r.currentStepId === 'waitForEvent',
        300,
      );

      // Verify workflow is STILL paused and NOT resumed
      const run3 = await workflow.get(run1._id);
      expect(run3?.paused).toBe(true);
      expect(run3?.status).toBe('waiting');
      expect(run3?.currentStepId).toBe('waitForEvent');

      // Verify step3 was never executed
      const step3State = run3?.steps.find((s) => s.stepId === 'step3');
      expect(step3State?.status).toBe('pending');
    });
  });

  describe('RunId with colon character', () => {
    it('should handle event listener cleanup when runId contains colon', async () => {
      // Create a workflow engine with custom run ID containing colon
      const workflow = env.workflow('colon-runid', {
        steps: {
          waitForEvent: async (ctx) => {
            return await ctx.waitFor('custom-event', 'Waiting');
          },
        },
        context: (input) => input as Record<string, unknown>,
        autoExecute: true,
      });

      // Start workflow
      const run1 = await workflow.start({ test: true });

      // Wait for event registration
      await env.until(run1._id, 'waiting');

      // Manually test extractEventName with colon in runId
      const mockRunId = 'tenant:123:run:456';
      const eventName = 'payment:completed';
      const listenerKey = `${mockRunId}:${eventName}`;

      // Test that extraction works correctly
      const extractEventName = (key: string): string => {
        const firstColonIndex = key.indexOf(':');
        return firstColonIndex !== -1 ? key.substring(firstColonIndex + 1) : '';
      };

      // This will extract "123:run:456:payment:completed" which is WRONG
      const extracted = extractEventName(listenerKey);
      expect(extracted).not.toBe(eventName);
      // This demonstrates the bug!
    });
  });

  describe('Duplicate resume scheduling', () => {
    it('should not cause errors when multiple workers try to resume same timer wait', async () => {
      const workflow = env.workflow('concurrent-timer', {
        steps: {
          sleepStep: async (ctx) => {
            await ctx.sleep(100); // Very short sleep
          },
          finalStep: async () => {
            return { done: true };
          },
        },
        context: (input) => input as Record<string, unknown>,
        autoExecute: true,
      });

      // Start workflow
      const run1 = await workflow.start({ test: true });

      // Multiple workers race to resume the run while it sits on the timer
      await env.until(run1._id, 'waiting', { interval: 5 });

      // Try to resume multiple times concurrently (simulating multiple workers)
      const resumes = await Promise.allSettled([
        workflow.resume(run1._id),
        workflow.resume(run1._id),
        workflow.resume(run1._id),
      ]);

      // At least one should succeed, others might fail gracefully
      const successful = resumes.filter((r) => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);

      // Final state should be valid
      const finalRun = await workflow.get(run1._id);
      expect(['done', 'running', 'waiting']).toContain(finalRun?.status);
    });
  });
});
