/**
 * OpenTelemetry Integration (Opt-in)
 *
 * Install: npm install @opentelemetry/api @opentelemetry/sdk-trace-node
 *
 * @example
 * ```typescript
 * import { trace } from '@opentelemetry/api';
 * import { enableTelemetry } from '@classytic/streamline/telemetry';
 * import { createContainer, createWorkflow } from '@classytic/streamline';
 *
 * const tracer = trace.getTracer('my-app');
 * const container = createContainer({ eventBus: 'global' });
 *
 * enableTelemetry({ tracer });
 *
 * const workflow = createWorkflow('my-workflow', { steps: {...}, container });
 * ```
 */

import type { Span, Tracer } from '@opentelemetry/api';
import { globalEventBus, type WorkflowEventBus } from '../core/events.js';
import type { WorkflowEventPayload } from '../core/types.js';

interface TelemetryConfig {
  tracer: Tracer;
  /** Event bus to listen to (defaults to globalEventBus) */
  eventBus?: WorkflowEventBus;
}

const spans = new Map<string, Span>();
const listeners: Array<{ event: string; fn: (...args: unknown[]) => void; bus: WorkflowEventBus }> =
  [];
let currentEventBus: WorkflowEventBus | null = null;
let enabled = false;

export function enableTelemetry(config: TelemetryConfig): void {
  if (enabled) return;

  const { tracer } = config;
  const eventBus = config.eventBus ?? globalEventBus;
  currentEventBus = eventBus;
  enabled = true;

  const on = (event: string, handler: (payload: WorkflowEventPayload) => void) => {
    // Wrap handler to match event bus signature
    const fn = (...args: unknown[]) => handler(args[0] as WorkflowEventPayload);
    listeners.push({ event, fn, bus: eventBus });
    eventBus.on(event, fn);
  };

  on('workflow:started', ({ runId }) => {
    if (!runId) return;
    const span = tracer.startSpan(`workflow:${runId}`);
    span.setAttribute('workflow.runId', runId);
    spans.set(runId, span);
  });

  on('step:started', ({ runId, stepId }) => {
    if (!runId || !stepId) return;
    const span = tracer.startSpan(`step:${stepId}`);
    span.setAttribute('workflow.runId', runId);
    span.setAttribute('step.id', stepId);
    spans.set(`${runId}:${stepId}`, span);
  });

  on('step:completed', ({ runId, stepId }) => {
    if (!runId || !stepId) return;
    const span = spans.get(`${runId}:${stepId}`);
    if (span) {
      span.setStatus({ code: 1 });
      span.end();
      spans.delete(`${runId}:${stepId}`);
    }
  });

  on('step:failed', ({ runId, stepId, data }) => {
    if (!runId || !stepId) return;
    const span = spans.get(`${runId}:${stepId}`);
    if (span) {
      const errorData = data as { error?: Error } | undefined;
      span.setStatus({ code: 2, message: errorData?.error?.message });
      if (errorData?.error) span.recordException(errorData.error);
      span.end();
      spans.delete(`${runId}:${stepId}`);
    }
  });

  on('workflow:completed', ({ runId }) => {
    if (!runId) return;
    const span = spans.get(runId);
    if (span) {
      span.setStatus({ code: 1 });
      span.end();
      spans.delete(runId);
    }
  });

  on('workflow:failed', ({ runId, data }) => {
    if (!runId) return;
    const span = spans.get(runId);
    if (span) {
      const errorData = data as { error?: Error } | undefined;
      span.setStatus({ code: 2, message: errorData?.error?.message });
      if (errorData?.error) span.recordException(errorData.error);
      span.end();
      spans.delete(runId);
    }
  });
}

export function disableTelemetry(): void {
  if (!enabled) return;

  // Remove listeners from the event bus they were registered on
  listeners.forEach(({ event, fn, bus }) => {
    bus.off(event, fn);
  });
  listeners.length = 0;
  spans.clear();
  currentEventBus = null;
  enabled = false;
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

/**
 * Get the current event bus used by telemetry (for debugging)
 */
export function getTelemetryEventBus(): WorkflowEventBus | null {
  return currentEventBus;
}
