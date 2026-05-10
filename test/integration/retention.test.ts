/**
 * Integration tests for the retention block — TTL index, tenant-prefixed
 * compound, stale-run sweeper.
 *
 * Three scenarios prove the bug-report gaps are closed:
 *
 *   1. `syncRetentionIndexes()` builds the TTL index with the documented
 *      `partialFilterExpression` shape, and a re-call with a different
 *      `terminalRunsTtlSeconds` drops + recreates instead of throwing
 *      `IndexOptionsConflict`.
 *   2. When the repository is multi-tenant, `syncRetentionIndexes()`
 *      auto-builds the org-prefixed compound `{ <tenantField>: 1,
 *      workflowId: 1, createdAt: -1 }`. PACKAGE_RULES §33 (scope-field
 *      prefix on compounds) made literal.
 *   3. `StaleRunSweeper.sweepOnce()` claims stale `running` runs via
 *      the repository's atomic CAS, marks them `failed`, and emits
 *      `workflow:failed` with `error.code === 'stale_heartbeat'` —
 *      exactly the shape the host bug report asks for.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEventBus, type WorkflowFailedPayload } from '../../src/core/events.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';
import {
  RETENTION_DEFAULTS,
  StaleRunSweeper,
  resolveSweeperConfig,
  syncRetentionIndexes,
} from '../../src/storage/retention.js';
import {
  createWorkflowRepository,
  type WorkflowRunRepository,
} from '../../src/storage/run.repository.js';
import { createContainer } from '../../src/core/container.js';
import type { WorkflowRun } from '../../src/core/types.js';
import { cleanupTestDB, setupTestDB, teardownTestDB } from '../utils/setup.js';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
afterEach(cleanupTestDB);

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

// ---------------------------------------------------------------------------
// syncRetentionIndexes — TTL index
// ---------------------------------------------------------------------------

describe('syncRetentionIndexes — TTL on terminal runs', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  afterEach(async () => {
    // Drop retention indexes between tests so subsequent calls start clean.
    const indexes = await WorkflowRunModel.collection.indexes();
    for (const ix of indexes) {
      if (typeof ix.name === 'string' && ix.name.startsWith('streamline_')) {
        await WorkflowRunModel.collection.dropIndex(ix.name);
      }
    }
  });

  it('builds the TTL index with the documented partialFilterExpression shape', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 });

    const indexes = await WorkflowRunModel.collection.indexes();
    const ttl = indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl');

    expect(ttl).toBeDefined();
    expect(ttl?.expireAfterSeconds).toBe(30 * 86400);
    expect(ttl?.key).toEqual({ endedAt: 1 });
    expect(ttl?.partialFilterExpression).toEqual({
      endedAt: { $exists: true },
      status: { $in: ['done', 'failed', 'cancelled'] },
    });
  });

  it('is idempotent on repeated calls with the same TTL', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 });
    // Should NOT throw the second time.
    await expect(
      syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 }),
    ).resolves.not.toThrow();
  });

  it('drops + recreates when TTL changes (closes IndexOptionsConflict)', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 });
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 7 * 86400 });

    const indexes = await WorkflowRunModel.collection.indexes();
    const ttl = indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl');
    expect(ttl?.expireAfterSeconds).toBe(7 * 86400);
  });

  it('skips TTL when terminalRunsTtlSeconds is 0', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 0 });
    const indexes = await WorkflowRunModel.collection.indexes();
    expect(indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncRetentionIndexes — multi-tenant compound
// ---------------------------------------------------------------------------

describe('syncRetentionIndexes — tenant-prefixed compound', () => {
  afterEach(async () => {
    const indexes = await WorkflowRunModel.collection.indexes();
    for (const ix of indexes) {
      if (typeof ix.name === 'string' && ix.name.startsWith('streamline_')) {
        await WorkflowRunModel.collection.dropIndex(ix.name);
      }
    }
  });

  it('builds tenant-prefixed compound when repo is multi-tenant', async () => {
    const repo = createWorkflowRepository({
      multiTenant: { tenantField: 'context.organizationId', strict: false },
    });

    await syncRetentionIndexes(repo, {});

    const indexes = await WorkflowRunModel.collection.indexes();
    const compound = indexes.find((ix) => ix.name === 'streamline_tenant_workflow_recent');

    expect(compound).toBeDefined();
    expect(compound?.key).toEqual({
      'context.organizationId': 1,
      workflowId: 1,
      createdAt: -1,
    });
  });

  it('skips tenant compound when single-tenant', async () => {
    const repo = createWorkflowRepository();
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 });

    const indexes = await WorkflowRunModel.collection.indexes();
    expect(indexes.find((ix) => ix.name === 'streamline_tenant_workflow_recent')).toBeUndefined();
  });

  it('honours `multiTenantIndexes: false` opt-out', async () => {
    const repo = createWorkflowRepository({
      multiTenant: { tenantField: 'context.tenantId', strict: false },
    });
    await syncRetentionIndexes(repo, { multiTenantIndexes: false });

    const indexes = await WorkflowRunModel.collection.indexes();
    expect(indexes.find((ix) => ix.name === 'streamline_tenant_workflow_recent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StaleRunSweeper — terminator semantics
// ---------------------------------------------------------------------------

describe('StaleRunSweeper.sweepOnce — terminates stale running runs', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  it('marks stale running runs as failed with stale_heartbeat code', async () => {
    const oldHeartbeat = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const recentHeartbeat = new Date(Date.now() - 1000);

    await WorkflowRunModel.create([
      makeRun({
        _id: 'stale',
        status: 'running',
        lastHeartbeat: oldHeartbeat,
      }),
      makeRun({
        _id: 'healthy',
        status: 'running',
        lastHeartbeat: recentHeartbeat,
      }),
    ]);

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({ staleHeartbeatThresholdMs: 5 * 60 * 1000 }),
    );

    const result = await sweeper.sweepOnce();
    expect(result.swept).toBe(1);
    expect(result.errors).toBe(0);

    const stale = await WorkflowRunModel.findById('stale').lean();
    expect(stale?.status).toBe('failed');
    expect((stale?.error as { code?: string })?.code).toBe('stale_heartbeat');
    expect(stale?.endedAt).toBeInstanceOf(Date);

    const healthy = await WorkflowRunModel.findById('healthy').lean();
    expect(healthy?.status).toBe('running');
  });

  it('emits workflow:failed for each terminated run', async () => {
    await WorkflowRunModel.create(
      makeRun({
        _id: 'sweep-emit',
        status: 'running',
        lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
      }),
    );

    const eventBus = new WorkflowEventBus();
    const failures: WorkflowFailedPayload[] = [];
    eventBus.on('workflow:failed', (p) => failures.push(p));

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({ staleHeartbeatThresholdMs: 5 * 60 * 1000 }),
      eventBus,
    );

    await sweeper.sweepOnce();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.runId).toBe('sweep-emit');
    expect((failures[0]?.error as { code?: string })?.code).toBe('stale_heartbeat');
  });

  it('honours staleRunAction: cancel', async () => {
    await WorkflowRunModel.create(
      makeRun({
        _id: 'cancel-me',
        status: 'running',
        lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
      }),
    );

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        staleRunAction: 'cancel',
      }),
    );

    await sweeper.sweepOnce();

    const cancelled = await WorkflowRunModel.findById('cancel-me').lean();
    expect(cancelled?.status).toBe('cancelled');
  });

  it('uses sensible defaults via resolveSweeperConfig', () => {
    const cfg = resolveSweeperConfig({ staleHeartbeatThresholdMs: 60_000 });
    expect(cfg.staleHeartbeatThresholdMs).toBe(60_000);
    expect(cfg.staleRunSweepIntervalMs).toBe(RETENTION_DEFAULTS.staleRunSweepIntervalMs);
    expect(cfg.staleRunAction).toBe('fail');
    expect(cfg.staleRunBatchSize).toBe(100);
    expect(cfg.maxStaleRecoveries).toBe(RETENTION_DEFAULTS.maxStaleRecoveries);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter — runs that exceed maxStaleRecoveries
// ---------------------------------------------------------------------------

describe('StaleRunSweeper — dead-letter cap', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = createWorkflowRepository();
  });

  it('dead-letters a run that has exceeded maxStaleRecoveries', async () => {
    await WorkflowRunModel.create(
      makeRun({
        _id: 'wedged',
        status: 'running',
        lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
        recoveryAttempts: 5, // already at cap
      } as Partial<WorkflowRun>),
    );

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        maxStaleRecoveries: 5,
      }),
    );

    const result = await sweeper.sweepOnce();
    expect(result.swept).toBe(1);

    const dlq = await WorkflowRunModel.findById('wedged').lean();
    expect(dlq?.status).toBe('failed');
    expect((dlq?.error as { code?: string })?.code).toBe('dead_lettered');
    expect((dlq?.error as { recoveryAttempts?: number })?.recoveryAttempts).toBe(5);
  });

  it('falls through to stale_heartbeat when under the cap', async () => {
    await WorkflowRunModel.create(
      makeRun({
        _id: 'recoverable',
        status: 'running',
        lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
        recoveryAttempts: 2,
      } as Partial<WorkflowRun>),
    );

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        maxStaleRecoveries: 5,
      }),
    );

    await sweeper.sweepOnce();

    const stale = await WorkflowRunModel.findById('recoverable').lean();
    expect((stale?.error as { code?: string })?.code).toBe('stale_heartbeat');
    expect(stale?.recoveryAttempts).toBe(3); // bumped by markStaleAsFailed's $inc
  });

  it('emits workflow:failed with dead_lettered code, not stale_heartbeat', async () => {
    await WorkflowRunModel.create(
      makeRun({
        _id: 'dlq-emit',
        status: 'running',
        lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
        recoveryAttempts: 5,
      } as Partial<WorkflowRun>),
    );

    const eventBus = new WorkflowEventBus();
    const failures: WorkflowFailedPayload[] = [];
    eventBus.on('workflow:failed', (p) => failures.push(p));

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        maxStaleRecoveries: 5,
      }),
      eventBus,
    );

    await sweeper.sweepOnce();
    expect((failures[0]?.error as { code?: string })?.code).toBe('dead_lettered');
  });
});

// ---------------------------------------------------------------------------
// Container wiring
// ---------------------------------------------------------------------------

describe('createContainer — retention block wiring', () => {
  it('exposes syncRetentionIndexes as a no-op when retention is unset', async () => {
    const container = createContainer();
    await expect(container.syncRetentionIndexes()).resolves.toBeUndefined();
    expect(container.staleRunSweeper).toBeUndefined();
    container.dispose();
  });

  it('auto-starts the sweeper when staleHeartbeatThresholdMs is set', () => {
    const container = createContainer({
      retention: { staleHeartbeatThresholdMs: 60_000 },
    });
    expect(container.staleRunSweeper).toBeDefined();
    expect(container.staleRunSweeper?.isActive()).toBe(true);
    container.dispose();
    expect(container.staleRunSweeper?.isActive()).toBe(false);
  });

  it('does NOT start the sweeper when only TTL is set (deploy-time path)', () => {
    const container = createContainer({
      retention: { terminalRunsTtlSeconds: 30 * 86400 },
    });
    expect(container.staleRunSweeper).toBeUndefined();
    container.dispose();
  });
});
