/**
 * Repository for WorkflowDefinition — extends mongokit's `Repository`.
 *
 * Split out of `definition.model.ts` when model registration moved to the
 * single mongokit `defineStreamlineModels()` path (see `models.ts`): the model
 * file is now a pure schema factory, so the repository — which needs the bound
 * `WorkflowDefinitionModel` at construction — lives here to keep the
 * schema-factory file free of the model↔repository import cycle.
 *
 * Optional storage substrate for versioning / auditing / dynamic loading of
 * workflow definitions. Inherits the full mongokit CRUD / pagination / query /
 * hook / plugin surface and carries only the definition-specific domain verbs.
 */

import {
  methodRegistryPlugin,
  mongoOperationsPlugin,
  type PluginType,
  Repository,
} from '@classytic/mongokit';
import semver from 'semver';
import type { WorkflowDefinitionDoc } from './definition.model.js';
import { WorkflowDefinitionModel } from './models.js';

/**
 * Filter type for deactivate queries
 */
interface DeactivateFilter {
  workflowId: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Parse a semver string into the numeric `versionMajor/Minor/Patch` sort
 * fields, mutating `definition` in place. Mirrors the schema `pre('save')`
 * hook so the mongokit write path (which bypasses `pre('save')`) keeps the
 * numeric fields populated and the versioning indexes sortable.
 */
function applySemverFields(definition: Partial<WorkflowDefinitionDoc>): void {
  if (!definition.version) return;
  const parsed = semver.parse(definition.version);
  if (!parsed) {
    throw new Error(`Invalid semver version: ${definition.version}`);
  }
  definition.versionMajor = parsed.major;
  definition.versionMinor = parsed.minor;
  definition.versionPatch = parsed.patch;
}

/**
 * Repository for WorkflowDefinition — extends mongokit's `Repository`.
 *
 * Write concern is intentionally the schema/connection default here:
 * definitions are configuration metadata, not crash-recovery run state, so
 * they do NOT need the `{w:'majority',j:true}` durability guarantee that
 * `WorkflowRunModel` / the concurrency counter carry.
 *
 * The semver-parse logic that the schema's `pre('save')` hook applies on the
 * raw model is duplicated in `beforeCreate`/`beforeUpdate` (mongokit's
 * findOneAndUpdate path bypasses `pre('save')`), so versions stay sortable on
 * every write path. Both are retained on purpose — see the `pre('save')`
 * comment in `definition.model.ts`.
 */
export class WorkflowDefinitionRepository extends Repository<WorkflowDefinitionDoc> {
  constructor() {
    const plugins: PluginType[] = [methodRegistryPlugin(), mongoOperationsPlugin()];
    super(WorkflowDefinitionModel, plugins);
  }

  /**
   * Create a new workflow definition (or version). Parses semver into the
   * numeric sort fields before delegating to the inherited `create`.
   */
  override async create(
    data: Partial<WorkflowDefinitionDoc> | Record<string, unknown>,
    options: Parameters<Repository<WorkflowDefinitionDoc>['create']>[1] = {},
  ): Promise<WorkflowDefinitionDoc> {
    applySemverFields(data as Partial<WorkflowDefinitionDoc>);
    return super.create(data as Record<string, unknown>, options);
  }

  /**
   * Get the latest active version of a workflow (numeric-semver sort).
   */
  async getLatestVersion(workflowId: string): Promise<WorkflowDefinitionDoc | null> {
    return this.getOne(
      { workflowId, isActive: true },
      { sort: { versionMajor: -1, versionMinor: -1, versionPatch: -1 } },
    );
  }

  /**
   * Get a specific version of a workflow.
   */
  async getByVersion(workflowId: string, version: string): Promise<WorkflowDefinitionDoc | null> {
    return this.getOne({ workflowId, version });
  }

