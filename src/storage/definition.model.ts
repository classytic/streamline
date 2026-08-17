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

import { Schema } from 'mongoose';
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

/**
 * Build the WorkflowDefinition schema (fields, semver pre-save hook, and
 * versioning indexes). Pure factory — invoked by
 * `defineStreamlineModels().bind(connection)`; registers nothing itself.
 */
export function buildWorkflowDefinitionSchema(): Schema<WorkflowDefinitionDoc> {
  const WorkflowDefinitionSchema = new Schema<WorkflowDefinitionDoc>(
    {
      // No field-level index — the {workflowId, version} unique compound covers
      // the prefix (P11.1). (Not _id!)
      workflowId: { type: String, required: true },
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

  return WorkflowDefinitionSchema;
}

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
