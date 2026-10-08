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
 *
 * Every index here lives on the env's own database (`env.runModel`), so the
 * drops / legacy shapes these tests create never touch another file's model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEventBus, type WorkflowFailedPayload } from '../../src/core/events.js';
import {
  isTerminalState,
  RUN_STATUS_VALUES,
  TERMINAL_RUN_STATUSES,
} from '../../src/core/status.js';
import type { RunStatus } from '../../src/core/types.js';
import {
  RETENTION_DEFAULTS,
  resolveSweeperConfig,
  StaleRunSweeper,
  syncRetentionIndexes,
} from '../../src/storage/retention.js';
import {
  createWorkflowRepository,
  type WorkflowRepositoryConfig,
  type WorkflowRunRepository,
} from '../../src/storage/run.repository.js';
import type { RunFields } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** A fresh repository over the env's run model (its own database). */
const makeRepo = (config: WorkflowRepositoryConfig = {}): WorkflowRunRepository =>
  createWorkflowRepository({ ...config, model: env.runModel });

/** A step-less run of a generic workflow, straight into the collection. */
const seed = (fields: RunFields) =>
  env.runs.insert('test-wf', { steps: [], currentStepId: null, ...fields });

/** Drop retention indexes between tests so subsequent calls start clean. */
async function dropRetentionIndexes(): Promise<void> {
  const indexes = await env.runModel.collection.indexes();
  for (const ix of indexes) {
    if (typeof ix.name === 'string' && ix.name.startsWith('streamline_')) {
      await env.runModel.collection.dropIndex(ix.name);
    }
  }
}

const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// syncRetentionIndexes — TTL index
// ---------------------------------------------------------------------------

