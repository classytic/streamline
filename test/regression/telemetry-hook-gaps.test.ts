import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  createWorkflow,
  createHook,
  resumeHook,
  createContainer,
} from '../../src/index.js';
import { SchedulingService } from '../../src/scheduling/scheduling.service.js';
import { enableTelemetry, disableTelemetry } from '../../src/telemetry/index.js';
import type { Span, Tracer } from '@opentelemetry/api';
import { WorkflowRunModel } from '../../src/storage/run.model.js';

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
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_URI || 'mongodb://localhost:27017/streamline-test'
      );
    }
  });

  beforeEach(async () => {
    await WorkflowRunModel.deleteMany({});
    disableTelemetry();
  });

  afterAll(async () => {
    disableTelemetry();
    await mongoose.connection.close();
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

    // Create container with global event bus - this is the recommended pattern
    const container = createContainer({ eventBus: 'global' });

    const workflow = createWorkflow<{ value: number }>('telemetry-fix', {
      steps: {
        step1: async () => 'done',
      },
      context: (input: { value: number }) => ({ value: input.value }),
      autoExecute: false,
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
      workflow.shutdown();
      disableTelemetry();
    }
  });

  it('should resume hook for scheduled workflows after executeNow()', async () => {
    let hookToken: string | null = null;

    const workflow = createWorkflow<{ approved?: boolean }>('scheduled-hook-fix', {
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
      autoExecute: false,
    });

    // SchedulingService now uses unified container with proper hook registration
    const service = new SchedulingService(workflow.definition, workflow.engine.handlers);

    try {
      const scheduledFor = new Date(Date.now() + 60_000)
        .toISOString()
        .slice(0, 19);
      const run = await service.schedule({
        scheduledFor,
        timezone: 'UTC',
        input: {},
      });

      // executeNow() now registers the engine with hookRegistry
      const waitingRun = await service.executeNow(run._id);
      expect(waitingRun.status).toBe('waiting');
      expect(hookToken).toBeTruthy();

      // resumeHook should now work for scheduled workflows
      const result = await resumeHook(hookToken as string, { approved: true });
      expect(result.run.status).toBe('done');
    } finally {
      workflow.shutdown();
    }
  });
});
