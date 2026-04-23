/**
 * In-process `EventTransport` — structural match of arc's
 * `MemoryEventTransport`. Default fallback when the host doesn't provide one.
 *
 * Pattern matching is delegated to `@classytic/primitives`' `matchEventPattern`
 * (exact / `*` / `prefix.*` / `prefix:*`) — same three forms arc supports.
 *
 * The local `matches()` export is kept as a thin alias for backward
 * compatibility with internal callers (`bridge.ts`, tests).
 */

import type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';
import { matchEventPattern } from '@classytic/primitives/events';

interface Subscription {
  pattern: string;
  handler: EventHandler;
}

export interface InProcessBusOptions {
  /** Override the transport name exposed via `transport.name`. */
  name?: string;
  /** Logger for handler errors. Default: console.error. */
  onHandlerError?: (err: unknown, event: DomainEvent) => void;
}

export class InProcessStreamlineBus implements EventTransport {
  readonly name: string;
  private readonly subs = new Set<Subscription>();
  private readonly onHandlerError: (err: unknown, event: DomainEvent) => void;

  constructor(options: InProcessBusOptions = {}) {
    this.name = options.name ?? 'in-process-streamline';
    this.onHandlerError =
      options.onHandlerError ??
      ((err, event) => {
        // Fire-and-forget: one subscriber's failure must not crash siblings
        // or the engine. Mirrors arc's MemoryEventTransport behaviour.
        // eslint-disable-next-line no-console
        console.error(`[${this.name}] handler error for ${event.type}:`, err);
      });
  }

  async publish(event: DomainEvent): Promise<void> {
    for (const sub of this.subs) {
      if (!matches(sub.pattern, event.type)) continue;
      try {
        const result = sub.handler(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => this.onHandlerError(err, event));
        }
      } catch (err) {
        this.onHandlerError(err, event);
      }
    }
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    const sub: Subscription = { pattern, handler };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

/**
 * Glob matcher — thin alias over primitives' `matchEventPattern`. Kept as a
 * local export so `bridge.ts` and unit tests don't have to re-import from
 * primitives directly.
 */
export function matches(pattern: string, eventType: string): boolean {
  return matchEventPattern(pattern, eventType);
}
