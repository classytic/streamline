/**
 * Event-sink default list — no-drift guarantees (2.7.0).
 *
 * Pre-2.7 `createEventSink`'s default event array was hand-rolled and had
 * silently drifted behind the event map (missing `workflow:retry`, the saga
 * lifecycle events, `step:compensated`, `step:stream`, `engine:error`,
 * `scheduler:*`). It is now derived from a compile-time-exhaustive registry
 * minus an explicit named exclusion set. These tests pin that contract:
 *
 *   1. The runtime registry matches the canonical constants map
 *      (`LEGACY_TO_CANONICAL`, itself `Record<WorkflowEventName, ...>`).
 *   2. Every event name is either delivered by a default sink or is a
 *      member of the named exclusion set — nothing can be silently dropped.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_WORKFLOW_EVENT_NAMES,
  createEventSink,
  EVENT_SINK_DEFAULT_EXCLUSIONS,
  WorkflowEventBus,
  type WorkflowEventName,
} from '../../src/core/events.js';
import { LEGACY_TO_CANONICAL } from '../../src/events/event-constants.js';

describe('event-sink default list (no-drift)', () => {
  it('the runtime event registry matches the canonical constants map exactly', () => {
    const fromConstants = Object.keys(LEGACY_TO_CANONICAL).sort();
    const fromRegistry = [...ALL_WORKFLOW_EVENT_NAMES].sort();
    expect(fromRegistry).toEqual(fromConstants);
  });

  it('every event is either in the sink default list or the named exclusion set', () => {
    const bus = new WorkflowEventBus();
    const received = new Set<WorkflowEventName>();

    const unsub = createEventSink(bus, {}, (event) => {
      received.add(event);
    });

    // Emit every known event once.
    for (const event of ALL_WORKFLOW_EVENT_NAMES) {
      bus.emit(event, { runId: 'r1' });
    }

    for (const event of ALL_WORKFLOW_EVENT_NAMES) {
      if (EVENT_SINK_DEFAULT_EXCLUSIONS.has(event)) {
        // Excluded events must NOT be delivered by default…
        expect(received.has(event), `${event} should be excluded by default`).toBe(false);
      } else {
        // …and every other event MUST be.
        expect(received.has(event), `${event} silently dropped from sink defaults`).toBe(true);
      }
    }

    unsub();
  });

  it('the exclusion set contains only known event names', () => {
    for (const event of EVENT_SINK_DEFAULT_EXCLUSIONS) {
      expect(ALL_WORKFLOW_EVENT_NAMES).toContain(event);
    }
  });

  it('explicit options.events still overrides the default list (opt-in to excluded events)', () => {
    const bus = new WorkflowEventBus();
    const received: WorkflowEventName[] = [];

    const unsub = createEventSink(bus, { events: ['step:stream'] }, (event) => {
      received.push(event);
    });

    bus.emit('step:stream', { runId: 'r1', stepId: 's1', seq: 0, frame: 'tok' });
    bus.emit('workflow:completed', { runId: 'r1' });

    expect(received).toEqual(['step:stream']);
    unsub();
  });
});
