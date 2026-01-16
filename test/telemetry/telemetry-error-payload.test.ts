import { describe, it, expect, afterEach } from 'vitest';
import { enableTelemetry, disableTelemetry } from '../../src/telemetry/index.js';
import { globalEventBus } from '../../src/core/events.js';

class FakeSpan {
  name: string;
  status?: { code: number; message?: string };
  exceptions: unknown[] = [];
  ended = false;

  constructor(name: string) {
    this.name = name;
  }

  setAttribute() {
    // no-op for tests
  }

  setStatus(status: { code: number; message?: string }) {
    this.status = status;
  }

  recordException(error: unknown) {
    this.exceptions.push(error);
  }

  end() {
    this.ended = true;
  }
}

class FakeTracer {
  spans: FakeSpan[] = [];

  startSpan(name: string) {
    const span = new FakeSpan(name);
    this.spans.push(span);
    return span;
  }
}

describe('Telemetry error payloads', () => {
  afterEach(() => {
    disableTelemetry();
  });

  it('records error details for step:failed', () => {
    const tracer = new FakeTracer();
    enableTelemetry({ tracer });

    globalEventBus.emit('step:started', { runId: 'run-1', stepId: 'step-1' });

    const error = new Error('step failed');
    globalEventBus.emit('step:failed', { runId: 'run-1', stepId: 'step-1', data: { error } });

    const span = tracer.spans.find((s) => s.name === 'step:step-1');
    expect(span?.ended).toBe(true);
    expect(span?.status?.message).toBe('step failed');
    expect(span?.exceptions[0]).toBe(error);
  });

  it('records error details for workflow:failed', () => {
    const tracer = new FakeTracer();
    enableTelemetry({ tracer });

    globalEventBus.emit('workflow:started', { runId: 'run-2' });

    const error = new Error('workflow failed');
    globalEventBus.emit('workflow:failed', { runId: 'run-2', data: { error } });

    const span = tracer.spans.find((s) => s.name === 'workflow:run-2');
    expect(span?.ended).toBe(true);
    expect(span?.status?.message).toBe('workflow failed');
    expect(span?.exceptions[0]).toBe(error);
  });
});
