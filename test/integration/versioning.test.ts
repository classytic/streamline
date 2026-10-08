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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workflowRegistry } from '../../src/execution/engine.js';
import {
  configureStreamlineLogger,
  InvalidStateError,
  type WorkflowConfig,
} from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

beforeAll(() => {
  configureStreamlineLogger({ enabled: false });
});

afterAll(() => {
  configureStreamlineLogger({ enabled: true });
});

describe('Version pinning — runs carry definitionVersion', () => {
  it('snapshots the definition version onto the run at create-time', async () => {
    const wf = env.workflow('vp-snapshot', {
      version: '1.2.3',
      steps: { only: async () => 'done' },
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

    const v1 = env.workflow('vp-route', {
      version: '1.0.0',
      steps: {
        process: async () => {
          v1Calls.push('v1');
          return 'v1-output';
        },
      },
    });

    // Start a run under v1.
    const run = await v1.start({});

    // Now register v2 for the SAME workflowId — workflowRegistry tracks both versions.
    env.redefine(v1, {
      version: '2.0.0',
      steps: {
        process: async () => {
          v2Calls.push('v2');
          return 'v2-output';
        },
      },
    });

    // Execute via v1 — version pinning means the run's currentStepId
    // resolves through v1's engine, NOT v2's.
    await v1.engine.execute(run._id);

    expect(v1Calls).toEqual(['v1']);
    expect(v2Calls).toEqual([]);

    const final = await env.runs.get(run._id);
    expect(final?.status).toBe('done');
    expect(final?.definitionVersion).toBe('1.0.0');
  });
});

describe('Version pinning — migrateRun hook', () => {
  it('lets the host remap an in-flight run when the original engine is not registered', async () => {
    // Step 1: define v1 just to mint a run with v1's definitionVersion.
    const v1 = env.workflow('vp-migrate', {
      version: '1.0.0',
      steps: {
        legacyStep: async () => 'legacy-result',
      },
    });
    const run = await v1.start({});

    // Force the divergence by stamping a version that was never registered
    // onto the run (simulates "host has redeployed; the run's engine is gone").
    await env.runs.update(run._id, { definitionVersion: '0.9.0' }); // version we never registered

    let migrationFired = false;
    const v2 = env.workflow('vp-migrate-target', {
      version: '2.0.0',
      steps: {
        modernStep: async () => 'modern-result',
      },
      migrateRun: async (r) => {
        migrationFired = true;
        return {
          // Remap currentStepId from the v0.9 graph onto v2's graph.
          currentStepId: 'modernStep',
          steps: r.steps.map((s) =>
            s.stepId === 'legacyStep' ? { ...s, stepId: 'modernStep' } : s,
          ),
        };
      },
    });

    // Move the run under v2's workflowId so v2's engine picks it up.
    // v1 and v2 share the env's container: `runs.update` drops v1's cached copy
    // so v2 reads the edited row (each engine had its own cache before the harness).
    await env.runs.update(run._id, { workflowId: v2.engine.definition.id });

    await v2.engine.execute(run._id);

    expect(migrationFired).toBe(true);

    // Migration re-pinned the run to v2's version.
    const final = await env.until(run._id, (r) => r.definitionVersion === '2.0.0');
    expect(final.definitionVersion).toBe('2.0.0');
  });
});

describe('Version pinning — back-compat', () => {
  it('falls through to the active engine when the run has no definitionVersion', async () => {
    const calls: string[] = [];
    const wf = env.workflow('vp-backcompat', {
      version: '1.0.0',
      steps: {
        only: async () => {
          calls.push('called');
          return 'ok';
        },
      },
    });

    // Mint a run, then strip definitionVersion to simulate a pre-v2.3.3 row.
    const run = await wf.start({});
    await env.runs.update(run._id, { $unset: { definitionVersion: '' } });

    await wf.engine.execute(run._id);
    expect(calls).toEqual(['called']);
  });
});

describe('Version pinning — versionPolicy (no pinned engine, no migrateRun)', () => {
  /** Mint a run on `version`, then re-pin it to `pinned` — an engine that is not registered. */
  async function pinnedRun(
    name: string,
    version: string,
    pinned: string,
    policy?: 'compatible' | 'strict' | 'any',
  ) {
    const calls: string[] = [];
    const wf = env.workflow(name, {
      version,
      ...(policy && { versionPolicy: policy }),
      steps: {
        only: async () => {
          calls.push('ran');
          return 'ok';
        },
      },
    });
    const run = await wf.start({});
    await env.runs.update(run._id, { definitionVersion: pinned });
    return { wf, run, calls };
  }

  it('parks a run pinned to a different major instead of running it on new code', async () => {
    const { wf, run, calls } = await pinnedRun('vp-policy-major', '2.0.0', '1.0.0');
    const paused: string[] = [];
    const listener = (p: { runId: string }) => paused.push(p.runId);
    wf.engine.container.eventBus.on('workflow:paused', listener);

    try {
      const result = await wf.engine.execute(run._id);

      expect(calls).toEqual([]);
      expect(result.paused).toBe(true);
      expect(result.pauseReason).toMatch(/^version-unavailable: run is pinned to v1\.0\.0/);
      expect(paused).toEqual([run._id]);
      const stored = await env.runs.get(run._id);
      expect(stored?.paused).toBe(true);
      expect(stored?.definitionVersion).toBe('1.0.0');
    } finally {
      // The env's container (and its bus) outlives this test.
      wf.engine.container.eventBus.off('workflow:paused', listener);
    }
  });

  it('runs a same-major run under the default compatible policy', async () => {
    const { wf, run, calls } = await pinnedRun('vp-policy-minor', '1.4.0', '1.0.0');
    const result = await wf.engine.execute(run._id);
    expect(calls).toEqual(['ran']);
    expect(result.status).toBe('done');
  });

  it("'strict' parks even a minor difference", async () => {
    const { wf, run, calls } = await pinnedRun('vp-policy-strict', '1.4.0', '1.0.0', 'strict');
    const result = await wf.engine.execute(run._id);
    expect(calls).toEqual([]);
    expect(result.paused).toBe(true);
  });

  it("'any' runs across majors (the old fallback, now opt-in)", async () => {
    const { wf, run, calls } = await pinnedRun('vp-policy-any', '2.0.0', '1.0.0', 'any');
    const result = await wf.engine.execute(run._id);
    expect(calls).toEqual(['ran']);
    expect(result.status).toBe('done');
  });

  it('refuses a resume signal without consuming it, and parks the run', async () => {
    const wf = env.workflow('vp-policy-resume', {
      version: '2.0.0',
      steps: {
        gate: async (ctx) => ctx.wait('approval'),
        after: async () => 'after',
      },
    });
    const run = await wf.start({});
    await wf.engine.execute(run._id);
    await env.runs.update(run._id, { definitionVersion: '1.0.0' });

    await expect(wf.engine.resume(run._id, { approved: true })).rejects.toBeInstanceOf(
      InvalidStateError,
    );

    const stored = await env.runs.get(run._id);
    expect(stored?.status).toBe('waiting');
    expect(stored?.currentStepId).toBe('gate');
    expect(stored?.steps.find((s) => s.stepId === 'gate')?.status).toBe('waiting');
    expect(stored?.paused).toBe(true);
  });

  it('pause(reason) persists the reason and resume clears it', async () => {
    const wf = env.workflow('vp-pause-reason', {
      steps: { gate: async (ctx) => ctx.wait('approval') },
    });
    const run = await wf.start({});
    await wf.engine.execute(run._id);

    await wf.engine.pause(run._id, { reason: 'maintenance window' });
    expect((await env.runs.get(run._id))?.pauseReason).toBe('maintenance window');

    await wf.engine.resume(run._id, { ok: true });
    const stored = await env.runs.get(run._id);
    expect(stored?.paused).toBe(false);
    expect(stored?.pauseReason).toBeUndefined();
  });
});

describe('Version gate runs BEFORE a payload is consumed (migrateRun present)', () => {
  /** A run waiting at `approve`, pinned to v1.0.0, on an engine at `version`. */
  async function waitingOldRun(
    name: string,
    version: string,
    migrateRun: NonNullable<WorkflowConfig<Record<string, unknown>>['migrateRun']>,
  ) {
    const wf = env.workflow(name, {
      version,
      versionPolicy: 'strict',
      migrateRun,
      steps: {
        approve: async (ctx) => ctx.waitFor('approved'),
        ship: async () => 'shipped',
      },
    });
    const run = await wf.start({});
    await wf.execute(run._id);
    await env.runs.update(run._id, { definitionVersion: '1.0.0' });
    return { wf, run };
  }

  it('a declining migrateRun (null) does not let resume() persist the approval', async () => {
    const { wf, run } = await waitingOldRun('vp-gate-resume', '1.1.0', () => null);

    await expect(wf.engine.resume(run._id, { approved: true })).rejects.toBeInstanceOf(
      InvalidStateError,
    );

    const stored = await env.runs.get(run._id);
    expect(stored?.paused).toBe(true);
    expect(stored?.currentStepId).toBe('approve');
    const approve = stored?.steps.find((s) => s.stepId === 'approve');
    expect(approve?.status).toBe('waiting');
    expect(approve?.output).toBeUndefined();
  });

  it('a declining migrateRun does not let a durable signal be consumed either', async () => {
    const { wf, run } = await waitingOldRun('vp-gate-signal', '1.1.0', () => null);

    const sent = await wf.signal(run._id, 'approved', { approved: true });
    expect(sent.status).toBe('queued');

    const stored = await env.runs.get(run._id);
    expect(stored?.paused).toBe(true);
    expect(stored?.steps.find((s) => s.stepId === 'approve')?.status).toBe('waiting');
    expect(stored?.signals).toHaveLength(1); // kept for after the operator fixes the version
  });

  it('an accepting migrateRun migrates FIRST, then the payload lands on the migrated run', async () => {
    const seen: (string | undefined)[] = [];
    const { wf, run } = await waitingOldRun('vp-gate-migrate', '1.1.0', (r) => {
      seen.push(r.definitionVersion);
      return {};
    });

    const resumed = await wf.engine.resume(run._id, { approved: true });
    expect(seen).toEqual(['1.0.0']);
    expect(resumed.status).toBe('done');
    const stored = await env.runs.get(run._id);
    expect(stored?.definitionVersion).toBe('1.1.0');
    expect(stored?.steps.find((s) => s.stepId === 'approve')?.output).toEqual({ approved: true });
  });
});

describe('workflowRegistry.lookupVersion', () => {
  it('returns the engine pinned to a specific version', () => {
    const wf = env.workflow('vp-registry', {
      version: '1.5.0',
      steps: { only: async () => 'ok' },
    });

    const found = workflowRegistry.lookupVersion(wf.engine.definition.id, '1.5.0');
    expect(found).toBeDefined();
    expect(found).toBe(wf.engine);
  });

  it('returns undefined for an unknown version', () => {
    const wf = env.workflow('vp-registry-2', {
      version: '1.0.0',
      steps: { only: async () => 'ok' },
    });

    expect(workflowRegistry.lookupVersion(wf.engine.definition.id, '99.0.0')).toBeUndefined();
  });
});
