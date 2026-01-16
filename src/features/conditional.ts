import type { Step, WorkflowRun } from '../core/types.js';

export interface ConditionalStep extends Step {
  condition?: (context: unknown, run: WorkflowRun<unknown>) => boolean | Promise<boolean>;
  skipIf?: (context: unknown) => boolean | Promise<boolean>;
  runIf?: (context: unknown) => boolean | Promise<boolean>;
}

export function isConditionalStep(step: Step): step is ConditionalStep {
  const conditionalStep = step as ConditionalStep;
  return !!(conditionalStep.condition || conditionalStep.skipIf || conditionalStep.runIf);
}

export async function shouldSkipStep<TContext>(
  step: ConditionalStep,
  context: TContext,
  run: WorkflowRun<TContext>
): Promise<boolean> {
  if (step.condition) {
    // Condition function accepts unknown context/run, allowing any TContext
    const result = await Promise.resolve(step.condition(context, run as WorkflowRun<unknown>));
    return !result;
  }

  if (step.skipIf) {
    return await Promise.resolve(step.skipIf(context));
  }

  if (step.runIf) {
    const result = await Promise.resolve(step.runIf(context));
    return !result;
  }

  return false;
}

export function createCondition<TContext>(
  predicate: (context: TContext) => boolean
): (context: TContext) => boolean {
  return predicate;
}

export const conditions = {
  hasValue: <TContext>(key: keyof TContext) => (context: TContext) =>
    context[key] !== undefined && context[key] !== null,

  equals: <TContext>(key: keyof TContext, value: TContext[keyof TContext]) => (context: TContext) =>
    context[key] === value,

  notEquals: <TContext>(key: keyof TContext, value: TContext[keyof TContext]) => (context: TContext) =>
    context[key] !== value,

  greaterThan: <TContext>(key: keyof TContext, value: number) => (context: TContext) =>
    typeof context[key] === 'number' && (context[key] as number) > value,

  lessThan: <TContext>(key: keyof TContext, value: number) => (context: TContext) =>
    typeof context[key] === 'number' && (context[key] as number) < value,

  in: <TContext>(key: keyof TContext, values: readonly TContext[keyof TContext][]) => (context: TContext) =>
    values.includes(context[key]),

  and:
    <TContext>(...predicates: Array<(context: TContext) => boolean>) =>
    (context: TContext) =>
      predicates.every((p) => p(context)),

  or:
    <TContext>(...predicates: Array<(context: TContext) => boolean>) =>
    (context: TContext) =>
      predicates.some((p) => p(context)),

  not:
    <TContext>(predicate: (context: TContext) => boolean) =>
    (context: TContext) =>
      !predicate(context),

  custom: <TContext>(predicate: (context: TContext) => boolean) => predicate,
};
