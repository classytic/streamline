/**
 * Input validation utilities for workflows
 * Centralized validation to prevent common errors with clear messages
 */

import type { WorkflowDefinition, WorkflowHandlers, Step } from '../core/types.js';
import { LIMITS } from '../config/constants.js';

// ============================================================================
// ID Validation
// ============================================================================

/**
 * Validate workflow/step ID format
 * Must be alphanumeric with hyphens/underscores only
 */
export function validateId(id: string, type: 'workflow' | 'step' = 'workflow'): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`${type} ID must be a non-empty string`);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      `${type} ID "${id}" contains invalid characters. ` +
      `Only alphanumeric characters, hyphens, and underscores are allowed.`
    );
  }

  if (id.length > LIMITS.MAX_ID_LENGTH) {
    throw new Error(`${type} ID "${id}" is too long (max ${LIMITS.MAX_ID_LENGTH} characters)`);
  }
}

/**
 * Validate retry configuration
 */
export function validateRetryConfig(retries?: number, timeout?: number): void {
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
    throw new Error(`retries must be a non-negative integer, got: ${retries}`);
  }

  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error(`timeout must be a positive integer (milliseconds), got: ${timeout}`);
  }
}

// ============================================================================
// Workflow Definition Validation
// ============================================================================

/**
 * Validate workflow definition and handlers.
 * Keeps it simple - validates IDs, checks for duplicates, ensures handlers exist.
 */
export function validateWorkflowDefinition<TContext>(
  definition: WorkflowDefinition<TContext>,
  handlers: WorkflowHandlers<TContext>
): void {
  if (!definition.id) throw new Error('Workflow ID is required');
  if (!definition.name) throw new Error('Workflow name is required');
  if (!definition.version) throw new Error('Workflow version is required');
  if (definition.steps.length === 0) throw new Error('Workflow must have at least one step');

  // Check for duplicate step IDs and missing handlers
  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    if (stepIds.has(step.id)) {
      throw new Error(`Duplicate step ID "${step.id}"`);
    }
    stepIds.add(step.id);

    if (!handlers[step.id]) {
      throw new Error(`Handler for step "${step.id}" not found`);
    }
  }
}
