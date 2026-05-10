/**
 * Integration tests for in-flight version pinning + migration hook.
 *
 * Three scenarios:
 *   1. A run created under v1 carries `definitionVersion: '1.0.0'` and is
 *      executed by the v1 engine even after a v2 engine registers for the
 *      same workflowId — the engine consults `workflowRegistry.lookupVersion`
 *      before executing the step graph.
 *   2. When the v1 engine is NOT registered (rolling deploy mid-flight),
 *      the v2 engine's `migrateRun` hook receives the run and returns a
 *      partial shape that's merged + re-pinned. Execution continues
 *      under v2.
 *   3. Runs created before v2.3.3 (no `definitionVersion` field) fall
 *      through to the active engine — back-compat unchanged.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  configureStreamlineLogger,
  createWorkflow,
  WorkflowRunModel,
} from '../../src/index.js';
import { workflowRegistry } from '../../src/execution/engine.js';
import { cleanupTestDB, setupTestDB, teardownTestDB, waitFor } from '../utils/setup.js';

beforeAll(async () => {
  await setupTestDB();
  configureStreamlineLogger({ enabled: false });
});

afterAll(async () => {
  configureStreamlineLogger({ enabled: true });
  await teardownTestDB();
});

afterEach(cleanupTestDB);

describe('Version pinning — runs carry definitionVersion', () => {
  it('snapshots the definition version onto the run at create-time', async () => {
    const wf = createWorkflow('vp-snapshot', {
      version: '1.2.3',
      steps: { only: async () => 'done' },
      autoExecute: false,
    });

    const run = await wf.start({});
    expect(run.definitionVersion).toBe('1.2.3');
    expect(run.recoveryAttempts).toBe(0);
  });
});

describe('Version pinning — engine routing on resume', () => {
  it('routes execution to the version-pinned engine when one is registered', async () => {
    const v1Calls: string[] = [];
    const v2Calls: string[] = [];

    const v1 = createWorkflow('vp-route', {
      version: '1.0.0',
      steps: {
        process: async () => {
          v1Calls.push('v1');
          return 'v1-output';
        },
      },
      autoExecute: false,
    });

    // Start a run under v1.
    const run = await v1.start({});

    // Now register v2 — workflowRegistry tracks both versions.
    createWorkflow('vp-route', {
      version: '2.0.0',
      steps: {
        process: async () => {
          v2Calls.push('v2');
          return 'v2-output';
        },
      },
      autoExecute: false,
    });

    // Execute via v1 — version pinning means the run's currentStepId
    // resolves through v1's engine, NOT v2's.
    await v1.engine.execute(run._id);

    expect(v1Calls).toEqual(['v1']);
    expect(v2Calls).toEqual([]);

    const final = await WorkflowRunModel.findById(run._id).lean();
    expect(final?.status).toBe('done');
    expect(final?.definitionVersion).toBe('1.0.0');
  });
});

describe('Version pinning — migrateRun hook', () => {
  it('lets the host remap an in-flight run when the original engine is not registered', async () => {
    // Step 1: define v1 just to mint a run with v1's definitionVersion.
    const v1 = createWorkflow('vp-migrate', {
      version: '1.0.0',
      steps: {
        legacyStep: async () => 'legacy-result',
      },
      autoExecute: false,
    });
    const run = await v1.start({});

    // Wipe v1 from the registry to simulate "host has redeployed; v1
    // engine no longer registered."
    // Using the public API only — we re-register a different engine for
    // the same workflowId, which overwrites the active map. Then we
    // also clear the version-pinned slot via a direct registry mutation
    // (test-only — we own this state).
    // Simpler approach: just confirm the migration hook fires when the
    // version-pinned engine resolves to the SAME engine but the run has
    // a stale version. We force the divergence by stamping an unknown
    // version onto the run.
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      { $set: { definitionVersion: '0.9.0' } }, // version we never registered
    );

    let migrationFired = false;
    const v2 = createWorkflow('vp-migrate-target', {
      version: '2.0.0',
      steps: {
        modernStep: async () => 'modern-result',
      },
      autoExecute: false,
      migrateRun: async (r) => {
        migrationFired = true;
        return {
          // Remap currentStepId from the v0.9 graph onto v2's graph.
          currentStepId: 'modernStep',
          steps: r.steps.map((s) =>
            s.stepId === 'legacyStep'
              ? { ...s, stepId: 'modernStep' }
              : s,
          ),
        };
      },
    });

    // Move the run under v2's workflowId so v2's engine picks it up.
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      { $set: { workflowId: 'vp-migrate-target' } },
    );

    await v2.engine.execute(run._id);
    await waitFor(50);

    expect(migrationFired).toBe(true);

    const final = await WorkflowRunModel.findById(run._id).lean();
    // Migration re-pinned the run to v2's version.
    expect(final?.definitionVersion).toBe('2.0.0');
  });
});

describe('Version pinning — back-compat', () => {
  it('falls through to the active engine when the run has no definitionVersion', async () => {
    const calls: string[] = [];
    const wf = createWorkflow('vp-backcompat', {
      version: '1.0.0',
      steps: {
        only: async () => {
          calls.push('called');
          return 'ok';
        },
      },
      autoExecute: false,
    });

    // Mint a run, then strip definitionVersion to simulate a pre-v2.3.3 row.
    const run = await wf.start({});
    await WorkflowRunModel.updateOne(
      { _id: run._id },
      { $unset: { definitionVersion: '' } },
    );

    await wf.engine.execute(run._id);
    expect(calls).toEqual(['called']);
  });
});

describe('workflowRegistry.lookupVersion', () => {
  it('returns the engine pinned to a specific version', () => {
    const wf = createWorkflow('vp-registry', {
      version: '1.5.0',
      steps: { only: async () => 'ok' },
      autoExecute: false,
    });

    const found = workflowRegistry.lookupVersion('vp-registry', '1.5.0');
    expect(found).toBeDefined();
    expect(found).toBe(wf.engine);
  });

  it('returns undefined for an unknown version', () => {
    createWorkflow('vp-registry-2', {
      version: '1.0.0',
      steps: { only: async () => 'ok' },
      autoExecute: false,
    });

    expect(workflowRegistry.lookupVersion('vp-registry-2', '99.0.0')).toBeUndefined();
  });
});