  /**
   * Get all active workflow definitions (latest version of each workflow).
   *
   * Stays a raw `aggregate()` call: the `$group`/`$replaceRoot` pipeline that
   * collapses to the latest version per `workflowId` is not expressible via
   * `getAll`. Routing it through the inherited `aggregate` keeps plugin hooks
   * firing.
   */
  async getActiveDefinitions(): Promise<WorkflowDefinitionDoc[]> {
    return this.aggregatePipeline<WorkflowDefinitionDoc>([
      { $match: { isActive: true } },
      { $sort: { versionMajor: -1, versionMinor: -1, versionPatch: -1 } },
      {
        $group: {
          _id: '$workflowId',
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { createdAt: -1 } },
    ]);
  }

  /**
   * Get all versions of a specific workflow (newest semver first).
   */
  async getVersionHistory(workflowId: string): Promise<WorkflowDefinitionDoc[]> {
    return this.findAll(
      { workflowId },
      { sort: { versionMajor: -1, versionMinor: -1, versionPatch: -1 } },
    );
  }

  /**
   * Update a specific workflow version (rare — usually create a new version).
   * Recomputes numeric semver fields when `version` is changed.
   */
  async updateVersion(
    workflowId: string,
    version: string,
    updates: Partial<WorkflowDefinitionDoc>,
  ): Promise<WorkflowDefinitionDoc | null> {
    applySemverFields(updates);
    return this.findOneAndUpdate(
      { workflowId, version },
      { $set: updates },
      { returnDocument: 'after' },
    );
  }

  /**
   * Deactivate a specific version (or all versions if `version` is omitted).
   */
  async deactivate(workflowId: string, version?: string): Promise<void> {
    const filter: DeactivateFilter = { workflowId };
    if (version) filter.version = version;
    await this.updateMany(filter, { $set: { isActive: false } });
  }

  /**
   * Deactivate all versions except `keepVersion` (keep only the latest).
   */
  async deactivateOldVersions(workflowId: string, keepVersion: string): Promise<void> {
    await this.updateMany(
      { workflowId, version: { $ne: keepVersion } },
      { $set: { isActive: false } },
    );
  }
}

/**
 * Default singleton instance backing the deprecated plain-object re-export.
 */
const defaultWorkflowDefinitionRepository = new WorkflowDefinitionRepository();

/**
 * @deprecated Since v2.4.0. Use `new WorkflowDefinitionRepository()` (or the
 * exported `WorkflowDefinitionRepository` class) instead. This plain-object
 * re-export delegates to a shared default instance and is kept only so
 * existing callers do not break. It exposes the same verbs as before, except
 * `update(workflowId, version, updates)` which is now
 * `updateVersion(workflowId, version, updates)` on the class — the delegate
 * keeps the legacy `update` name.
 */
export const workflowDefinitionRepository = {
  create: (definition: Partial<WorkflowDefinitionDoc>): Promise<WorkflowDefinitionDoc> =>
    defaultWorkflowDefinitionRepository.create(definition),
  getLatestVersion: (workflowId: string): Promise<WorkflowDefinitionDoc | null> =>
    defaultWorkflowDefinitionRepository.getLatestVersion(workflowId),
  getByVersion: (workflowId: string, version: string): Promise<WorkflowDefinitionDoc | null> =>
    defaultWorkflowDefinitionRepository.getByVersion(workflowId, version),
  getActiveDefinitions: (): Promise<WorkflowDefinitionDoc[]> =>
    defaultWorkflowDefinitionRepository.getActiveDefinitions(),
  getVersionHistory: (workflowId: string): Promise<WorkflowDefinitionDoc[]> =>
    defaultWorkflowDefinitionRepository.getVersionHistory(workflowId),
  update: (
    workflowId: string,
    version: string,
    updates: Partial<WorkflowDefinitionDoc>,
  ): Promise<WorkflowDefinitionDoc | null> =>
    defaultWorkflowDefinitionRepository.updateVersion(workflowId, version, updates),
  deactivate: (workflowId: string, version?: string): Promise<void> =>
    defaultWorkflowDefinitionRepository.deactivate(workflowId, version),
  deactivateOldVersions: (workflowId: string, keepVersion: string): Promise<void> =>
    defaultWorkflowDefinitionRepository.deactivateOldVersions(workflowId, keepVersion),
};
