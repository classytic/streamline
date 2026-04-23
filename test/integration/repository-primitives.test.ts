/**
 * Integration tests for v2.2 repository primitives against streamline's
 * own `WorkflowRun` model.
 *
 * mongokit 3.11 promoted `updateMany` and `deleteMany` to class primitives
 * on `Repository<TDoc>`. Streamline's `WorkflowRunRepository` extends that
 * class, so these primitives are available without any plugin. The point of
 * this suite is to prove they work *with* streamline-specific concerns:
 *
 *   1. The tenantFilter plugin injects the tenant scope on bulk updates
 *      and deletes — a tenant can't touch another tenant's runs even if
 *      they own the filter.
 *   2. `hasConcurrencyDrafts()` returns O(1) existence booleans (added in
 *      v2.2 to replace COUNT_DOCUMENTS calls in the scheduler's hot path).
 *   3. The `updateOne()` strictness guard catches mixed operator+field
 *      update shapes before Mongo silently drops keys.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import {
  createWorkflowRepository,
  type WorkflowRunRepository,
} from '../../src/storage/run.repository.js';
import type { WorkflowRun } from '../../src/core/types.js';
import { cleanupTestDB, setupTestDB, teardownTestDB } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    _id: overrides._id ?? `run-${Math.random().toString(36).slice(2)}`,
    workflowId: overrides.workflowId ?? 'test-wf',
    status: overrides.status ?? 'running',
    steps: overrides.steps ?? [],
    currentStepId: overrides.currentStepId ?? null,
    context: (overrides.context ?? {}) as Record<string, unknown>,
    input: overrides.input ?? {},
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    ...overrides,
  } as WorkflowRun;
}

async function seed(runs: WorkflowRun[]): Promise<void> {
  await WorkflowRunModel.create(runs);
}

// ---------------------------------------------------------------------------
// updateMany — inherited from mongokit 3.11's Repository base class
// ---------------------------------------------------------------------------

describe('Repository.updateMany — inherited primitive', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  it('updates every matching run in a single roundtrip', async () => {
    await seed([
      makeRun({ _id: 'a', status: 'running' }),
      makeRun({ _id: 'b', status: 'running' }),
      makeRun({ _id: 'c', status: 'waiting' }),
    ]);

    const now = new Date();
    const result = await repo.updateMany(
      { status: 'running' },
      { $set: { status: 'waiting', updatedAt: now } },
    );

    expect(result.matchedCount).toBe(2);
    expect(result.modifiedCount).toBe(2);

    const after = await WorkflowRunModel.find({}).sort({ _id: 1 }).lean();
    expect(after.map((r) => r.status)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  it('returns matchedCount=0 cleanly when the filter matches nothing', async () => {
    const result = await repo.updateMany({ status: 'running' }, { $set: { status: 'done' } });
    expect(result.matchedCount).toBe(0);
    expect(result.modifiedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deleteMany — inherited from mongokit 3.11's Repository base class
// ---------------------------------------------------------------------------

describe('Repository.deleteMany — inherited primitive', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  it('deletes every matching run and reports the count', async () => {
    await seed([
      makeRun({ _id: 'done-1', status: 'done' }),
      makeRun({ _id: 'done-2', status: 'done' }),
      makeRun({ _id: 'running-1', status: 'running' }),
    ]);

    const result = await repo.deleteMany({ status: 'done' });
    expect(result.deletedCount).toBe(2);

    const remaining = await WorkflowRunModel.find({}).lean();
    expect(remaining.map((r) => r._id).sort()).toEqual(['running-1']);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — bulk operations MUST respect the tenant scope
// ---------------------------------------------------------------------------

describe('Bulk primitives + tenantFilterPlugin', () => {
  it('updateMany with tenantId only touches that tenant\'s runs', async () => {
    // Tenant-scoped repository — streamline's own plugin, not mongokit's.
    const repo = createWorkflowRepository({
      multiTenant: { tenantField: 'context.tenantId', strict: true },
    });

    // Seed using raw model so we bypass create hooks — the goal here is to
    // test the scoped update, not the scoped create.
    await seed([
      makeRun({ _id: 'a1', status: 'running', context: { tenantId: 'a' } }),
      makeRun({ _id: 'a2', status: 'running', context: { tenantId: 'a' } }),
      makeRun({ _id: 'b1', status: 'running', context: { tenantId: 'b' } }),
    ]);

    // Tenant A fires updateMany — should only hit A's runs even though the
    // filter ({ status: 'running' }) matches every seeded row.
    const result = await repo.updateMany(
      { status: 'running' },
      { $set: { status: 'waiting', updatedAt: new Date() } },
      { tenantId: 'a' },
    );

    expect(result.matchedCount).toBe(2);
    expect(result.modifiedCount).toBe(2);

    // B's run must remain untouched.
    const b = await WorkflowRunModel.findById('b1').lean();
    expect(b?.status).toBe('running');
  });

  it('deleteMany with tenantId only removes that tenant\'s runs', async () => {
    const repo = createWorkflowRepository({
      multiTenant: { tenantField: 'context.tenantId', strict: true },
    });

    await seed([
      makeRun({ _id: 'a1', status: 'done', context: { tenantId: 'a' } }),
      makeRun({ _id: 'a2', status: 'done', context: { tenantId: 'a' } }),
      makeRun({ _id: 'b1', status: 'done', context: { tenantId: 'b' } }),
    ]);

    const result = await repo.deleteMany({ status: 'done' }, { tenantId: 'a' });
    expect(result.deletedCount).toBe(2);

    const remaining = await WorkflowRunModel.find({}).lean();
    expect(remaining.map((r) => r._id)).toEqual(['b1']);
  });

  it('rejects bulk operations without tenantId in strict mode', async () => {
    const repo = createWorkflowRepository({
      multiTenant: { tenantField: 'context.tenantId', strict: true },
    });

    await seed([makeRun({ _id: 'a1', status: 'running', context: { tenantId: 'a' } })]);

    await expect(repo.updateMany({ status: 'running' }, { $set: { status: 'waiting' } })).rejects.toThrow(
      /Missing tenantId/,
    );
    await expect(repo.deleteMany({ status: 'running' })).rejects.toThrow(/Missing tenantId/);
  });
});

// ---------------------------------------------------------------------------
// hasConcurrencyDrafts — bounded existence probe
// ---------------------------------------------------------------------------

describe('hasConcurrencyDrafts', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  it('returns false when no concurrency-queued drafts exist', async () => {
    await seed([
      // Regular draft without concurrencyKey — not a concurrency-queued draft.
      makeRun({ _id: 'plain-draft', status: 'draft' }),
      // Draft with a scheduling block — that's a scheduled draft, not a
      // concurrency-queued draft (even with concurrencyKey set).
      makeRun({
        _id: 'scheduled',
        status: 'draft',
        concurrencyKey: 'k',
        scheduling: {
          scheduledFor: '2030-01-01T09:00:00',
          timezone: 'UTC',
          localTimeDisplay: '2030-01-01 09:00',
          executionTime: new Date('2030-01-01T09:00:00Z'),
        },
      } as never),
    ]);
    expect(await repo.hasConcurrencyDrafts()).toBe(false);
  });

  it('returns true when at least one concurrency-queued draft exists', async () => {
    await seed([
      makeRun({ _id: 'done', status: 'done' }),
      makeRun({
        _id: 'concurrency-queued',
        status: 'draft',
        concurrencyKey: 'order-abc',
      } as never),
    ]);
    expect(await repo.hasConcurrencyDrafts()).toBe(true);
  });

  it('ignores paused drafts', async () => {
    await seed([
      makeRun({
        _id: 'paused-queued',
        status: 'draft',
        concurrencyKey: 'k',
        paused: true,
      } as never),
    ]);
    expect(await repo.hasConcurrencyDrafts()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook priority — tenantFilter must run at HOOK_PRIORITY.POLICY (100) so it
// beats CACHE (200), OBSERVABILITY (300), and DEFAULT (500) listeners to
// every before:* hook. The proof: register a DEFAULT-priority listener
// alongside ours and verify tenant scope is already injected by the time
// it runs.
// ---------------------------------------------------------------------------

describe('tenantFilterPlugin hook priority', () => {
  it('injects tenant scope before lower-priority listeners observe the context', async () => {
    const repo = createWorkflowRepository({
      multiTenant: { tenantField: 'context.tenantId', strict: true },
    });

    await seed([
      makeRun({ _id: 'a1', status: 'running', context: { tenantId: 'a' } }),
      makeRun({ _id: 'b1', status: 'running', context: { tenantId: 'b' } }),
    ]);

    // Late listener at DEFAULT priority (500) — runs AFTER tenant filter
    // (priority 100). By the time it fires, `context.filters` must already
    // carry the `context.tenantId` scope.
    let observedFilters: Record<string, unknown> | undefined;
    (repo as unknown as { on: (e: string, fn: (ctx: unknown) => void) => void }).on(
      'before:getAll',
      (ctx: unknown) => {
        observedFilters = (ctx as { filters?: Record<string, unknown> }).filters;
      },
    );

    await repo.getAll({ filters: { status: 'running' }, tenantId: 'a' });
    expect(observedFilters?.['context.tenantId']).toBe('a');
    expect(observedFilters?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// updateOne strictness — the normalizeUpdate guardrail
// ---------------------------------------------------------------------------

describe('WorkflowRunRepository.updateOne — mixed-shape guardrail', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  it('accepts a plain field-shape patch (auto-wrapped in $set)', async () => {
    await seed([makeRun({ _id: 'r1', status: 'running' })]);

    const result = await repo.updateOne({ _id: 'r1' }, { status: 'waiting' });
    expect(result.modifiedCount).toBe(1);

    const after = await WorkflowRunModel.findById('r1').lean();
    expect(after?.status).toBe('waiting');
  });

  it('accepts a well-formed $set update', async () => {
    await seed([makeRun({ _id: 'r1', status: 'running' })]);

    const result = await repo.updateOne(
      { _id: 'r1' },
      { $set: { status: 'waiting' } },
    );
    expect(result.modifiedCount).toBe(1);
  });

  it('throws loudly instead of silently dropping mixed shapes', async () => {
    await seed([makeRun({ _id: 'r1', status: 'running' })]);

    await expect(
      repo.updateOne(
        { _id: 'r1' },
        // @ts-expect-error — intentional misuse
        { $set: { status: 'done' }, someField: 'dropped-silently' },
      ),
    ).rejects.toThrow(/cannot mix operators.*raw field keys/);

    // And the run must NOT have been updated — the throw happens before the
    // write reaches Mongo.
    const after = await WorkflowRunModel.findById('r1').lean();
    expect(after?.status).toBe('running');
  });
});
