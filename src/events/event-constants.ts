/**
 * Canonical arc-style event names for streamline.
 *
 * Format: `streamline:<resource>.<verb>`. Hosts subscribe with glob patterns
 * via the injected transport:
 *
 *   transport.subscribe('streamline:step.*', handler);
 *   transport.subscribe('streamline:workflow.completed', handler);
 *   transport.subscribe('streamline:*', handler);
 *
 * Legacy event names (`'step:started'`, `'workflow:completed'`) remain in
 * use on the internal `WorkflowEventBus` for backwards compatibility — the
 * bridge in `./bridge.ts` maps them to these canonical names when
 * re-publishing on the arc-shape transport.
 */

import type { WorkflowEventName } from '../core/events.js';

export const STREAMLINE_EVENTS = {
  // Step lifecycle
  STEP_STARTED: 'streamline:step.started',
  STEP_COMPLETED: 'streamline:step.completed',
  STEP_FAILED: 'streamline:step.failed',
  STEP_WAITING: 'streamline:step.waiting',
  STEP_SKIPPED: 'streamline:step.skipped',
  STEP_RETRY_SCHEDULED: 'streamline:step.retry-scheduled',
  STEP_COMPENSATED: 'streamline:step.compensated',

  // Workflow lifecycle
  WORKFLOW_STARTED: 'streamline:workflow.started',
  WORKFLOW_COMPLETED: 'streamline:workflow.completed',
  WORKFLOW_FAILED: 'streamline:workflow.failed',
  WORKFLOW_WAITING: 'streamline:workflow.waiting',
  WORKFLOW_RESUMED: 'streamline:workflow.resumed',
  WORKFLOW_CANCELLED: 'streamline:workflow.cancelled',
  WORKFLOW_RECOVERED: 'streamline:workflow.recovered',
  WORKFLOW_RETRY: 'streamline:workflow.retry',
  WORKFLOW_COMPENSATING: 'streamline:workflow.compensating',

  // Engine telemetry
  ENGINE_ERROR: 'streamline:engine.error',
  SCHEDULER_ERROR: 'streamline:scheduler.error',
  SCHEDULER_CIRCUIT_OPEN: 'streamline:scheduler.circuit-open',
} as const;

export type StreamlineEventName = (typeof STREAMLINE_EVENTS)[keyof typeof STREAMLINE_EVENTS];

/**
 * Map from legacy event-bus names to canonical streamline event names.
 * The bridge uses this to translate when republishing on a transport.
 *
 * The key type is the exhaustive `WorkflowEventName` union from
 * `core/events.ts` — adding a new event there without mapping it here is a
 * compile-time error, so the bridge cannot silently drop events.
 */
export const LEGACY_TO_CANONICAL: Readonly<Record<WorkflowEventName, StreamlineEventName>> = {
  'step:started': STREAMLINE_EVENTS.STEP_STARTED,
  'step:completed': STREAMLINE_EVENTS.STEP_COMPLETED,
  'step:failed': STREAMLINE_EVENTS.STEP_FAILED,
  'step:waiting': STREAMLINE_EVENTS.STEP_WAITING,
  'step:skipped': STREAMLINE_EVENTS.STEP_SKIPPED,
  'step:retry-scheduled': STREAMLINE_EVENTS.STEP_RETRY_SCHEDULED,
  'step:compensated': STREAMLINE_EVENTS.STEP_COMPENSATED,
  'workflow:started': STREAMLINE_EVENTS.WORKFLOW_STARTED,
  'workflow:completed': STREAMLINE_EVENTS.WORKFLOW_COMPLETED,
  'workflow:failed': STREAMLINE_EVENTS.WORKFLOW_FAILED,
  'workflow:waiting': STREAMLINE_EVENTS.WORKFLOW_WAITING,
  'workflow:resumed': STREAMLINE_EVENTS.WORKFLOW_RESUMED,
  'workflow:cancelled': STREAMLINE_EVENTS.WORKFLOW_CANCELLED,
  'workflow:recovered': STREAMLINE_EVENTS.WORKFLOW_RECOVERED,
  'workflow:retry': STREAMLINE_EVENTS.WORKFLOW_RETRY,
  'workflow:compensating': STREAMLINE_EVENTS.WORKFLOW_COMPENSATING,
  'engine:error': STREAMLINE_EVENTS.ENGINE_ERROR,
  'scheduler:error': STREAMLINE_EVENTS.SCHEDULER_ERROR,
  'scheduler:circuit-open': STREAMLINE_EVENTS.SCHEDULER_CIRCUIT_OPEN,
};
