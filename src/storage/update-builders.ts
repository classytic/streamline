/**
 * Typed MongoDB update-doc builders for workflow runs.
 *
 * Streamline's `updateOne()` takes raw Mongo operators (`$set`, `$unset`,
 * `$inc`, `$push`). Building them inline at each call site caused drift:
 * some paths forgot `updatedAt`, others mixed operator and field keys and
 * silently dropped writes. These helpers encode the patterns once.
 *
 * The Update IR from `@classytic/repo-core/update` is intentionally NOT used
 * here — streamline is Mongo-only, so the IR's portability value is zero.
 * We keep raw-operator builders so the atomic-claim paths stay one layer
 * closer to the wire.
 */
import type { StepState, WorkflowRun } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A well-formed Mongo update document — top-level keys are all operators
 * (`$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`).
 *
 * `updateOne()` also accepts a plain field-shape object as a convenience
 * (auto-wrapped in `$set`) — that's typed as `Partial<TDoc>` at call sites.
 */
export interface MongoUpdate {
  $set?: Record<string, unknown>;
  $unset?: Record<string, '' | 1>;
  $inc?: Record<string, number>;
  $push?: Record<string, unknown>;
  $pull?: Record<string, unknown>;
  $addToSet?: Record<string, unknown>;
}

type UpdateDoc = MongoUpdate | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Guardrails — catch mixed-operator-and-field bugs loudly
// ---------------------------------------------------------------------------

/**
 * Normalize an update doc and reject malformed shapes.
 *
 * - Accepts `{ $set: {...}, $unset: {...} }` → returned as-is.
 * - Accepts `{ field: value, ... }` → wrapped as `{ $set: { field: value, ... } }`.
 * - Rejects a mix (e.g. `{ $set: {...}, status: 'foo' }`) — Mongo would
 *   silently drop the non-operator keys. That was the single most frequent
 *   update-path bug before this helper landed.
 */
export function normalizeUpdate(update: UpdateDoc): MongoUpdate {
  const keys = Object.keys(update);
  if (keys.length === 0) return update as MongoUpdate;

  const operatorKeys: string[] = [];
  const fieldKeys: string[] = [];
  for (const k of keys) {
    if (k.startsWith('$')) operatorKeys.push(k);
    else fieldKeys.push(k);
  }

  if (operatorKeys.length > 0 && fieldKeys.length > 0) {
    throw new Error(
      `[streamline] Malformed update: cannot mix operators (${operatorKeys.join(', ')}) ` +
        `with raw field keys (${fieldKeys.join(', ')}). Mongo would silently drop the fields. ` +
        `Wrap them explicitly: { $set: { ${fieldKeys.join(', ')} } }.`,
    );
  }

  return operatorKeys.length > 0
    ? (update as MongoUpdate)
    : { $set: update as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Run-level builders
// ---------------------------------------------------------------------------

/** `$set` over workflow-run fields with automatic `updatedAt`. */
export function runSet(patch: Partial<WorkflowRun> & Record<string, unknown>): MongoUpdate {
  return { $set: { ...patch, updatedAt: new Date() } };
}

/**
 * `$set` + `$unset` in one update, with automatic `updatedAt`. Pass a list of
 * top-level keys (or dotted paths) to unset.
 */
export function runSetUnset(
  set: Partial<WorkflowRun> & Record<string, unknown>,
  unset: ReadonlyArray<string>,
): MongoUpdate {
  const $unset: Record<string, ''> = {};
  for (const key of unset) $unset[key] = '';
  return { $set: { ...set, updatedAt: new Date() }, $unset };
}

// ---------------------------------------------------------------------------
// Step-level builders (ported from the former step-updater.ts)
// ---------------------------------------------------------------------------

interface StepUpdateOperators {
  $set: Record<string, unknown>;
  $unset: Record<string, ''>;
  [key: string]: unknown;
}

/**
 * Build `$set`/`$unset` for a single step's state at `steps.<index>.<field>`.
 *
 * `undefined` values in `updates` become `$unset` entries (Mongo removes the
 * field) — that's the established convention across the engine and must not
 * change without auditing every step-state write.
 */
export function buildStepUpdateOps(
  stepIndex: number,
  updates: Partial<StepState>,
  options?: { includeStatus?: string; includeUpdatedAt?: boolean },
): StepUpdateOperators {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};

  for (const [key, value] of Object.entries(updates)) {
    const fieldPath = `steps.${stepIndex}.${key}`;
    if (value === undefined) $unset[fieldPath] = '';
    else $set[fieldPath] = value;
  }

  if (options?.includeUpdatedAt !== false) $set.updatedAt = new Date();
  if (options?.includeStatus) $set.status = options.includeStatus;

  return { $set, $unset };
}

/**
 * Apply the same step-field updates to an in-memory `steps[]` array so the
 * mirror matches what the DB update will produce (undefined → delete).
 */
export function applyStepUpdates<_TContext>(
  stepId: string,
  steps: StepState[],
  updates: Partial<StepState>,
): StepState[] {
  return steps.map((step) => {
    if (step.stepId !== stepId) return step;
    const updated = { ...step, ...updates };
    for (const key in updates) {
      if (updates[key as keyof StepState] === undefined) {
        delete updated[key as keyof StepState];
      }
    }
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Mongoose doc conversion — Mongoose sometimes drops empty `context`, so
// preserve it explicitly.
// ---------------------------------------------------------------------------

interface MongooseDocument<T> {
  toObject(): T;
  context?: unknown;
}

export function toPlainRun<TContext>(
  run: WorkflowRun<TContext> | MongooseDocument<WorkflowRun<TContext>>,
): WorkflowRun<TContext> {
  if ('toObject' in run && typeof run.toObject === 'function') {
    const savedContext = run.context;
    const plain = run.toObject();
    if (plain.context === undefined && savedContext !== undefined) {
      plain.context = savedContext as TContext;
    }
    return plain;
  }
  return run as WorkflowRun<TContext>;
}
