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
import type { MongoOperatorUpdate } from '@classytic/mongokit';
import type { StepOutputVersion, StepState, WorkflowRun } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A well-formed Mongo update document — top-level keys are all operators
 * (`$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`).
 *
 * `updateOne()` also accepts a plain field-shape object as a convenience
 * (auto-wrapped in `$set`) — that's typed as `Partial<TDoc>` at call sites.
 *
 * Aliased to `MongoOperatorUpdate` from `@classytic/mongokit` 3.13+ —
 * inherits the explicit operator typing (`$set`, `$unset`, `$inc`, `$mul`,
 * `$push`, `$pull`, `$pullAll`, `$addToSet`, `$pop`, `$min`, `$max`,
 * `$rename`, `$currentDate`, `$bit`) plus the `[op: string]: unknown`
 * index signature that lets a caller-built update value assign to
 * `Record<string, unknown>` without the historic
 * `as unknown as Record<string, unknown>` cast.
 */
export type MongoUpdate = MongoOperatorUpdate;

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
 * Append-a-history-version directive for {@link buildStepUpdateOps} /
 * {@link applyStepUpdates}. When present, the builders emit (and the in-memory
 * mirror replicates) a bounded `$push` + `$slice:-keep` ring write on
 * `steps.<index>.outputHistory` ALONGSIDE the normal `$set`/`$unset` for the
 * fresh output. The two must stay in the SAME atomic update so the prior
 * generation and the new output commit (or not) together.
 */
export interface OutputHistoryPush {
  /** The prior committed generation being archived. */
  version: StepOutputVersion;
  /** Ring-buffer depth — oldest entries past `keep` are evicted (`$slice:-keep`). */
  keep: number;
}

/**
 * Build `$set`/`$unset` for a single step's state at `steps.<index>.<field>`.
 *
 * `undefined` values in `updates` become `$unset` entries (Mongo removes the
 * field) — that's the established convention across the engine and must not
 * change without auditing every step-state write.
 *
 * INTERNAL-CONTRACT NOTE: when `options.historyPush` is supplied this builder
 * additionally emits a `$push: { steps.<i>.outputHistory: { $each: [v],
 * $slice: -keep } }` operator. Callers/consumers that relied on this function
 * returning ONLY `{ $set, $unset }` must tolerate an optional `$push` key.
 * The push is only present on the opt-in output-history rerun path; the
 * default (disabled) path is byte-for-byte unchanged.
 */
export function buildStepUpdateOps(
  stepIndex: number,
  updates: Partial<StepState>,
  options?: { includeStatus?: string; includeUpdatedAt?: boolean; historyPush?: OutputHistoryPush },
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

  const ops: StepUpdateOperators = { $set, $unset };

  if (options?.historyPush && options.historyPush.keep > 0) {
    ops.$push = {
      [`steps.${stepIndex}.outputHistory`]: {
        $each: [options.historyPush.version],
        $slice: -options.historyPush.keep,
      },
    };
  }

  return ops;
}

/**
 * Apply the same step-field updates to an in-memory `steps[]` array so the
 * mirror matches what the DB update will produce (undefined → delete).
 *
 * When `historyPush` is supplied this replicates the SAME ring semantics the
 * DB `$push` + `$slice:-keep` produces (append the prior version, then trim
 * from the FRONT when `length > keep`) so a same-process read after the write
 * sees exactly what crash-recovery would reload (cross-cutting invariant #1).
 */
export function applyStepUpdates<_TContext>(
  stepId: string,
  steps: StepState[],
  updates: Partial<StepState>,
  historyPush?: OutputHistoryPush,
): StepState[] {
  return steps.map((step) => {
    if (step.stepId !== stepId) return step;
    const updated = { ...step, ...updates };
    for (const key in updates) {
      if (updates[key as keyof StepState] === undefined) {
        delete updated[key as keyof StepState];
      }
    }

    if (historyPush && historyPush.keep > 0) {
      // Append then trim-from-front — mirrors Mongo's `$push` + `$slice:-keep`.
      const next = [...(updated.outputHistory ?? []), historyPush.version];
      updated.outputHistory =
        next.length > historyPush.keep ? next.slice(next.length - historyPush.keep) : next;
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
