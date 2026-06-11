import { EventEmitter } from 'node:events';

/**
 * Typed event payloads for type-safe event handling
 */
export interface BaseEventPayload {
  runId: string;
  timestamp?: Date;
}

export interface StepEventPayload extends BaseEventPayload {
  stepId: string;
  attempt?: number;
}

export interface StepCompletedPayload extends StepEventPayload {
  data?: unknown;
}

export interface StepFailedPayload extends StepEventPayload {
  error: Error;
}

export interface StepRetryPayload extends StepEventPayload {
  maxRetries: number;
  retryAfter: Date;
}

/**
 * Non-durable streaming frame emitted via `ctx.stream(frame)` (v2.6).
 *
 * Contract: at-most-once, in-order per emitting process (`seq` is a
 * per-step-execution counter), NEVER persisted, side-effect-free on run
 * state. A crash loses unflushed frames; a retry restarts `seq` at 0.
 * Use for live UI progress (LLM tokens, percent-complete), never for
 * anything a later step depends on — durable data belongs in the step
 * output / checkpoint.
 */
export interface StepStreamPayload extends StepEventPayload {
  /** Monotonic per-step-execution frame counter (0-based; resets on retry). */
  seq: number;
  /** The host-supplied frame value. */
  frame: unknown;
}

export interface WorkflowCompletedPayload extends BaseEventPayload {
  data?: unknown;
}

export interface WorkflowFailedPayload extends BaseEventPayload {
  error: Error | { message: string; code?: string };
}

export interface WorkflowResumedPayload extends BaseEventPayload {
  stepId?: string;
  data?: unknown;
}

export interface EngineErrorPayload {
  runId?: string;
  error: Error;
  context: string;
}

/**
 * Event name to payload type mapping
 */
export interface EventPayloadMap {
  'step:started': StepEventPayload;
  'step:completed': StepCompletedPayload;
  'step:failed': StepFailedPayload;
  'step:waiting': StepEventPayload & { data?: unknown };
  'step:skipped': StepEventPayload;
  'step:retry-scheduled': StepRetryPayload;
  /** Non-durable streaming frames from `ctx.stream()` (v2.6, at-most-once). */
  'step:stream': StepStreamPayload;
  'workflow:started': BaseEventPayload;
  'workflow:completed': WorkflowCompletedPayload;
  'workflow:failed': WorkflowFailedPayload;
  'workflow:waiting': BaseEventPayload & { data?: unknown };
  'workflow:resumed': WorkflowResumedPayload;
  'workflow:cancelled': BaseEventPayload;
  'workflow:recovered': BaseEventPayload;
  'workflow:retry': BaseEventPayload;
  'workflow:compensating': BaseEventPayload & { data?: { steps: string[] } };
  'step:compensated': StepEventPayload;
  /** Durable saga (v2.4): all compensations completed (run terminal). */
  'workflow:compensated': BaseEventPayload;
  /** Durable saga (v2.4): a compensation exhausted retries (run terminal). */
  'workflow:compensation_failed': BaseEventPayload;
  'engine:error': EngineErrorPayload;
  'scheduler:error': EngineErrorPayload;
  'scheduler:circuit-open': { error: Error; context: string };
}

export type WorkflowEventName = keyof EventPayloadMap;

/**
 * Type-safe event bus with explicit payload types
 */
export class WorkflowEventBus extends EventEmitter {
  override emit<K extends WorkflowEventName>(event: K, payload: EventPayloadMap[K]): boolean;
  override emit(event: string, payload: unknown): boolean;
  override emit(event: string, payload: unknown): boolean {
    return super.emit(event, payload);
  }

  override on<K extends WorkflowEventName>(
    event: K,
    listener: (payload: EventPayloadMap[K]) => void,
  ): this;
  override on(event: string, listener: (payload: unknown) => void): this;
  override on(event: string, listener: (payload: unknown) => void): this {
    return super.on(event, listener);
  }

  override once<K extends WorkflowEventName>(
    event: K,
    listener: (payload: EventPayloadMap[K]) => void,
  ): this;
  override once(event: string, listener: (payload: unknown) => void): this;
  override once(event: string, listener: (payload: unknown) => void): this {
    return super.once(event, listener);
  }

  override off<K extends WorkflowEventName>(
    event: K,
    listener: (payload: EventPayloadMap[K]) => void,
  ): this;
  override off(event: string, listener: (payload: unknown) => void): this;
  override off(event: string, listener: (payload: unknown) => void): this {
    return super.off(event, listener);
  }
}

/**
 * Global event bus for cross-container event aggregation.
 * Use with createContainer({ eventBus: 'global' }) for telemetry integration.
 */
export const globalEventBus = new WorkflowEventBus();

// ============================================================================
// Event Sink — External event subscription (webhooks, queues, etc.)
// ============================================================================

/**
 * Callback for external event consumers.
 */
export type EventSinkHandler<K extends WorkflowEventName = WorkflowEventName> = (
  event: K,
  payload: EventPayloadMap[K],
) => void | Promise<void>;

/**
 * Options for creating an event sink.
 */
export interface EventSinkOptions {
  /** Only forward events matching these names */
  events?: WorkflowEventName[];
  /** Only forward events for this specific runId */
  runId?: string;
}

/**
 * Subscribe to workflow lifecycle events from outside the workflow.
 * Returns an unsubscribe function.
 *
 * @example
 * ```typescript
 * const unsub = createEventSink(engine.container.eventBus, {
 *   events: ['workflow:completed', 'workflow:failed'],
 * }, async (event, payload) => {
 *   await fetch(webhookUrl, {
 *     method: 'POST',
 *     body: JSON.stringify({ event, ...payload }),
 *   });
 * });
 *
 * // Later: stop listening
 * unsub();
 * ```
 */
export function createEventSink(
  eventBus: WorkflowEventBus,
  options: EventSinkOptions,
  handler: EventSinkHandler,
): () => void {
  const allEvents: WorkflowEventName[] = options.events ?? [
    'step:started',
    'step:completed',
    'step:failed',
    'step:waiting',
    'step:skipped',
    'step:retry-scheduled',
    'workflow:started',
    'workflow:completed',
    'workflow:failed',
    'workflow:waiting',
    'workflow:resumed',
    'workflow:cancelled',
    'workflow:recovered',
  ];

  const listeners: Array<{ event: WorkflowEventName; fn: (payload: any) => void }> = [];

  for (const event of allEvents) {
    const fn = (payload: any) => {
      // Filter by runId if specified
      if (options.runId && payload?.runId !== options.runId) return;
      // Fire-and-forget: don't let sink errors crash the engine
      try {
        const result = handler(event, payload);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Silently drop — sink errors must not affect workflow execution
      }
    };
    eventBus.on(event, fn);
    listeners.push({ event, fn });
  }

  return () => {
    for (const { event, fn } of listeners) {
      eventBus.off(event, fn);
    }
    listeners.length = 0;
  };
}
