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
    condition?: string; // Serialized condition function
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
        condition: String, // Serialized function for dynamic workflows
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

// Pre-save hook to parse version and populate numeric fields
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
}

/**
 * Repository for WorkflowDefinition
 * Optional: Use if you want to store workflows in MongoDB
 */
export const workflowDefinitionRepository = {
  /**
   * Create a new workflow definition (or version)
   */
  async create(definition: Partial<WorkflowDefinitionDoc>): Promise<WorkflowDefinitionDoc> {
    // Parse version if provided
    if (definition.version) {
      const parsed = semver.parse(definition.version);
      if (!parsed) {
        throw new Error(`Invalid semver version: ${definition.version}`);
      }
      definition.versionMajor = parsed.major;
      definition.versionMinor = parsed.minor;
      definition.versionPatch = parsed.patch;
    }
    const doc = await WorkflowDefinitionModel.create(definition);
    return doc.toObject() as WorkflowDefinitionDoc;
  },

  /**
   * Get latest active version of a workflow
   */
  async getLatestVersion(workflowId: string): Promise<WorkflowDefinitionDoc | null> {
    return (await WorkflowDefinitionModel.findOne({
      workflowId,
      isActive: true,
    })
      .sort({ versionMajor: -1, versionMinor: -1, versionPatch: -1 })
      .lean()) as WorkflowDefinitionDoc | null;
  },

  /**
   * Get specific version of a workflow
   */
  async getByVersion(workflowId: string, version: string): Promise<WorkflowDefinitionDoc | null> {
    return (await WorkflowDefinitionModel.findOne({
      workflowId,
      version,
    }).lean()) as WorkflowDefinitionDoc | null;
  },

  /**
   * Get all active workflow definitions (latest versions only)
   */
  async getActiveDefinitions(): Promise<WorkflowDefinitionDoc[]> {
    // Get latest version of each workflow using numeric semver fields
    const latestVersions = await WorkflowDefinitionModel.aggregate<WorkflowDefinitionDoc>([
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
    return latestVersions;
  },

  /**
   * Get all versions of a specific workflow
   */
  async getVersionHistory(workflowId: string): Promise<WorkflowDefinitionDoc[]> {
    const docs = await WorkflowDefinitionModel.find({ workflowId })
      .sort({ versionMajor: -1, versionMinor: -1, versionPatch: -1 })
      .lean();
    return docs as WorkflowDefinitionDoc[];
  },

  /**
   * Update a specific workflow version (rare - usually create new version)
   */
  async update(
    workflowId: string,
    version: string,
    updates: Partial<WorkflowDefinitionDoc>,
  ): Promise<WorkflowDefinitionDoc | null> {
    // If version is being changed, recompute numeric fields
    if (updates.version) {
      const parsed = semver.parse(updates.version);
      if (!parsed) {
        throw new Error(`Invalid semver version: ${updates.version}`);
      }
      updates.versionMajor = parsed.major;
      updates.versionMinor = parsed.minor;
      updates.versionPatch = parsed.patch;
    }

    return (await WorkflowDefinitionModel.findOneAndUpdate({ workflowId, version }, updates, {
      returnDocument: 'after',
    }).lean()) as WorkflowDefinitionDoc | null;
  },

  /**
   * Deactivate a specific version (or all versions if version not provided)
   */
  async deactivate(workflowId: string, version?: string): Promise<void> {
    const filter: DeactivateFilter = { workflowId };
    if (version) filter.version = version;
    await WorkflowDefinitionModel.updateMany(filter, { isActive: false });
  },

  /**
   * Deactivate all old versions (keep only latest)
   */
  async deactivateOldVersions(workflowId: string, keepVersion: string): Promise<void> {
    await WorkflowDefinitionModel.updateMany(
      { workflowId, version: { $ne: keepVersion } },
      { isActive: false },
    );
  },
};