describe('syncRetentionIndexes — TTL on terminal runs', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(dropRetentionIndexes);

  it('builds the TTL index with the documented partialFilterExpression shape', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 });

    const indexes = await env.runModel.collection.indexes();
    const ttl = indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl');

    expect(ttl).toBeDefined();
    expect(ttl?.expireAfterSeconds).toBe(30 * 86400);
    expect(ttl?.key).toEqual({ endedAt: 1 });
    expect(ttl?.partialFilterExpression).toEqual({
      endedAt: { $exists: true },
      // Full terminal set — including the saga outcomes `compensated` /
      // `compensation_failed` that the pre-2.7 hand-rolled array missed.
      status: {
        $in: ['done', 'failed', 'cancelled', 'compensated', 'compensation_failed'],
      },
    });
  });

  it('TTL partial filter cannot drift from the state machine terminal set', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 86400 });

    const indexes = await env.runModel.collection.indexes();
    const ttl = indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl');
    const partial = ttl?.partialFilterExpression as { status: { $in: string[] } } | undefined;
    expect(partial).toBeDefined();
    const filterStatuses = partial?.status.$in ?? [];

    // Exactly the statuses `isTerminalState` classifies terminal — derived
    // from the same `TERMINAL_RUN_STATUSES` source, so a new terminal
    // status added to the state machine is TTL-eligible automatically.
    const expected = RUN_STATUS_VALUES.filter((s) => isTerminalState(s));
    expect([...filterStatuses].sort()).toEqual([...expected].sort());
    expect([...filterStatuses].sort()).toEqual([...TERMINAL_RUN_STATUSES].sort());
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

    const indexes = await env.runModel.collection.indexes();
    const ttl = indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl');
    expect(ttl?.expireAfterSeconds).toBe(7 * 86400);
  });

  it('skips TTL when terminalRunsTtlSeconds is 0', async () => {
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 0 });
    const indexes = await env.runModel.collection.indexes();
    expect(indexes.find((ix) => ix.name === 'streamline_terminal_runs_ttl')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncRetentionIndexes — multi-tenant compound
// ---------------------------------------------------------------------------

describe('syncRetentionIndexes — tenant-prefixed compound', () => {
  afterEach(dropRetentionIndexes);

  it('builds tenant-prefixed compound when repo is multi-tenant', async () => {
    const repo = makeRepo({
      tenant: { tenantField: 'context.organizationId', required: false },
    });

    await syncRetentionIndexes(repo, {});

    const indexes = await env.runModel.collection.indexes();
    const compound = indexes.find((ix) => ix.name === 'streamline_tenant_workflow_recent');

    expect(compound).toBeDefined();
    expect(compound?.key).toEqual({
      'context.organizationId': 1,
      workflowId: 1,
      createdAt: -1,
    });
  });

  it('skips tenant compound when single-tenant', async () => {
    const repo = makeRepo();
    await syncRetentionIndexes(repo, { terminalRunsTtlSeconds: 30 * 86400 });

    const indexes = await env.runModel.collection.indexes();
    expect(indexes.find((ix) => ix.name === 'streamline_tenant_workflow_recent')).toBeUndefined();
  });

  it('honours `multiTenantIndexes: false` opt-out', async () => {
    const repo = makeRepo({
      tenant: { tenantField: 'context.tenantId', required: false },
    });
    await syncRetentionIndexes(repo, { multiTenantIndexes: false });

    const indexes = await env.runModel.collection.indexes();
    expect(indexes.find((ix) => ix.name === 'streamline_tenant_workflow_recent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StaleRunSweeper — terminator semantics
// ---------------------------------------------------------------------------

describe('StaleRunSweeper.sweepOnce — terminates stale running runs', () => {
  let repo: WorkflowRunRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('marks stale running runs as failed with stale_heartbeat code', async () => {
    const stale = await seed({ status: 'running', lastHeartbeat: TEN_MIN_AGO() });
    const healthy = await seed({ status: 'running', lastHeartbeat: new Date(Date.now() - 1000) });

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({ staleHeartbeatThresholdMs: 5 * 60 * 1000 }),
    );

    const result = await sweeper.sweepOnce();
    expect(result.swept).toBe(1);
    expect(result.errors).toBe(0);

    const staleAfter = await env.runs.get(stale._id);
    expect(staleAfter?.status).toBe('failed');
    expect((staleAfter?.error as { code?: string })?.code).toBe('stale_heartbeat');
    expect(staleAfter?.endedAt).toBeInstanceOf(Date);

    const healthyAfter = await env.runs.get(healthy._id);
    expect(healthyAfter?.status).toBe('running');
  });

  it('emits workflow:failed for each terminated run', async () => {
    const run = await seed({ status: 'running', lastHeartbeat: TEN_MIN_AGO() });

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
    expect(failures[0]?.runId).toBe(run._id);
    expect((failures[0]?.error as { code?: string })?.code).toBe('stale_heartbeat');
  });

  it('honours staleRunAction: cancel', async () => {
    const run = await seed({ status: 'running', lastHeartbeat: TEN_MIN_AGO() });

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        staleRunAction: 'cancel',
      }),
    );

    await sweeper.sweepOnce();

    const cancelled = await env.runs.get(run._id);
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
    repo = makeRepo();
  });

  it('dead-letters a run that has exceeded maxStaleRecoveries', async () => {
    const run = await seed({
      status: 'running',
      lastHeartbeat: TEN_MIN_AGO(),
      recoveryAttempts: 5, // already at cap
    });

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        maxStaleRecoveries: 5,
      }),
    );

    const result = await sweeper.sweepOnce();
    expect(result.swept).toBe(1);

    const dlq = await env.runs.get(run._id);
    expect(dlq?.status).toBe('failed');
    expect((dlq?.error as { code?: string })?.code).toBe('dead_lettered');
    expect((dlq?.error as { recoveryAttempts?: number })?.recoveryAttempts).toBe(5);
  });

  it('falls through to stale_heartbeat when under the cap', async () => {
    const run = await seed({
      status: 'running',
      lastHeartbeat: TEN_MIN_AGO(),
      recoveryAttempts: 2,
    });

    const sweeper = new StaleRunSweeper(
      repo,
      resolveSweeperConfig({
        staleHeartbeatThresholdMs: 5 * 60 * 1000,
        maxStaleRecoveries: 5,
      }),
    );

    await sweeper.sweepOnce();

    const stale = await env.runs.get(run._id);
    expect((stale?.error as { code?: string })?.code).toBe('stale_heartbeat');
    expect(stale?.recoveryAttempts).toBe(3); // bumped by markStaleAsFailed's $inc
  });

  it('emits workflow:failed with dead_lettered code, not stale_heartbeat', async () => {
    await seed({
      status: 'running',
      lastHeartbeat: TEN_MIN_AGO(),
      recoveryAttempts: 5,
    });

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
  it('syncRetentionIndexes still builds base indexes + migrates when retention is unset', async () => {
    // Simulate a pre-2.9 deployment: the legacy global-unique idempotency index.
    await env.runModel.collection.createIndex(
      { idempotencyKey: 1 },
      { name: 'idempotencyKey_1', unique: true, sparse: true },
    );

    const container = env.createContainer(); // no retention configured
    await expect(container.syncRetentionIndexes()).resolves.toBeUndefined();

    const indexes = await env.runModel.collection.indexes();
    // Legacy single-field unique index is dropped…
    expect(indexes.find((ix) => ix.name === 'idempotencyKey_1')).toBeUndefined();
    // …and replaced by the tenant-scoped compound partial-unique index.
    const compound = indexes.find(
      (ix) => ix.key?.['context.tenantId'] === 1 && ix.key?.idempotencyKey === 1,
    );
    expect(compound?.unique).toBe(true);

    expect(container.staleRunSweeper).toBeUndefined();
    await env.runModel.syncIndexes(); // restore clean schema state for later tests
  });

  it('replaces the $type-filtered idempotency index with one equality lookups can use', async () => {
    await env.runModel.syncIndexes();
    // Simulate the previous release: same key, `$type` partial filter.
    await env.runModel.collection.dropIndex('context.tenantId_1_idempotencyKey_1_str');
    await env.runModel.collection.createIndex(
      { 'context.tenantId': 1, idempotencyKey: 1 },
      {
        name: 'context.tenantId_1_idempotencyKey_1',
        unique: true,
        partialFilterExpression: {
          idempotencyKey: { $type: 'string' },
          status: { $in: ['draft', 'running', 'waiting', 'compensating'] },
        },
      },
    );

    // The active-key lookup's shape.
    const winningPlan = async () =>
      JSON.stringify(
        (
          (await env.runModel
            .find({
              'context.tenantId': null,
              idempotencyKey: 'order-42',
              status: { $in: ['draft', 'running', 'waiting', 'compensating'] },
            })
            .explain('queryPlanner')) as unknown as { queryPlanner: { winningPlan: unknown } }
        ).queryPlanner.winningPlan,
      );
    // Premise: an equality never implies `$type`, so the old index is unusable.
    expect(await winningPlan()).not.toContain('"indexName":"context.tenantId_1_idempotencyKey_1"');

    const container = env.createContainer();
    await container.syncRetentionIndexes();
    const names = (await env.runModel.collection.indexes()).map((ix) => ix.name);
    expect(names).not.toContain('context.tenantId_1_idempotencyKey_1');
    expect(names).toContain('context.tenantId_1_idempotencyKey_1_str');

    expect(await winningPlan()).toContain('"indexName":"context.tenantId_1_idempotencyKey_1_str"');
  });

  it('replaces the sparse {idempotencyKey, status} index with a partial one prefix-less lookups use', async () => {
    await env.runModel.syncIndexes();
    await env.runModel.collection.dropIndex('idempotencyKey_1_status_1_str');
    await env.runModel.collection.createIndex(
      { idempotencyKey: 1, status: 1 },
      { name: 'idempotencyKey_1_status_1', sparse: true },
    );

    const container = env.createContainer();
    await container.syncRetentionIndexes();
    const indexes = await env.runModel.collection.indexes();
    expect(indexes.map((ix) => ix.name)).not.toContain('idempotencyKey_1_status_1');
    const partial = indexes.find((ix) => ix.name === 'idempotencyKey_1_status_1_str');
    expect(partial?.partialFilterExpression).toEqual({ idempotencyKey: { $gte: '' } });

    // The single-tenant active-key lookup and the child adopt-by-key probe
    // carry no tenant field — they plan onto the partial index. Seed many
    // active runs (shared status, distinct keys): on an empty collection every
    // plan ties and the planner's pick is arbitrary.
    await env.runModel.collection.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        _id: `seed-${i}` as unknown as never,
        workflowId: 'seed',
        status: 'running',
        idempotencyKey: `seed-key-${i}`,
        steps: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    const active: RunStatus[] = ['draft', 'running', 'waiting', 'compensating'];
    for (const filter of [
      { idempotencyKey: 'seed-key-7', status: { $in: active } },
      { idempotencyKey: 'seed-key-7' },
    ]) {
      const plan = (await env.runModel.find(filter).explain('queryPlanner')) as unknown as {
        queryPlanner: { winningPlan: unknown };
      };
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
        '"indexName":"idempotencyKey_1_status_1_str"',
      );
    }
  });

  it('drops the ≤2.8.1 keyset indexes 2.8.2 retired, and leaves host indexes alone', async () => {
    await env.runModel.syncIndexes();
    const col = env.runModel.collection;
    // What a deployment that ran ≤2.8.1 still carries (createIndexes never drops).
    await col.createIndex({ status: 1, paused: 1, workflowId: 1, updatedAt: 1, _id: 1 });
    await col.createIndex({ status: 1, paused: 1, steps: 1, updatedAt: 1, _id: 1 });
    // A host's own index that merely LOOKS similar must survive.
    await col.createIndex(
      { status: 1, paused: 1, workflowId: 1 },
      { name: 'host_status_paused_wf' },
    );

    const container = env.createContainer();
    await container.syncRetentionIndexes();
    const names = (await col.indexes()).map((ix) => ix.name);
    expect(names).not.toContain('status_1_paused_1_workflowId_1_updatedAt_1__id_1');
    expect(names).not.toContain('status_1_paused_1_steps_1_updatedAt_1__id_1');
    expect(names).toContain('host_status_paused_wf');
    expect(names).toContain('status_1_workflowId_1_updatedAt_1__id_1'); // the 2.8.2 replacement

    await col.dropIndex('host_status_paused_wf');
  });

  it('auto-starts the sweeper when staleHeartbeatThresholdMs is set', () => {
    const container = env.createContainer({
      retention: { staleHeartbeatThresholdMs: 60_000 },
    });
    expect(container.staleRunSweeper).toBeDefined();
    expect(container.staleRunSweeper?.isActive()).toBe(true);
    container.dispose();
    expect(container.staleRunSweeper?.isActive()).toBe(false);
  });

  it('does NOT start the sweeper when only TTL is set (deploy-time path)', () => {
    const container = env.createContainer({
      retention: { terminalRunsTtlSeconds: 30 * 86400 },
    });
    expect(container.staleRunSweeper).toBeUndefined();
  });
});
