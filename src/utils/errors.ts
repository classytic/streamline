/**
 * Custom error classes with rich context for better debugging
 */

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly context: {
      runId?: string;
      workflowId?: string;
      stepId?: string;
      [key: string]: unknown;
    }
  ) {
    super(message);
    this.name = 'WorkflowError';
  }

  toString(): string {
    const contextStr = Object.entries(this.context)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    return `${this.name}: ${this.message} (${contextStr})`;
  }
}

export class StepNotFoundError extends WorkflowError {
  constructor(stepId: string, workflowId: string, availableSteps: string[]) {
    super(
      `Step "${stepId}" not found in workflow "${workflowId}". Available steps: ${availableSteps.join(', ')}`,
      { stepId, workflowId, availableSteps }
    );
    this.name = 'StepNotFoundError';
  }
}

export class WorkflowNotFoundError extends WorkflowError {
  constructor(runId: string) {
    super(`Workflow run "${runId}" not found in database`, { runId });
    this.name = 'WorkflowNotFoundError';
  }
}

export class InvalidStateError extends WorkflowError {
  constructor(
    action: string,
    currentState: string,
    expectedStates: string[],
    context: { runId?: string; stepId?: string }
  ) {
    super(
      `Cannot ${action} - workflow is in state "${currentState}". Expected one of: ${expectedStates.join(', ')}`,
      { action, currentState, expectedStates, ...context }
    );
    this.name = 'InvalidStateError';
  }
}

export class StepTimeoutError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly timeoutMs: number
  ) {
    super(`Step "${stepId}" exceeded timeout of ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
  }
}

export class DataCorruptionError extends WorkflowError {
  constructor(reason: string, context: { runId: string; [key: string]: unknown }) {
    super(`Data corruption detected: ${reason}`, context);
    this.name = 'DataCorruptionError';
  }
}

/**
 * Helper to create descriptive error messages
 */
export function createErrorMessage(parts: {
  action: string;
  subject?: string;
  reason?: string;
  suggestion?: string;
}): string {
  let message = parts.action;
  
  if (parts.subject) {
    message += ` ${parts.subject}`;
  }
  
  if (parts.reason) {
    message += ` - ${parts.reason}`;
  }
  
  if (parts.suggestion) {
    message += `. ${parts.suggestion}`;
  }
  
  return message;
}
