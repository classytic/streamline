/**
 * Arc-compatible event layer — public surface.
 *
 *   import { createEvent, InProcessStreamlineBus, STREAMLINE_EVENTS } from '@classytic/streamline';
 *
 * Hosts already using arc can drop in any arc transport directly:
 *
 *   import { RedisEventTransport } from '@classytic/arc/events';
 *   const engine = createContainer({ eventTransport: new RedisEventTransport(...) });
 */

export type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';
export { bridgeBusToTransport } from './bridge.js';
export {
  LEGACY_TO_CANONICAL,
  STREAMLINE_EVENTS,
  type StreamlineEventName,
} from './event-constants.js';
export { createEvent, type EventContext } from './helpers.js';
export { type InProcessBusOptions, InProcessStreamlineBus, matches } from './in-process-bus.js';
