/**
 * Regression: the engine's strict-concurrency slot-release listeners are
 * registered ONLY for workflows that declare `concurrency.strict`.
 *
 * Root cause (pre-2.4.2): `WorkflowEngine`'s constructor unconditionally
 * attached 5 lifecycle listeners (`workflow:completed` / `:failed` /
 * `:cancelled` / `:compensated` / `:compensation_failed`) to its container's
 * event bus. On a SHARED bus — `createContainer({ eventBus: 'global' })`,
 * which fajr and any multi-workflow host uses — every engine piled its 5
 * listeners onto the one bus. With N workflows that put N listeners on each
 * of those 5 event names, crossing Node's default 10-listener-per-event soft
 * cap and emitting a `MaxListenersExceededWarning` at boot. Worse: each
 * terminal event then fanned out to an O(N) `repository.getById` storm that
 * every non-owning engine immediately discarded on its
 * `run.workflowId === this.definition.id` guard.
 *
 * Those listeners only ever DO anything for a run carrying
 * `meta.concurrencyCounterId`, a marker stamped exclusively by the
 * strict-concurrency claim path. So gating their registration on
 * `concurrency.strict` is behavior-preserving — a non-strict run's listener
 * was always a no-op — and keeps the common case at zero engine bus
 * listeners.
 *
 * These tests don't touch the DB (they inspect listener counts at
 * construction time) but bind each container to the env's connection so the
 * engines' lazy scheduler has a live connection and never logs a stray
 * connection error.
 */

import { describe, expect, it } from 'vitest';
import { WorkflowEventBus } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const TERMINAL_EVENTS = [
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:compensated',
  'workflow:compensation_failed',
] as const;

/** Snapshot the listener count for each terminal event name. */
const snapshot = (bus: WorkflowEventBus): Record<string, number> =>
  Object.fromEntries(TERMINAL_EVENTS.map((e) => [e, bus.listenerCount(e)]));

// Each test gets its own bus — `env.createContainer` gives it a container of
// its own on the env's connection, disposed by the env after each test.
describe('regression: engine slot-release listeners gated on strict concurrency', () => {
  it('12 non-strict workflows add ZERO terminal listeners to a shared bus', () => {
    const bus = new WorkflowEventBus();
    // `createContainer` runs `bridgeBusToTransport`, which attaches exactly
    // one listener per event name. Capture that constant as the baseline so
    // the assertion isolates the ENGINE's contribution.
    const container = env.createContainer({ eventBus: bus });
    const baseline = snapshot(bus);

    const wfs = Array.from({ length: 12 }, () =>
      env.workflow('nonstrict', {
        steps: { a: async () => 'ok' },
        container,
      }),
    );

    // Pre-fix: baseline + 12 on each terminal event → trips Node's cap of 10.
    // Post-fix: unchanged — non-strict engines register nothing.
    for (const e of TERMINAL_EVENTS) {
      expect(bus.listenerCount(e)).toBe(baseline[e]);
    }

    for (const wf of wfs) wf.shutdown();
  });

  it('a strict-concurrency workflow registers the 5 listeners; shutdown removes them', () => {
    const bus = new WorkflowEventBus();
    const container = env.createContainer({ eventBus: bus });
    const baseline = snapshot(bus);

    const wf = env.workflow('strict', {
      steps: { a: async () => 'ok' },
      container,
      concurrency: { strict: true, limit: 1, key: () => 'g' },
    });

    // Strict workflows still need slot release → +1 listener per terminal event.
    for (const e of TERMINAL_EVENTS) {
      expect(bus.listenerCount(e)).toBe(baseline[e] + 1);
    }

    wf.shutdown();

    // Teardown removes exactly the engine's 5 listeners — no leak on a shared bus.
    for (const e of TERMINAL_EVENTS) {
      expect(bus.listenerCount(e)).toBe(baseline[e]);
    }
  });

  it('mixed fleet: only the strict workflows contribute listeners', () => {
    const bus = new WorkflowEventBus();
    const container = env.createContainer({ eventBus: bus });
    const baseline = snapshot(bus);

    const nonStrict = Array.from({ length: 8 }, () =>
      env.workflow('mixed-loose', {
        steps: { a: async () => 'ok' },
        container,
      }),
    );
    const strict = Array.from({ length: 2 }, () =>
      env.workflow('mixed-strict', {
        steps: { a: async () => 'ok' },
        container,
        concurrency: { strict: true, limit: 1, key: () => 'g' },
      }),
    );

    // 10 workflows total, but only the 2 strict ones register listeners →
    // well under Node's cap of 10. This is the scenario that used to warn.
    for (const e of TERMINAL_EVENTS) {
      expect(bus.listenerCount(e)).toBe(baseline[e] + 2);
    }

    for (const wf of [...nonStrict, ...strict]) wf.shutdown();
  });
});
