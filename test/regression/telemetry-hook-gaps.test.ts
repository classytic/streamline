import type { Span, Tracer } from '@opentelemetry/api';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHook, resumeHook } from '../../src/index.js';
import { SchedulingService } from '../../src/scheduling/scheduling.service.js';
import { disableTelemetry, enableTelemetry } from '../../src/telemetry/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

class TestSpan {
  name: string;
  ended = false;
  attributes: Record<string, unknown> = {};

  constructor(name: string) {
    this.name = name;
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  setStatus(): void {}

  recordException(): void {}

  end(): void {
    this.ended = true;
  }
}

describe('Telemetry and Scheduled Hooks Fixes', () => {
  beforeEach(() => {
    disableTelemetry();
  });

  afterAll(() => {
    disableTelemetry();
  });

  it('should capture workflow events when using global event bus', async () => {
    const spans: TestSpan[] = [];
    const tracer = {
      startSpan: (name: string) => {
        const span = new TestSpan(name);
        spans.push(span);
        return span as unknown as Span;
      },
      startActiveSpan: (_name: string, fn: (...args: unknown[]) => unknown) => fn(),
    } as unknown as Tracer;

    // Enable telemetry with global event bus
    enableTelemetry({ tracer });

    // Create container with global event bus - this is the recommended pattern.
    // The env disposes it (detaching the bridge from the process-wide bus).
    const container = env.createContainer({ eventBus: 'global' });

    const workflow = env.workflow<{ value: number }, { value: number }>('telemetry-fix', {
      steps: {
        step1: async () => 'done',
      },
      context: (input) => ({ value: input.value }),
      container,
    });

    try {
      const run = await workflow.start({ value: 1 });
      await workflow.execute(run._id);

      // Telemetry should capture workflow and step spans
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.some((s) => s.name.includes('workflow'))).toBe(true);
      expect(spans.some((s) => s.name.includes('step'))).toBe(true);
    } finally {
      disableTelemetry();
    }
  });

  it('should resume hook for scheduled workflows after executeNow()', async () => {
    let hookToken: string | null = null;

    const workflow = env.workflow<{ approved?: boolean }>('scheduled-hook-fix', {
      steps: {
        request: async (ctx) => {
          const hook = createHook(ctx, 'approval');
          hookToken = hook.token;
          // ctx.wait(reason, { hookToken }) — the two-arg form the
          // fail-closed validator requires (streamline 2.3 hardening).
          // The validator reads waitingFor.data.hookToken; if not stored,
          // resume is rejected even with a matching token.
          await ctx.wait('Awaiting approval', { hookToken: hook.token });
        },
        process: async (ctx) => {
          const approval = ctx.getOutput<{ approved: boolean }>('request');
          return { approved: approval?.approved };
        },
      },
      context: () => ({}),
    });

    // SchedulingService now uses unified container with proper hook registration.
    // Its own container (as before), on the env's database.
    const service = new SchedulingService(workflow.definition, workflow.engine.handlers, {
      container: env.createContainer(),
    });

    const scheduledFor = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
    const run = await service.schedule({
      scheduledFor,
      timezone: 'UTC',
      input: {},
    });

    // executeNow() now registers the engine with hookRegistry
    const waitingRun = await service.executeNow(run._id);
    expect(waitingRun.status).toBe('waiting');
    expect(hookToken).toBeTruthy();

    // resumeHook should now work for scheduled workflows — through the
    // in-process registry (no container passed: the DB fallback would go to
    // the default-connection singleton, not the env's database — so only
    // the registry path can resume this run).
    try {
      const result = await resumeHook(String(hookToken), { approved: true });
      expect(result.run.status).toBe('done');
    } finally {
      service.shutdown(); // its engine's scheduler + timers (env disposes the container)
    }
  });
});
