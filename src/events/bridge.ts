/**
 * Bridge from the internal `WorkflowEventBus` to an arc-shape `EventTransport`.
 *
 * Why a bridge instead of replacing the bus:
 *
 *   The existing bus is referenced by 20+ source files and every e2e test.
 *   Ripping it out would be a major breaking change. Instead, we subscribe
 *   to every legacy event once and republish it on the transport using the
 *   canonical `streamline:<resource>.<verb>` name + arc `DomainEvent` shape.
 *
 *   Hosts that pass `eventTransport: new RedisEventTransport(...)` into
 *   `createContainer({ eventTransport })` get glob-subscribe over the wire.
 *   Hosts that don't pass anything get the in-process bus by default.
 */

import type { EventTransport } from '@classytic/primitives/events';
import type { EventPayloadMap, WorkflowEventBus, WorkflowEventName } from '../core/events.js';
import { LEGACY_TO_CANONICAL } from './event-constants.js';
import { createEvent, type EventContext } from './helpers.js';

// `LEGACY_TO_CANONICAL` is typed as `Record<WorkflowEventName, ...>`, so the
// keys are guaranteed exhaustive at compile time — any new event added to
// `EventPayloadMap` without updating the map is a type error over in
// event-constants.ts before it can reach this file.
const LEGACY_NAMES = Object.keys(LEGACY_TO_CANONICAL) as WorkflowEventName[];

/**
 * Extract minimal `EventContext` fields from a legacy payload so the
 * canonical event carries `resourceId` + `correlationId` when available.
 */
function deriveContext(payload: unknown): EventContext | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const ctx: EventContext = {};
  if (typeof p.runId === 'string') {
    ctx.resource = 'workflow-run';
    ctx.resourceId = p.runId;
  }
  if (typeof p.correlationId === 'string') ctx.correlationId = p.correlationId;
  if (typeof p.organizationId === 'string') ctx.organizationId = p.organizationId;
  // Legacy payloads surface the actor as `userId`; map onto primitives' `actorId`.
  if (typeof p.userId === 'string') ctx.actorId = p.userId;
  if (typeof p.actorId === 'string') ctx.actorId = p.actorId;
  return ctx;
}

/**
 * Subscribe to every legacy event on `bus` and republish on `transport`
 * using canonical names + arc `DomainEvent` shape. Returns an unsubscribe
 * function that tears down the bridge.
 */
export function bridgeBusToTransport(bus: WorkflowEventBus, transport: EventTransport): () => void {
  const listeners: Array<{ event: WorkflowEventName; fn: (payload: unknown) => void }> = [];

  for (const legacyName of LEGACY_NAMES) {
    const canonical = LEGACY_TO_CANONICAL[legacyName];
    if (!canonical) continue;

    const fn = (payload: unknown) => {
      // Fire-and-forget: transport publish failures must not crash the bus.
      transport
        .publish(
          createEvent(
            canonical,
            payload as EventPayloadMap[typeof legacyName],
            deriveContext(payload),
          ),
        )
        .catch(() => {
          // The transport is responsible for its own error handling/retry.
          // Swallow here so one slow subscriber doesn't stall the engine.
        });
    };

    bus.on(legacyName, fn);
    listeners.push({ event: legacyName, fn });
  }

  return () => {
    for (const { event, fn } of listeners) {
      bus.off(event, fn);
    }
  };
}
