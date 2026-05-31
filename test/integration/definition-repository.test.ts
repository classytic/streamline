/**
 * Integration tests for `WorkflowDefinitionRepository` (v2.4.0 mongokit
 * deepening) + the deprecated delegating `workflowDefinitionRepository`.
 *
 * Covers:
 *   1. create / getByVersion / getLatestVersion / getVersionHistory /
 *      getActiveDefinitions / deactivate — the full domain surface on the new
 *      `Repository`-backed class.
 *   2. Semver numeric fields are populated on the mongokit `create` path
 *      (which bypasses Mongoose `pre('save')`).
 *   3. The deprecated plain-object re-export still works (delegates to a shared
 *      default instance) so existing callers do not break.
 *   4. Persistence round-trips correctly after the dead `condition` field was
 *      dropped from the schema — definitions with step metadata still save and
 *      reload intact.
 */

import { describe, expect, it } from 'vitest';
import {
  WorkflowDefinitionModel,
  WorkflowDefinitionRepository,
  type WorkflowDefinitionDoc,
  workflowDefinitionRepository,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

const repo = new WorkflowDefinitionRepository();

function makeDef(overrides: Partial<WorkflowDefinitionDoc> = {}): Partial<WorkflowDefinitionDoc> {
  return {
    workflowId: 'order-flow',
    name: 'Order Flow',
    version: '1.0.0',
    steps: [
      { id: 'validate', name: 'Validate', retries: 3, timeout: 5000 },
      { id: 'charge', name: 'Charge' },
    ],
    isActive: true,
    ...overrides,
  };
}

describe('WorkflowDefinitionRepository', () => {
  useTestDb();

  it('creates a definition and parses semver into numeric sort fields', async () => {
    const created = await repo.create(makeDef({ version: '2.5.7' }));

    expect(created.workflowId).toBe('order-flow');
    expect(created.version).toBe('2.5.7');
    // mongokit's create path bypasses pre('save') — the repo must parse semver.
    expect(created.versionMajor).toBe(2);
    expect(created.versionMinor).toBe(5);
    expect(created.versionPatch).toBe(7);
  });

  it('rejects an invalid semver version', async () => {
    await expect(repo.create(makeDef({ version: 'not-a-version' }))).rejects.toThrow(
      /Invalid semver/,
    );
  });

  it('getByVersion returns the exact version', async () => {
    await repo.create(makeDef({ version: '1.0.0' }));
    await repo.create(makeDef({ version: '1.1.0' }));

    const found = await repo.getByVersion('order-flow', '1.1.0');
    expect(found?.version).toBe('1.1.0');

    const missing = await repo.getByVersion('order-flow', '9.9.9');
    expect(missing).toBeNull();
  });

  it('getLatestVersion returns the highest active semver (numeric, not lexicographic)', async () => {
    await repo.create(makeDef({ version: '2.0.0' }));
    await repo.create(makeDef({ version: '10.0.0' })); // > 2.0.0 numerically

    const latest = await repo.getLatestVersion('order-flow');
    expect(latest?.version).toBe('10.0.0');
  });

  it('getVersionHistory returns every version newest-first', async () => {
    await repo.create(makeDef({ version: '1.0.0' }));
    await repo.create(makeDef({ version: '1.2.0' }));
    await repo.create(makeDef({ version: '1.10.0' }));

    const history = await repo.getVersionHistory('order-flow');
    expect(history.map((d) => d.version)).toEqual(['1.10.0', '1.2.0', '1.0.0']);
  });

  it('getActiveDefinitions returns the latest active version of each workflow', async () => {
    await repo.create(makeDef({ workflowId: 'wf-a', version: '1.0.0' }));
    await repo.create(makeDef({ workflowId: 'wf-a', version: '2.0.0' }));
    await repo.create(makeDef({ workflowId: 'wf-b', version: '3.0.0' }));

    const active = await repo.getActiveDefinitions();
    const byId = Object.fromEntries(active.map((d) => [d.workflowId, d.version]));
    expect(byId['wf-a']).toBe('2.0.0');
    expect(byId['wf-b']).toBe('3.0.0');
    expect(active).toHaveLength(2);
  });

  it('updateVersion recomputes numeric fields when version changes', async () => {
    await repo.create(makeDef({ version: '1.0.0' }));

    const updated = await repo.updateVersion('order-flow', '1.0.0', {
      version: '1.0.1',
      description: 'patched',
    });

    expect(updated?.version).toBe('1.0.1');
    expect(updated?.versionPatch).toBe(1);
    expect(updated?.description).toBe('patched');
  });

  it('deactivate flips isActive so getActiveDefinitions / getLatestVersion exclude it', async () => {
    await repo.create(makeDef({ version: '1.0.0' }));
    await repo.deactivate('order-flow', '1.0.0');

    expect(await repo.getLatestVersion('order-flow')).toBeNull();
    expect(await repo.getActiveDefinitions()).toHaveLength(0);
  });

  it('deactivateOldVersions keeps only the named version active', async () => {
    await repo.create(makeDef({ version: '1.0.0' }));
    await repo.create(makeDef({ version: '2.0.0' }));

    await repo.deactivateOldVersions('order-flow', '2.0.0');

    const latest = await repo.getLatestVersion('order-flow');
    expect(latest?.version).toBe('2.0.0');
    expect(await repo.getActiveDefinitions()).toHaveLength(1);
  });
});

describe('workflowDefinitionRepository (deprecated delegating re-export)', () => {
  useTestDb();

  it('still exposes the legacy verbs and delegates to the class', async () => {
    const created = await workflowDefinitionRepository.create(makeDef({ version: '4.2.0' }));
    expect(created.versionMajor).toBe(4);

    const latest = await workflowDefinitionRepository.getLatestVersion('order-flow');
    expect(latest?.version).toBe('4.2.0');

    // Legacy `update(workflowId, version, updates)` name is preserved.
    const updated = await workflowDefinitionRepository.update('order-flow', '4.2.0', {
      description: 'legacy-path',
    });
    expect(updated?.description).toBe('legacy-path');
  });
});

describe('persistence after dropping the dead `condition` field', () => {
  useTestDb();

  it('saves and reloads step metadata without the removed condition field', async () => {
    const created = await repo.create(
      makeDef({
        version: '1.0.0',
        steps: [
          { id: 'a', name: 'Step A', retries: 2, timeout: 1000 },
          { id: 'b', name: 'Step B' },
        ],
      }),
    );

    const reloaded = await WorkflowDefinitionModel.findById(created._id).lean();
    expect(reloaded?.steps).toHaveLength(2);
    expect(reloaded?.steps[0]).toMatchObject({ id: 'a', name: 'Step A', retries: 2, timeout: 1000 });
    // The dead `condition` field must not be persisted/returned.
    expect(
      (reloaded?.steps[0] as Record<string, unknown>).condition,
    ).toBeUndefined();
  });

  it('the retained pre(save) hook re-parses semver when a raw doc bumps its version', async () => {
    // The pre('save') semver hook is RETAINED on purpose (removing it would be
    // a hidden MAJOR break for direct raw-model users). It re-derives the
    // numeric sort fields whenever `version` is modified on a `.save()`. We
    // seed via the repo (the supported create path) then mutate the raw doc to
    // prove the hook still fires for direct raw-model `.save()` callers.
    await repo.create(makeDef({ workflowId: 'raw-path', version: '1.0.0' }));

    const doc = await WorkflowDefinitionModel.findOne({ workflowId: 'raw-path' });
    if (!doc) throw new Error('seed doc missing');
    doc.version = '7.8.9';
    await doc.save();

    expect(doc.versionMajor).toBe(7);
    expect(doc.versionMinor).toBe(8);
    expect(doc.versionPatch).toBe(9);
  });
});
