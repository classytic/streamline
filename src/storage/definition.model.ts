/**
 * Workflow Definition Model (Optional)
 *
 * Stores workflow definitions in MongoDB for:
 * - Versioning: Track workflow changes over time
 * - Auditing: Who created/modified workflows
 * - Dynamic loading: Load workflows from DB instead of code
 * - Collaboration: Teams can share workflow definitions
 *
 * Note: This is OPTIONAL. You can define workflows in code without this model.
 */

import {
  methodRegistryPlugin,
  mongoOperationsPlugin,
  type PluginType,
  Repository,
} from '@classytic/mongokit';
import mongoose, { Schema } from 'mongoose';
import semver from 'semver';

export interface WorkflowDefinitionDoc {
  _id: string; // Unique document ID (auto-generated)
  workflowId: string; // Workflow identifier (same across versions)
  name: string;
  description?: string;
  version: string;
  versionMajor: number; // Parsed from version for sorting
  versionMinor: number;
  versionPatch: number;
  steps: Array<{
    id: string;
    name: string;
    retries?: number;
    timeout?: number;
    // NOTE: the dead `condition: String` field was removed in v2.4.0. It was
    // serialized-function storage that NOTHING in the engine ever read for
    // execution — step conditions are in-code predicates resolved at
    // `createWorkflow` time (see define.ts / features/conditional.ts), never
    // hydrated from this doc. It is intentionally NOT replaced by an
    // eval/`new Function` deserializer: doing so would turn the engine into a
    // data-driven business-logic orchestrator, the HARD-RULE violation. Its
    // removal is the migration.
  }>;
  defaults?: {
    retries?: number;
    timeout?: number;
  };
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

const WorkflowDefinitionSchema = new Schema<WorkflowDefinitionDoc>(
  {
    workflowId: { type: String, required: true, index: true }, // Not _id!
    name: { type: String, required: true },
    description: String,
    version: { type: String, required: true, default: '1.0.0' },
    versionMajor: { type: Number, required: true },
    versionMinor: { type: Number, required: true },
    versionPatch: { type: Number, required: true },
    steps: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        retries: Number,
        timeout: Number,
        // `condition: String` removed in v2.4.0 — dead storage, never read for
        // execution. Do NOT re-add a serialized-condition deserializer.
      },
    ],
    defaults: {
      retries: Number,
      timeout: Number,
    },
    createdBy: String,
    updatedBy: String,
    isActive: { type: Boolean, default: true },
    tags: [String],
    metadata: Schema.Types.Mixed,
  },
  {
    collection: 'workflow_definitions',
    timestamps: true,
  },
);

// Pre-save hook to parse version and populate numeric fields.
//
// RETAINED DELIBERATELY (v2.4.0): the raw `WorkflowDefinitionModel` is a public
// barrel export, so downstream callers may still mint definitions via
// `new WorkflowDefinitionModel(...).save()` / `Model.create()`. mongokit's
// `findOneAndUpdate`/repo write path bypasses Mongoose `pre('save')`, so the
// repository ALSO parses semver explicitly (see WorkflowDefinitionRepository).
// Keeping BOTH (belt-and-suspenders) is what makes the mongokit migration a
// non-breaking semver-MINOR change rather than a hidden major break for direct
// raw-model users.
WorkflowDefinitionSchema.pre('save', function () {
  if (this.isModified('version')) {
    const parsed = semver.parse(this.version);
    if (!parsed) {
      throw new Error(`Invalid semver version: ${this.version}`);
    }
    this.versionMajor = parsed.major;
    this.versionMinor = parsed.minor;
    this.versionPatch = parsed.patch;
  }
});

// Indexes for common queries
WorkflowDefinitionSchema.index({ name: 1 });
WorkflowDefinitionSchema.index({ isActive: 1 });
WorkflowDefinitionSchema.index({ tags: 1 });
// Note: createdAt/updatedAt are auto-indexed by timestamps: true

// CRITICAL: Compound index for versioning (unique constraint)
// Allows multiple versions of same workflow (workflowId)
WorkflowDefinitionSchema.index({ workflowId: 1, version: 1 }, { unique: true });

// Index for fetching latest version using numeric semver fields
// This enables proper semver sorting (10.0.0 > 2.0.0) instead of lexicographic
WorkflowDefinitionSchema.index({
  workflowId: 1,
  isActive: 1,
  versionMajor: -1,
  versionMinor: -1,
  versionPatch: -1,
});

/**
 * MULTI-TENANCY & CUSTOM INDEXES
 *
 * This model is intentionally unopinionated about multi-tenancy.
 * Different apps have different needs (tenantId, orgId, workspaceId, etc.)
 *
 * To add custom indexes for your app:
 *
 * import { WorkflowDefinitionModel } from '@classytic/streamline';
 *
 * // Add your custom indexes
 * WorkflowDefinitionModel.collection.createIndex({ tenantId: 1, isActive: 1 });
 * WorkflowDefinitionModel.collection.createIndex({ orgId: 1, createdAt: -1 });
 *
 * OR extend the schema:
 *
 * import { WorkflowDefinitionModel } from '@classytic/streamline';
 * WorkflowDefinitionModel.schema.add({ tenantId: String });
 * WorkflowDefinitionModel.schema.index({ tenantId: 1, isActive: 1 });
 */

/**
 * Export WorkflowDefinitionModel with hot-reload safety
 *
 * The pattern checks if the model already exists before creating a new one.
 * This prevents "OverwriteModelError" in development with hot module replacement.
 */
let WorkflowDefinitionModel: mongoose.Model<WorkflowDefinitionDoc>;

if (mongoose.models.WorkflowDefinition) {
  // Model already exists - reuse it (for hot reload scenarios)
  WorkflowDefinitionModel = mongoose.models
    .WorkflowDefinition as mongoose.Model<WorkflowDefinitionDoc>;
} else {
  // Create new model
  WorkflowDefinitionModel = mongoose.model<WorkflowDefinitionDoc>(
    'WorkflowDefinition',
    WorkflowDefinitionSchema,
  );
}

export { WorkflowDefinitionModel };

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
 * Optional storage substrate for versioning / auditing / dynamic loading of
 * workflow definitions. Like {@link WorkflowRunRepository}, it inherits the
 * full mongokit CRUD / pagination / query / hook / plugin surface and carries
 * only the definition-specific domain verbs (version history, latest-active,
 * activation toggles).
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
 * comment above.
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
