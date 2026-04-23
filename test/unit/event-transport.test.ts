/**
 * Unit tests for the arc-shape event transport layer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEvent,
  InProcessStreamlineBus,
  LEGACY_TO_CANONICAL,
  matches,
  STREAMLINE_EVENTS,
} from '../../src/events/index.js';

describe('matches (glob matcher)', () => {
  it('matches exact names', () => {
    expect(matches('streamline:workflow.completed', 'streamline:workflow.completed')).toBe(true);
    expect(matches('streamline:workflow.completed', 'streamline:workflow.failed')).toBe(false);
  });

  it('matches `*` (everything)', () => {
    expect(matches('*', 'any:event.name')).toBe(true);
  });

  it('matches `resource.*` globs', () => {
    expect(matches('streamline:workflow.*', 'streamline:workflow.completed')).toBe(true);
    expect(matches('streamline:workflow.*', 'streamline:workflow.failed')).toBe(true);
    expect(matches('streamline:workflow.*', 'streamline:step.completed')).toBe(false);
  });

  it('matches `namespace:*` globs', () => {
    expect(matches('streamline:*', 'streamline:workflow.completed')).toBe(true);
    expect(matches('streamline:*', 'streamline:step.started')).toBe(true);
    expect(matches('streamline:*', 'revenue:payment.verified')).toBe(false);
  });
});

describe('createEvent', () => {
  it('fills in meta.id and meta.timestamp', () => {
    const evt = createEvent('streamline:workflow.completed', { runId: 'r1' });
    expect(evt.type).toBe('streamline:workflow.completed');
    expect(evt.payload).toEqual({ runId: 'r1' });
    expect(typeof evt.meta.id).toBe('string');
    expect(evt.meta.timestamp).toBeInstanceOf(Date);
  });

  it('threads context fields into meta', () => {
    // EventContext now extends primitives' OperationContext: `actorId` is the
    // canonical name on the context; it's mapped onto the arc-compatible
    // `meta.userId` field so the wire contract is unchanged.
    const evt = createEvent('streamline:workflow.completed', { runId: 'r1' }, {
      actorId: 'u1',
      organizationId: 'org-42',
      correlationId: 'trace-abc',
      resource: 'workflow-run',
      resourceId: 'r1',
    });
    expect(evt.meta.userId).toBe('u1');
    expect(evt.meta.organizationId).toBe('org-42');
    expect(evt.meta.correlationId).toBe('trace-abc');
    expect(evt.meta.resource).toBe('workflow-run');
    expect(evt.meta.resourceId).toBe('r1');
  });
});

describe('InProcessStreamlineBus', () => {
  it('publishes to exact-name subscribers', async () => {
    const bus = new InProcessStreamlineBus();
    const handler = vi.fn();
    await bus.subscribe('streamline:workflow.completed', handler);

    await bus.publish(createEvent('streamline:workflow.completed', { runId: 'r1' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe('streamline:workflow.completed');
  });

  it('publishes to glob subscribers', async () => {
    const bus = new InProcessStreamlineBus();
    const handler = vi.fn();
    await bus.subscribe('streamline:workflow.*', handler);

    await bus.publish(createEvent('streamline:workflow.completed', { runId: 'r1' }));
    await bus.publish(createEvent('streamline:workflow.failed', { runId: 'r2' }));
    await bus.publish(createEvent('streamline:step.completed', { runId: 'r3' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('returns an unsubscribe function', async () => {
    const bus = new InProcessStreamlineBus();
    const handler = vi.fn();
    const unsub = await bus.subscribe('streamline:*', handler);

    await bus.publish(createEvent('streamline:workflow.completed', { runId: 'r1' }));
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    await bus.publish(createEvent('streamline:workflow.failed', { runId: 'r2' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates handler errors — one failure must not block siblings', async () => {
    const errors: unknown[] = [];
    const bus = new InProcessStreamlineBus({
      onHandlerError: (err) => errors.push(err),
    });

    const goodHandler = vi.fn();
    await bus.subscribe('streamline:*', () => {
      throw new Error('boom');
    });
    await bus.subscribe('streamline:*', goodHandler);

    await bus.publish(createEvent('streamline:workflow.completed', { runId: 'r1' }));

    expect(goodHandler).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('close() clears subscriptions', async () => {
    const bus = new InProcessStreamlineBus();
    const handler = vi.fn();
    await bus.subscribe('*', handler);

    await bus.close();
    await bus.publish(createEvent('streamline:workflow.completed', { runId: 'r1' }));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('STREAMLINE_EVENTS / LEGACY_TO_CANONICAL', () => {
  it('every legacy event maps to a canonical streamline:* name', () => {
    for (const canonical of Object.values(LEGACY_TO_CANONICAL)) {
      expect(canonical.startsWith('streamline:')).toBe(true);
    }
  });

  it('all canonical names appear in STREAMLINE_EVENTS', () => {
    const canonicalSet = new Set(Object.values(STREAMLINE_EVENTS));
    for (const canonical of Object.values(LEGACY_TO_CANONICAL)) {
      expect(canonicalSet.has(canonical)).toBe(true);
    }
  });

  /**
   * Exhaustiveness is enforced at compile time via
   * `Record<WorkflowEventName, StreamlineEventName>` on `LEGACY_TO_CANONICAL`,
   * but a runtime sanity check keeps us honest if someone ever widens the
   * type. If this ever fails, a new event was added to `EventPayloadMap`
   * without a canonical mapping — the bridge would silently drop it.
   */
  it('maps every internal WorkflowEventName (no silent drops in the bridge)', () => {
    // Inline the expected legacy event set so a new addition to
    // EventPayloadMap lights up this test even if someone casts their way
    // past the type check in event-constants.ts.
    const expected = [
      'step:started',
      'step:completed',
      'step:failed',
      'step:waiting',
      'step:skipped',
      'step:retry-scheduled',
      'step:compensated',
      'workflow:started',
      'workflow:completed',
      'workflow:failed',
      'workflow:waiting',
      'workflow:resumed',
      'workflow:cancelled',
      'workflow:recovered',
      'workflow:retry',
      'workflow:compensating',
      'engine:error',
      'scheduler:error',
      'scheduler:circuit-open',
    ] as const;
    for (const name of expected) {
      expect(LEGACY_TO_CANONICAL[name]).toBeDefined();
    }
    expect(Object.keys(LEGACY_TO_CANONICAL).sort()).toEqual([...expected].sort());
  });
});
