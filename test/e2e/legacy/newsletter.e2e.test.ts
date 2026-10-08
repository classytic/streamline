/**
 * LEGACY SETUP (global connection) on purpose: the subject is the exported
 * `newsletterWorkflow` docs example, a module-level singleton created without
 * a container (autoExecute) — bound to the default mongoose connection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newsletterWorkflow } from '../../../docs/examples/newsletter-automation.js';
import { setupTestDB, waitUntil } from '../../utils/setup.js';

describe('Newsletter Automation', () => {
  beforeAll(setupTestDB);

  afterAll(async () => {
    newsletterWorkflow.shutdown();
  });

  it('should execute newsletter workflow until human review', async () => {
    const run = await newsletterWorkflow.start({
      topic: 'TypeScript Best Practices',
      audience: 'developers',
    });

    // Wait for autoExecute to reach waiting state (at review step)
    await waitUntil(async () => {
      const latest = await newsletterWorkflow.get(run._id);
      return latest?.status === 'waiting';
    }, 5000);

    const result = await newsletterWorkflow.get(run._id);

    expect(result?.status).toBe('waiting');
    expect(result?.context.subscribers).toBeDefined();
    expect(result?.context.subscribers).toHaveLength(100);
    expect(result?.context.content).toBeDefined();
    expect(result?.context.content?.subject).toContain('Weekly TypeScript Best Practices Update');

    const reviewStep = result?.steps.find((s) => s.stepId === 'review');
    expect(reviewStep?.status).toBe('waiting');
    expect(reviewStep?.waitingFor?.type).toBe('human');
  });

  it('should complete after approval', async () => {
    const run = await newsletterWorkflow.start({
      topic: 'AI and Machine Learning',
      audience: 'developers',
    });

    // Wait for autoExecute to reach waiting state
    await waitUntil(async () => {
      const latest = await newsletterWorkflow.get(run._id);
      return latest?.status === 'waiting';
    }, 5000);

    const resumedRun = await newsletterWorkflow.resume(run._id, {
      approved: true,
      reviewer: 'admin',
    });

    expect(resumedRun.status).toBe('done');
    expect(resumedRun.context.sent).toBeDefined();
    expect(resumedRun.context.sent?.total).toBe(100);
    expect(resumedRun.context.sent?.successful).toBeGreaterThan(80);

    const trackStep = resumedRun.steps.find((s) => s.stepId === 'trackResults');
    expect(trackStep?.status).toBe('done');
  });

  it('should generate content for different audiences', async () => {
    const audiences = ['developers', 'marketers', 'executives'] as const;

    for (const audience of audiences) {
      const run = await newsletterWorkflow.start({
        topic: 'Product Updates',
        audience,
      });

      // Wait for autoExecute to reach waiting state
      await waitUntil(async () => {
        const latest = await newsletterWorkflow.get(run._id);
        return latest?.status === 'waiting';
      }, 5000);

      const result = await newsletterWorkflow.get(run._id);

      expect(result?.context.content).toBeDefined();
      expect(result?.context.content?.subject).toContain('Product Updates');
      expect(result?.status).toBe('waiting');
    }
  });
});
