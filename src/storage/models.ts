/**
 * Streamline model set — the ONE authoritative place streamline's three
 * Mongoose models are described and registered.
 *
 * `defineStreamlineModels(config)` returns a connection-free mongokit
 * `ModelBlueprint` (STANDARDIZATION-PLAN §5). It replaces the three
 * hand-rolled `mongoose.models.X || mongoose.model()` hot-reload guards that
 * previously lived in `run.model.ts`, `definition.model.ts` and
 * `concurrency-counter.model.ts` — those each independently reimplemented
 * collision handling against the GLOBAL mongoose registry, the exact
 * Mongoose-9 hygiene issue mongokit's `defineModels` exists to close.
 *
 * ## Why streamline binds eagerly here (and does NOT gain a `bind(connection)`
 *    engine seam)
 *
 * Streamline is a DI-container / repository library, not a domain kernel with
 * a `createX(connection) → engine` construction triad. Its repositories are
 * module-level singletons over the default mongoose connection, and
 * `createContainer()` takes no connection. So there is no boot seam at which a
 * host would call `blueprint.bind(conn)`. The faithful conversion therefore
 * keeps the current eager, default-connection registration — but routes it
 * through mongokit's single, safe registration API instead of three
 * hand-rolled global-registry guards.
 *
 * The blueprint is still exported so a host CAN describe/inspect the model set
 * (`defineStreamlineModels().modelNames`) or bind it against an explicit
 * connection if it ever wires streamline onto a non-default connection.
 *
 * ## Existing-model policy: `reuse`
 *
 * The old guards were `mongoose.models.X ? reuse : create` — i.e. hot-reload
 * safe reuse. `reuse` preserves that exact semantic (an already-registered
 * model is returned as-is, the schema factory is not re-run). It is the
 * correct choice here because this file registers the FULL canonical schema
 * for each model (it is not contributing fields to someone else's model, the
 * case `throw` guards against).
 */

import { defineModels, type ExistingModelPolicy, type ModelBlueprint } from '@classytic/mongokit';
import mongoose, { type Model } from 'mongoose';
import type { WorkflowRun } from '../core/types.js';
import {
  buildWorkflowConcurrencyCounterSchema,
  type WorkflowConcurrencyCounter,
} from './concurrency-counter.model.js';
import { buildWorkflowDefinitionSchema, type WorkflowDefinitionDoc } from './definition.model.js';
import { buildWorkflowRunSchema } from './run.model.js';

/** The typed model bag streamline binds against a connection. */
export interface StreamlineModels {
  WorkflowRun: Model<WorkflowRun>;
  WorkflowDefinition: Model<WorkflowDefinitionDoc>;
  WorkflowConcurrencyCounter: Model<WorkflowConcurrencyCounter>;
}

/** Describe-time knobs for the streamline model set. */
export interface DefineStreamlineModelsConfig {
  /**
   * What to do when a model name is already registered on the bind
   * connection. Default `{ mode: 'reuse' }` — hot-reload safe, matching the
   * guards this replaced. Pass `{ mode: 'replace', environment: 'test' }` for
   * fixtures that intentionally rebuild the schema.
   */
  existing?: ExistingModelPolicy;
  /**
   * Dot-path of the tenant field on the run doc (default `'context.tenantId'`).
   * Drives the COMPOUND idempotency unique index `{ [tenantField], idempotencyKey }`
   * so keys are unique per-tenant. MUST match the repository's
   * `tenant.tenantField` — otherwise the index and the tenant-scoped lookup
   * disagree.
   */
  tenantField?: string;
}

/**
 * Describe streamline's three models as a connection-free mongokit blueprint.
 * Pure — builds no schema and registers nothing until `.bind(connection)`.
 * Order-preserving; a name collision surfaces as mongokit's typed
 * `ModelCollisionError`.
 */
export function defineStreamlineModels(
  config: DefineStreamlineModelsConfig = {},
): ModelBlueprint<StreamlineModels> {
  const existing: ExistingModelPolicy = config.existing ?? { mode: 'reuse' };
  const tenantField = config.tenantField ?? 'context.tenantId';
  return defineModels<StreamlineModels>({
    models: [
      // Closure so the tenant-scoped idempotency index tracks the configured field.
      { name: 'WorkflowRun', schema: () => buildWorkflowRunSchema(tenantField), existing },
      { name: 'WorkflowDefinition', schema: buildWorkflowDefinitionSchema, existing },
      {
        name: 'WorkflowConcurrencyCounter',
        schema: buildWorkflowConcurrencyCounterSchema,
        existing,
      },
    ],
    assemble: (models) =>
      // Cast through `unknown`: the models use string `_id` (WorkflowRun,
      // counter) so `Model<unknown>` doesn't structurally overlap the typed
      // `Model<T>` — mongokit's blueprint erases per-spec doc types, and
      // `assemble` is the documented re-typing seam.
      Object.freeze({
        WorkflowRun: models.get('WorkflowRun') as unknown as Model<WorkflowRun>,
        WorkflowDefinition: models.get(
          'WorkflowDefinition',
        ) as unknown as Model<WorkflowDefinitionDoc>,
        WorkflowConcurrencyCounter: models.get(
          'WorkflowConcurrencyCounter',
        ) as unknown as Model<WorkflowConcurrencyCounter>,
      }),
  });
}

/**
 * The bound model set — registered eagerly against the default mongoose
 * connection at import, exactly as the old `mongoose.model()` guards did.
 * Mongoose permits registering models before `connect()`; they attach to the
 * default connection when it opens.
 */
const streamlineModels: StreamlineModels = defineStreamlineModels().bind(mongoose.connection);

/** Mongoose model for workflow runs — direct queries + custom indexes. */
export const WorkflowRunModel = streamlineModels.WorkflowRun;
/** Optional WorkflowDefinition storage model (versioning / auditing). */
export const WorkflowDefinitionModel = streamlineModels.WorkflowDefinition;
/** Strict-concurrency counter model. */
export const WorkflowConcurrencyCounterModel = streamlineModels.WorkflowConcurrencyCounter;
