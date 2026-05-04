/**
 * Scenario tests for `concurrency.throttle` and `concurrency.debounce`.
 *
 * Style: openclaw-style replay per
 * [`testing-infrastructure.md` §6](../../testing-infrastructure.md). Each
 * test is **Setup → Script → Assert**:
 *
 *   1. Setup — define a workflow with a specific concurrency config; nothing
 *      else seeded.
 *   2. Script — sequence of `wf.start(input, opts)` calls with explicit
 *      ordering / tenant context.
 *   3. Assert — persisted run shapes (`scheduling.executionTime`,
 *      `meta.streamlineGate`, status, count), not the scheduler tick.
 *
 * What this file covers that the focused regression suite doesn't:
 *
 *   - Deep-burst staggering: `(limit + 4)` excess starts must produce four
 *     distinct slots — the 3rd, 4th, 5th excess can't all collide on
 *     `oldestInWindow + windowMs` (the bug fixed in v2.3).
 *   - Tenant context propagation through every start path (debounce / throttle
 *     / concurrency.limit) in strict multi-tenant mode.
 *   - Strict-mode failure when tenant context is missing.
 *   - Best-effort sequential safety vs documented parallel-race surface.
 */

import { describe, expect, it } from 'vitest';
import {
  createContainer,
  createWorkflow,
  WorkflowRunModel,
  type Workflow,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

interface BurstInput {
  userId: string;
  /** monotonic counter so the persisted input is identifiably "the latest" */
  rev?: number;
}

/**
 * Make a throttle-configured workflow. Defaults to single-tenant; pass a
 * `container` override (e.g. with `multiTenantPlugin`) to test the strict
 * tenant path. Always non-auto-executing — scenarios assert on persistence,
 * not on scheduler-driven execution.
 */
function makeThrottleWorkflow(
  id: string,
  overrides: Partial<{
    limit: number;
    windowMs: number;
    container: ReturnType<typeof createContainer>;
  }> = {},
): Workflow<{ userId: string; rev?: number }, BurstInput> {
  return createWorkflow<{ userId: string; rev?: number }, BurstInput>(id, {
    steps: { run: async () => 'ok' },
    autoExecute: false,
    concurrency: {
      key: (input) => input.userId,
      throttle: {
        limit: overrides.limit ?? 2,
        windowMs: overrides.windowMs ?? 60_000,
      },
    },
    ...(overrides.container ? { container: overrides.container } : {}),
  });
}

function makeDebounceWorkflow(
  id: string,
  overrides: Partial<{
    windowMs: number;
    container: ReturnType<typeof createContainer>;
  }> = {},
): Workflow<{ userId: string; rev?: number }, BurstInput> {
  return createWorkflow<{ userId: string; rev?: number }, BurstInput>(id, {
    steps: { run: async () => 'ok' },
    autoExecute: false,
    concurrency: {
      key: (input) => input.userId,
      debounce: { windowMs: overrides.windowMs ?? 30_000 },
    },
    ...(overrides.container ? { container: overrides.container } : {}),
  });
}

describe('Throttle scenarios — staggered burst, no slot collision', () => {
  useTestDb();

  it('5-start burst (limit=2/60s) produces 5 distinct fire slots', async () => {
    // Setup: throttle 2 per minute. Slot interval = 30s.
    const wf = makeThrottleWorkflow('throttle-deep-burst', {
      limit: 2,
      windowMs: 60_000,
    });

    // Script: sequential burst of 5 with the same key.
    const r1 = await wf.start({ userId: 'u-1', rev: 1 });
    const r2 = await wf.start({ userId: 'u-1', rev: 2 });
    const r3 = await wf.start({ userId: 'u-1', rev: 3 });
    const r4 = await wf.start({ userId: 'u-1', rev: 4 });
    const r5 = await wf.start({ userId: 'u-1', rev: 5 });

    // Assert (1): first `limit` starts admitted immediately.
    expect(r1.meta?.streamlineGate).toBeUndefined();
    expect(r2.meta?.streamlineGate).toBeUndefined();
    expect(r1.status).toBe('running');
    expect(r2.status).toBe('running');

    // Assert (2): excess starts are ALL gated as throttle drafts.
    expect(r3.meta?.streamlineGate).toBe('throttle');
    expect(r4.meta?.streamlineGate).toBe('throttle');
    expect(r5.meta?.streamlineGate).toBe('throttle');
    expect(r3.status).toBe('draft');
    expect(r4.status).toBe('draft');
    expect(r5.status).toBe('draft');

    // Assert (3): each queued draft has a STRICTLY later fire-at than the
    // previous. This is the bug-fix lock-in — pre-v2.3, calls 3, 4, 5 all
    // collided at `oldestInWindow + windowMs` (== r1.createdAt + 60_000).
    const fire3 = r3.scheduling?.executionTime as Date;
    const fire4 = r4.scheduling?.executionTime as Date;
    const fire5 = r5.scheduling?.executionTime as Date;
    expect(fire3).toBeInstanceOf(Date);
    expect(fire4).toBeInstanceOf(Date);
    expect(fire5).toBeInstanceOf(Date);
    expect(fire4.getTime()).toBeGreaterThan(fire3.getTime());
    expect(fire5.getTime()).toBeGreaterThan(fire4.getTime());

    // Assert (4): spacing between consecutive queued slots is exactly
    // `windowMs / limit` (= 30s here). Allow 100ms slack for the inserts
    // and clock granularity.
    const slotInterval = 60_000 / 2;
    expect(fire4.getTime() - fire3.getTime()).toBeGreaterThanOrEqual(slotInterval - 100);
    expect(fire4.getTime() - fire3.getTime()).toBeLessThanOrEqual(slotInterval + 100);
    expect(fire5.getTime() - fire4.getTime()).toBeGreaterThanOrEqual(slotInterval - 100);
    expect(fire5.getTime() - fire4.getTime()).toBeLessThanOrEqual(slotInterval + 100);

    // Assert (5): all 5 runs persisted, none lost or merged.
    const total = await WorkflowRunModel.countDocuments({
      workflowId: 'throttle-deep-burst',
      concurrencyKey: 'u-1',
    });
    expect(total).toBe(5);
  });

  it('the first excess anchors at oldestInWindow + windowMs (not now + windowMs)', async () => {
    // Distinguishes the algorithm from a naive "now + windowMs" implementation —
    // the queued slot must be tied to the first start's createdAt, not the
    // moment the excess call arrived.
    const wf = makeThrottleWorkflow('throttle-anchor', { limit: 1, windowMs: 5_000 });

    const first = await wf.start({ userId: 'u-1' });
    // Wait briefly — if the algorithm anchored to `now`, the queued slot
    // would shift by this delay; correct behavior anchors to `first.createdAt`.
    await new Promise((r) => setTimeout(r, 120));
    const queued = await wf.start({ userId: 'u-1' });

    const fireAt = (queued.scheduling?.executionTime as Date).getTime();
    const anchor = new Date(first.createdAt as Date).getTime();
    expect(Math.abs(fireAt - (anchor + 5_000))).toBeLessThanOrEqual(50);
  });

  it('different concurrency keys do not share a throttle bucket', async () => {
    const wf = makeThrottleWorkflow('throttle-key-isolation', {
      limit: 1,
      windowMs: 60_000,
    });

    // Script: one start per key. Each is the FIRST in its bucket — neither
    // should be throttled.
    const a = await wf.start({ userId: 'u-1' });
    const b = await wf.start({ userId: 'u-2' });
    const c = await wf.start({ userId: 'u-3' });

    expect(a.meta?.streamlineGate).toBeUndefined();
    expect(b.meta?.streamlineGate).toBeUndefined();
    expect(c.meta?.streamlineGate).toBeUndefined();
  });
});

describe('Debounce scenarios — trailing-edge collapse with input refresh', () => {
  useTestDb();

  it('rapid burst produces ONE persisted run carrying the latest input', async () => {
    const wf = makeDebounceWorkflow('debounce-burst-collapse', { windowMs: 30_000 });

    // Script: 5 sequential bumps with monotonically-increasing rev.
    const ids = [];
    for (let rev = 1; rev <= 5; rev++) {
      const r = await wf.start({ userId: 'u-1', rev });
      ids.push(String(r._id));
    }

    // Assert (1): all five returns refer to the same run id (atomic bumps).
    expect(new Set(ids).size).toBe(1);

    // Assert (2): exactly one persisted document for the bucket.
    const count = await WorkflowRunModel.countDocuments({
      workflowId: 'debounce-burst-collapse',
      concurrencyKey: 'u-1',
    });
    expect(count).toBe(1);

    // Assert (3): the persisted input is the LATEST (rev: 5), not the first.
    const persisted = await WorkflowRunModel.findById(ids[0]).lean();
    expect((persisted?.input as { rev: number }).rev).toBe(5);
  });

  it('different concurrency keys produce independent debounce drafts', async () => {
    const wf = makeDebounceWorkflow('debounce-key-isolation', { windowMs: 30_000 });

    await wf.start({ userId: 'u-1', rev: 1 });
    await wf.start({ userId: 'u-1', rev: 2 });
    await wf.start({ userId: 'u-2', rev: 1 });

    const u1Count = await WorkflowRunModel.countDocuments({
      workflowId: 'debounce-key-isolation',
      concurrencyKey: 'u-1',
    });
    const u2Count = await WorkflowRunModel.countDocuments({
      workflowId: 'debounce-key-isolation',
      concurrencyKey: 'u-2',
    });
    expect(u1Count).toBe(1);
    expect(u2Count).toBe(1);
  });
});

describe('Tenant propagation — strict multi-tenant mode', () => {
  useTestDb();

  it('throttle path forwards tenantId through count, nextSlot, and create probes', async () => {
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = makeThrottleWorkflow('throttle-tenant-prop', {
      limit: 1,
      windowMs: 60_000,
      container,
    });

    // Script: two starts past the limit with explicit tenantId on each.
    // Pre-fix, the throttle's count / nextThrottleFireAt / create probes
    // would throw "Missing tenantId" before the run was ever persisted.
    const r1 = await wf.start({ userId: 'u-1' }, { tenantId: 'org-A' });
    const r2 = await wf.start({ userId: 'u-1' }, { tenantId: 'org-A' });

    expect(r1.status).toBe('running');
    expect(r2.meta?.streamlineGate).toBe('throttle');
    // Tenant scope was auto-injected on create (mongokit's tenant-filter
    // plugin reads it from the per-call options).
    const persisted = await WorkflowRunModel.findById(r2._id).lean();
    expect((persisted?.context as { tenantId?: string })?.tenantId).toBe('org-A');
  });

  it('debounce bump path forwards tenantId to the atomic findOneAndUpdate', async () => {
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = makeDebounceWorkflow('debounce-tenant-prop', {
      windowMs: 30_000,
      container,
    });

    // First start creates the debounce draft; second bumps it. Both must
    // pass tenant scope — pre-fix, the bump's findOneAndUpdate hook chain
    // threw "Missing tenantId" because StartOptions had no tenant slot.
    const first = await wf.start({ userId: 'u-1', rev: 1 }, { tenantId: 'org-A' });
    const bumped = await wf.start({ userId: 'u-1', rev: 2 }, { tenantId: 'org-A' });

    expect(String(bumped._id)).toBe(String(first._id));
    const persisted = await WorkflowRunModel.findById(first._id).lean();
    expect((persisted?.input as { rev: number }).rev).toBe(2);
    expect((persisted?.context as { tenantId?: string })?.tenantId).toBe('org-A');
  });

  it('concurrency.limit path forwards tenantId to countActiveByConcurrencyKey', async () => {
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = createWorkflow<{ userId: string }, { userId: string }>(
      'concurrency-tenant-prop',
      {
        steps: { run: async () => 'ok' },
        autoExecute: false,
        concurrency: { key: (input) => input.userId, limit: 1 },
        container,
      },
    );

    const r1 = await wf.start({ userId: 'u-1' }, { tenantId: 'org-A' });
    const r2 = await wf.start({ userId: 'u-1' }, { tenantId: 'org-A' });

    expect(r1.status).toBe('running');
    // Second start exceeds limit — should queue as draft, NOT throw on the
    // concurrency probe.
    expect(r2.status).toBe('draft');
    expect(r2.concurrencyKey).toBe('u-1');
  });

  it('strict-mode concurrency draft promotion succeeds (cross-tenant scheduler probe bypass)', async () => {
    // Reproduces the bug where strict-mode `getConcurrencyDrafts` /
    // `getConcurrencyDraft` / `countActiveByConcurrencyKey` threw "Missing
    // tenantId" inside the engine's promoteConcurrencyDrafts and the
    // scheduler's poll loop, freezing queued drafts in strict-tenant mode.
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = createWorkflow<{ userId: string }, { userId: string }>(
      'concurrency-promote-strict',
      {
        steps: { run: async () => 'ok' },
        autoExecute: false,
        concurrency: { key: (input) => input.userId, limit: 1 },
        container,
      },
    );

    const first = await wf.start({ userId: 'u-1' }, { tenantId: 'org-A' });
    const queued = await wf.start({ userId: 'u-1' }, { tenantId: 'org-A' });

    expect(first.status).toBe('running');
    expect(queued.status).toBe('draft');

    // The engine's promoteConcurrencyDrafts fires inside setImmediate after
    // a slot frees. We can't easily trigger that without driving the
    // execution lifecycle, but the scheduler's getConcurrencyDrafts read
    // (with bypassTenant) is the same code path. Pre-fix this would throw.
    const drafts = await container.repository.getConcurrencyDrafts(10, {
      bypassTenant: true,
    });
    const found = drafts.find((d) => String(d._id) === String(queued._id));
    expect(found).toBeDefined();
    expect((found?.context as { tenantId?: string })?.tenantId).toBe('org-A');
  });

  it('throws cleanly when strict mode is missing tenantId (no silent cross-tenant write)', async () => {
    const container = createContainer({
      repository: { multiTenant: { tenantField: 'context.tenantId', strict: true } },
    });
    const wf = makeThrottleWorkflow('throttle-strict-fail', {
      limit: 1,
      windowMs: 60_000,
      container,
    });

    // Strict mode WITHOUT tenantId — must throw at the first probe, not
    // silently create an unscoped run.
    await expect(wf.start({ userId: 'u-1' })).rejects.toThrow(/tenantId/i);

    // No run was persisted.
    const count = await WorkflowRunModel.countDocuments({
      workflowId: 'throttle-strict-fail',
    });
    expect(count).toBe(0);
  });
});

describe('Honest contract — best-effort smoothing, not strict rate limit', () => {
  useTestDb();

  it('SEQUENTIAL bursts smooth correctly (the documented happy path)', async () => {
    const wf = makeThrottleWorkflow('throttle-sequential-honest', {
      limit: 2,
      windowMs: 1_000,
    });

    // 6 sequential starts. With limit=2/1s and stagger=500ms, the queued
    // drafts should land at 1000, 1500, 2000, 2500ms past first.createdAt.
    const runs = [];
    for (let i = 0; i < 6; i++) {
      runs.push(await wf.start({ userId: 'u-1', rev: i + 1 }));
    }

    const queuedRuns = runs.slice(2); // the 4 excess
    const fireTimes = queuedRuns.map(
      (r) => (r.scheduling?.executionTime as Date).getTime(),
    );

    // Each queued slot is unique.
    expect(new Set(fireTimes).size).toBe(fireTimes.length);

    // Slots are monotonically increasing.
    for (let i = 1; i < fireTimes.length; i++) {
      const previous = fireTimes[i - 1] as number;
      const current = fireTimes[i] as number;
      expect(current).toBeGreaterThan(previous);
    }
  });

  // PARALLEL race is documented but not asserted — by design. The contract
  // says "best-effort smoothing under parallel load." Adding a flaky test
  // here would test the wrong thing. The README + repo docstring + this
  // describe-block name carry the contract.
  //
  // If you hit a real-world parallel-race regression, write a deterministic
  // reproducer with `vi.useFakeTimers()` and a controlled query stub, not
  // a `Promise.all([wf.start(...) × N])` that flaps under CI load.
});
