import { randomUUID } from 'node:crypto';
import type {
  WorkflowDefinition,
  WorkflowHandlers,
  Step,
  WorkflowRun,
  StepState,
  StepHandler,
} from '../core/types.js';
import { validateWorkflowDefinition } from '../utils/validation.js';

/**
 * Registry for workflow definition and handlers.
 * Provides validation and utility methods for workflow execution.
 */
export class WorkflowRegistry<TContext = Record<string, unknown>> {
  constructor(
    public readonly definition: WorkflowDefinition<TContext>,
    private readonly handlers: WorkflowHandlers<TContext>
  ) {
    // Use centralized validation
    validateWorkflowDefinition(definition, handlers);
  }

  /**
   * Get step definition by ID
   */
  getStep(stepId: string): Step | undefined {
    return this.definition.steps.find((s) => s.id === stepId);
  }

  /**
   * Get step handler by ID
   */
  getHandler(stepId: string): StepHandler<unknown, TContext> | undefined {
    return this.handlers[stepId];
  }

  /**
   * Get the next step after the given step ID
   */
  getNextStep(currentStepId: string): Step | undefined {
    const currentIndex = this.definition.steps.findIndex((s) => s.id === currentStepId);
    if (currentIndex === -1 || currentIndex === this.definition.steps.length - 1) {
      return undefined;
    }
    return this.definition.steps[currentIndex + 1];
  }

  /**
   * Create a new workflow run from input
   */
  createRun(input: unknown, meta?: Record<string, unknown>): WorkflowRun<TContext> {
    const now = new Date();
    const runId = randomUUID();

    const steps: StepState[] = this.definition.steps.map((step) => ({
      stepId: step.id,
      status: 'pending',
      attempts: 0,
    }));

    return {
      _id: runId,
      workflowId: this.definition.id,
      status: 'draft',
      steps,
      currentStepId: this.definition.steps[0]?.id || null,
      context: this.definition.createContext(input),
      input,
      createdAt: now,
      updatedAt: now,
      meta,
    };
  }

  /**
   * Rewind a workflow run to a previous step
   */
  rewindRun(run: WorkflowRun<TContext>, targetStepId: string): WorkflowRun<TContext> {
    const targetIndex = this.definition.steps.findIndex((s) => s.id === targetStepId);
    if (targetIndex === -1) {
      throw new Error(`Step "${targetStepId}" not found in workflow`);
    }

    run.steps = run.steps.map((stepState, index) => {
      if (index >= targetIndex) {
        // Reset to fresh state - clear ALL previous execution data
        return {
          stepId: stepState.stepId,
          status: 'pending' as const,
          attempts: 0,
          // Explicitly omit: output, error, waitingFor, startedAt, endedAt
        };
      }
      return stepState;
    });

    run.currentStepId = targetStepId;
    run.status = 'running';
    run.updatedAt = new Date();
    // Clear workflow-level completion data (will be set again when workflow finishes)
    run.output = undefined;
    run.endedAt = undefined;
    run.error = undefined;

    return run;
  }
}
