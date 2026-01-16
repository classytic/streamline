import { EventEmitter } from 'events';

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
  'workflow:started': BaseEventPayload;
  'workflow:completed': WorkflowCompletedPayload;
  'workflow:failed': WorkflowFailedPayload;
  'workflow:waiting': BaseEventPayload & { data?: unknown };
  'workflow:resumed': WorkflowResumedPayload;
  'workflow:cancelled': BaseEventPayload;
  'workflow:recovered': BaseEventPayload;
  'workflow:retry': BaseEventPayload;
  'engine:error': EngineErrorPayload;
  'scheduler:error': EngineErrorPayload;
  'scheduler:circuit-open': { error: Error; context: string };
}

export type WorkflowEventName = keyof EventPayloadMap;

/**
 * Type-safe event bus with explicit payload types
 */
export class WorkflowEventBus extends EventEmitter {
  emit<K extends WorkflowEventName>(event: K, payload: EventPayloadMap[K]): boolean;
  emit(event: string, payload: unknown): boolean;
  emit(event: string, payload: unknown): boolean {
    return super.emit(event, payload);
  }

  on<K extends WorkflowEventName>(event: K, listener: (payload: EventPayloadMap[K]) => void): this;
  on(event: string, listener: (payload: unknown) => void): this;
  on(event: string, listener: (payload: unknown) => void): this {
    return super.on(event, listener);
  }

  once<K extends WorkflowEventName>(event: K, listener: (payload: EventPayloadMap[K]) => void): this;
  once(event: string, listener: (payload: unknown) => void): this;
  once(event: string, listener: (payload: unknown) => void): this {
    return super.once(event, listener);
  }

  off<K extends WorkflowEventName>(event: K, listener: (payload: EventPayloadMap[K]) => void): this;
  off(event: string, listener: (payload: unknown) => void): this;
  off(event: string, listener: (payload: unknown) => void): this {
    return super.off(event, listener);
  }
}

/**
 * Global event bus for cross-container event aggregation.
 * Use with createContainer({ eventBus: 'global' }) for telemetry integration.
 */
export const globalEventBus = new WorkflowEventBus();
