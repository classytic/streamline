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

/**
 * Operator pause (v2.7). Emitted by `engine.pause(runId, { reason })` when it
 * successfully transitions a running/waiting run to `paused`. Carries the
 * optional operator reason. Distinct from `workflow:resumed`, which is reused
 * for operator resume (and hook resume) — see the honesty note on
 * `engine.pause`: pause takes effect at the NEXT step boundary, not mid-step.
 */
export interface WorkflowPausedPayload extends BaseEventPayload {
  reason?: string;
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
  /** Operator pause of a running/waiting run (v2.7). */
  'workflow:paused': WorkflowPausedPayload;
  /** `data.reason` present when `engine.cancel(runId, { reason })` supplied one (v2.7). */
  'workflow:cancelled': BaseEventPayload & { data?: { reason?: string } };
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
 * Compile-time-exhaustive registry of every workflow event name.
 *
 * `Record<WorkflowEventName, true>` is the exhaustiveness guard: adding an
 * event to `EventPayloadMap` without listing it here is a type error, so
 * runtime consumers that need "all events" (the event sink's default list)
 * can never silently drop a new event — the drift class that made the
 * pre-2.7 hand-rolled sink default miss `workflow:retry`, the saga
 * lifecycle events, `step:compensated`, `step:stream`, `engine:error`, and
 * `scheduler:*`. Same pattern as `LEGACY_TO_CANONICAL` in
 * `events/event-constants.ts` (kept local to avoid a circular import).
 */
const WORKFLOW_EVENT_NAME_REGISTRY: Readonly<Record<WorkflowEventName, true>> = {
  'step:started': true,
  'step:completed': true,
  'step:failed': true,
  'step:waiting': true,
  'step:skipped': true,
  'step:retry-scheduled': true,
  'step:stream': true,
  'workflow:started': true,
  'workflow:completed': true,
  'workflow:failed': true,
  'workflow:waiting': true,
  'workflow:resumed': true,
  'workflow:paused': true,
  'workflow:cancelled': true,
  'workflow:recovered': true,
  'workflow:retry': true,
  'workflow:compensating': true,
  'step:compensated': true,
  'workflow:compensated': true,
  'workflow:compensation_failed': true,
  'engine:error': true,
  'scheduler:error': true,
  'scheduler:circuit-open': true,
};

/** Every workflow event name, derived from the exhaustive registry above. */
export const ALL_WORKFLOW_EVENT_NAMES: readonly WorkflowEventName[] = Object.keys(
  WORKFLOW_EVENT_NAME_REGISTRY,
) as WorkflowEventName[];

/**
 * Events EXCLUDED from the event sink's default subscription (explicit
 * named set — subtracted from the exhaustive list, never hand-rolled):
 *
 *   - `step:stream` — non-durable, at-most-once, high-frequency frames
 *     (`ctx.stream()`, potentially one per LLM token). Forwarding them to a
 *     webhook/queue sink by default would flood it; hosts that want frames
 *     opt in via `options.events`.
 *
 * Everything else — including telemetry (`engine:error`, `scheduler:*`) and
 * the saga lifecycle — IS forwarded by default.
 */
export const EVENT_SINK_DEFAULT_EXCLUSIONS: ReadonlySet<WorkflowEventName> = new Set([
  'step:stream',
]);

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
  // Default: the compile-time-exhaustive event list minus the named
  // exclusion set (see EVENT_SINK_DEFAULT_EXCLUSIONS). Pre-2.7 this was a
  // hand-rolled 13-event array that had silently drifted behind the event
  // map (missing workflow:retry, saga lifecycle, step:compensated,
  // step:stream, engine:error, scheduler:*).
  const allEvents: readonly WorkflowEventName[] =
    options.events ??
    ALL_WORKFLOW_EVENT_NAMES.filter((event) => !EVENT_SINK_DEFAULT_EXCLUSIONS.has(event));

  const listeners: Array<{ event: WorkflowEventName; fn: (payload: unknown) => void }> = [];

  for (const event of allEvents) {
    const fn = (payload: unknown) => {
      // Filter by runId if specified
      if (options.runId && (payload as { runId?: string } | undefined)?.runId !== options.runId)
        return;
      // Fire-and-forget: don't let sink errors crash the engine
      try {
        const result = handler(event, payload as EventPayloadMap[typeof event]);
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
