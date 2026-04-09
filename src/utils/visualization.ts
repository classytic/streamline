import type { StepState, WorkflowRun } from '../core/types.js';

export interface StepTimeline {
  id: string;
  status: StepState['status'];
  duration: number | null;
  startedAt?: Date;
  endedAt?: Date;
}

export interface WorkflowProgress {
  completed: number;
  total: number;
  percentage: number;
}

export interface StepUIState extends StepState {
  isCurrentStep: boolean;
  isPastStep: boolean;
  isFutureStep: boolean;
  canRewindTo: boolean;
}

export function getStepTimeline(run: WorkflowRun): StepTimeline[] {
  return run.steps.map((step) => ({
    id: step.stepId,
    status: step.status,
    duration:
      step.startedAt && step.endedAt ? step.endedAt.getTime() - step.startedAt.getTime() : null,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  }));
}

export function getWorkflowProgress(run: WorkflowRun): WorkflowProgress {
  const total = run.steps.length;
  const completed = run.steps.filter((s) => s.status === 'done').length;

  return {
    completed,
    total,
    percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

export function getStepUIStates(run: WorkflowRun): StepUIState[] {
  const currentIndex = run.steps.findIndex((s) => s.stepId === run.currentStepId);

  return run.steps.map((step, index) => ({
    ...step,
    isCurrentStep: step.stepId === run.currentStepId,
    isPastStep: index < currentIndex,
    isFutureStep: index > currentIndex,
    canRewindTo: index <= currentIndex && step.status === 'done',
  }));
}

export function getWaitingInfo(run: WorkflowRun) {
  const waitingStep = run.steps.find((s) => s.status === 'waiting');
  if (!waitingStep?.waitingFor) return null;

  return {
    stepId: waitingStep.stepId,
    type: waitingStep.waitingFor.type,
    reason: waitingStep.waitingFor.reason,
    resumeAt: waitingStep.waitingFor.resumeAt,
    eventName: waitingStep.waitingFor.eventName,
    data: waitingStep.waitingFor.data,
  };
}

export function canRewindTo(run: WorkflowRun, stepId: string): boolean {
  const step = run.steps.find((s) => s.stepId === stepId);
  if (!step) return false;

  const stepIndex = run.steps.findIndex((s) => s.stepId === stepId);
  const currentIndex = run.steps.findIndex((s) => s.stepId === run.currentStepId);

  return stepIndex <= currentIndex && step.status === 'done';
}

export function getExecutionPath(run: WorkflowRun): string[] {
  return run.steps.filter((s) => s.status === 'done').map((s) => s.stepId);
}
