/**
 * Clean helper for MongoDB step state updates
 * Handles $set/$unset logic with proper undefined handling
 */

import type { StepState, WorkflowRun } from '../core/types.js';

interface StepUpdateOperators {
  $set: Record<string, unknown>;
  $unset: Record<string, string>;
  [key: string]: unknown; // Index signature for compatibility with Record<string, unknown>
}

/**
 * Build MongoDB update operators for step state changes
 *
 * Automatically handles:
 * - undefined values → $unset (remove from document)
 * - defined values → $set (update document)
 * - Always updates workflow-level updatedAt timestamp
 *
 * @param stepIndex - Array index of step in workflow.steps[]
 * @param updates - Partial step state with fields to update
 * @param includeStatus - Whether to include derived status in $set
 * @returns MongoDB update operators ready for updateOne()
 */
export function buildStepUpdateOps(
  stepIndex: number,
  updates: Partial<StepState>,
  options?: { includeStatus?: string; includeUpdatedAt?: boolean },
): StepUpdateOperators {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, string> = {};

  // Process each update field
  for (const [key, value] of Object.entries(updates)) {
    const fieldPath = `steps.${stepIndex}.${key}`;

    if (value === undefined) {
      $unset[fieldPath] = ''; // Remove field
    } else {
      $set[fieldPath] = value; // Update field
    }
  }

  // Always update metadata
  if (options?.includeUpdatedAt !== false) {
    $set.updatedAt = new Date();
  }

  // Optionally include workflow status
  if (options?.includeStatus) {
    $set.status = options.includeStatus;
  }

  return { $set, $unset };
}

/**
 * Apply step updates to in-memory workflow run
 * Mirrors MongoDB update operations for consistency
 */
export function applyStepUpdates<_TContext>(
  stepId: string,
  steps: StepState[],
  updates: Partial<StepState>,
): StepState[] {
  return steps.map((step) => {
    if (step.stepId !== stepId) return step;

    // Apply updates
    const updated = { ...step, ...updates };

    // Remove undefined fields (mirroring $unset)
    for (const key in updates) {
      if (updates[key as keyof StepState] === undefined) {
        delete updated[key as keyof StepState];
      }
    }

    return updated;
  });
}

/** Mongoose document with toObject method */
interface MongooseDocument<T> {
  toObject(): T;
  context?: unknown;
}

/**
 * Convert Mongoose document to plain object (if needed)
 * Preserves context field which Mongoose sometimes drops for empty objects
 */
export function toPlainRun<TContext>(
  run: WorkflowRun<TContext> | MongooseDocument<WorkflowRun<TContext>>,
): WorkflowRun<TContext> {
  if ('toObject' in run && typeof run.toObject === 'function') {
    const savedContext = run.context;
    const plain = run.toObject();

    // Restore context if Mongoose dropped it
    if (plain.context === undefined && savedContext !== undefined) {
      plain.context = savedContext as TContext;
    }

    return plain;
  }

  return run as WorkflowRun<TContext>;
}
