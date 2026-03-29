/**
 * Simplified Workflow Definition API
 *
 * Inspired by Vercel's workflow - cleaner, function-based syntax.
 * No compiler needed - just cleaner ergonomics.
 *
 * @example
 * ```typescript
 * import { createWorkflow } from '@classytic/streamline';
 *
 * const userSignup = createWorkflow('user-signup', {
 *   steps: {
 *     createUser: async (ctx) => {
 *       return { id: crypto.randomUUID(), email: ctx.input.email };
 *     },
 *     sendWelcome: async (ctx) => {
 *       const user = ctx.getOutput('createUser');
 *       await sendEmail(user.email, 'Welcome!');
 *     },
 *     onboard: async (ctx) => {
 *       await ctx.sleep(5000);
 *       await sendOnboardingEmail(ctx.getOutput('createUser'));
 *     },
 *   },
 *   context: (input) => ({ email: input.email }),
 * });
 *
 * // Start workflow
 * const run = await userSignup.start({ email: 'test@example.com' });
 * ```
 */

import { WorkflowEngine } from '../execution/engine.js';
import { createContainer, type StreamlineContainer } from '../core/container.js';
import { isTerminalState } from '../core/status.js';
import type { WorkflowDefinition, StepHandler, WorkflowRun, StepContext, Step } from '../core/types.js';
import { validateId, validateRetryConfig } from '../utils/validation.js';
import { WorkflowNotFoundError } from '../utils/errors.js';

// camelCase/kebab-case -> Title Case
const toName = (id: string) =>
  id
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());

// ============================================================================
// Step Configuration
// ============================================================================

/**
 * Per-step configuration for overriding timeout, retries, and conditions.
 *
 * `TContext` flows from `WorkflowConfig` — no manual annotation needed.
 *
 * @example
 * ```typescript
 * const workflow = createWorkflow('pipeline', {
 *   steps: {
 *     clone: {
 *       handler: async (ctx) => { ... },
 *       timeout: 120_000,
 *       retries: 5,
 *     },
 *     review: {
 *       handler: async (ctx) => { ... },
 *       timeout: 300_000,
 *       skipIf: (ctx) => ctx.autoApproved, // ctx is your TContext
 *     },
 *   },
 * });
 * ```
 */
export interface StepConfig<TOutput = unknown, TContext = Record<string, unknown>> {
  handler: StepHandler<TOutput, TContext>;
  timeout?: number;
  retries?: number;
  condition?: (context: TContext, run: WorkflowRun) => boolean | Promise<boolean>;
  skipIf?: (context: TContext) => boolean | Promise<boolean>;
  runIf?: (context: TContext) => boolean | Promise<boolean>;

  /**
   * Compensation handler (saga pattern rollback).
   *
   * Called in reverse order when a later step fails permanently.
   * Only runs for steps that completed successfully (status: 'done').
   *
   * @example
   * ```typescript
   * charge: {
   *   handler: async (ctx) => stripe.charges.create({ amount: 100 }),
   *   onCompensate: async (ctx) => {
   *     const chargeId = ctx.getOutput<{ id: string }>('charge')?.id;
   *     await stripe.refunds.create({ charge: chargeId });
   *   },
   * },
   * ```
   */
  onCompensate?: StepHandler<unknown, TContext>;
}

/** Type guard: is the step entry a StepConfig object (vs a plain handler fn)? */
function isStepConfig<TOutput, TContext>(
  step: StepHandler<TOutput, TContext> | StepConfig<TOutput, TContext>
): step is StepConfig<TOutput, TContext> {
  return typeof step === 'object' && step !== null && 'handler' in step;
}

/**
 * Convert a StepConfig entry into a Step definition.
 *
 * The Step interface uses `(context: unknown)` for conditions because steps are
 * stored in WorkflowDefinition (untyped at runtime). This is the one boundary
 * where typed `TContext` callbacks widen to `unknown` — safe because the executor
 * always passes the correct TContext at call sites.
 */
function toStepDef<TContext>(stepId: string, entry: StepConfig<unknown, TContext>): Step {
  const step: Step = { id: stepId, name: toName(stepId) };

  if (entry.timeout !== undefined) step.timeout = entry.timeout;
  if (entry.retries !== undefined) step.retries = entry.retries;

  // TContext → unknown widening: safe at this boundary.
  // The executor calls these with the real TContext value.
  if (entry.condition) step.condition = entry.condition as Step['condition'];
  if (entry.skipIf) step.skipIf = entry.skipIf as Step['skipIf'];
  if (entry.runIf) step.runIf = entry.runIf as Step['runIf'];

  return step;
}

// ============================================================================
// Workflow Configuration
// ============================================================================

/**
 * Configuration for `createWorkflow()`.
 *
 * Steps can be plain async handlers or `StepConfig` objects with per-step
 * timeout, retries, and conditions. Mix freely — `TContext` infers everywhere.
 *
 * @example
 * ```typescript
 * const config: WorkflowConfig<MyContext> = {
 *   steps: {
 *     fast: async (ctx) => ctx.context.value * 2,
 *     slow: { handler: async (ctx) => heavyWork(), timeout: 120_000 },
 *   },
 *   context: (input) => ({ value: input.n }),
 * };
 * ```
 */
export interface WorkflowConfig<TContext, TInput = unknown> {
  steps: Record<string, StepHandler<unknown, TContext> | StepConfig<unknown, TContext>>;
  context?: (input: TInput) => TContext;
  version?: string;
  defaults?: { retries?: number; timeout?: number };
  autoExecute?: boolean;
  /** Optional custom container for dependency injection */
  container?: StreamlineContainer;
}

/** Options for `Workflow.waitFor()` */
export interface WaitForOptions {
  /** Poll interval in ms @default 1000 */
  pollInterval?: number;
  /** Maximum time to wait in ms @default undefined (no timeout) */
  timeout?: number;
}

/**
 * A running workflow instance returned by `createWorkflow()`.
 *
 * Exported so consumers can type variables without the `ReturnType<>` workaround.
 *
 * @example
 * ```typescript
 * import { createWorkflow, type Workflow } from '@classytic/streamline';
 *
 * export const myWorkflow: Workflow<MyCtx, MyInput> = createWorkflow('my', { ... });
 * ```
 */
export interface Workflow<TContext, TInput = unknown> {
  start: (input: TInput, meta?: Record<string, unknown>) => Promise<WorkflowRun<TContext>>;
  get: (runId: string) => Promise<WorkflowRun<TContext> | null>;
  execute: (runId: string) => Promise<WorkflowRun<TContext>>;
  resume: (runId: string, payload?: unknown) => Promise<WorkflowRun<TContext>>;
  cancel: (runId: string) => Promise<WorkflowRun<TContext>>;
  pause: (runId: string) => Promise<WorkflowRun<TContext>>;
  rewindTo: (runId: string, stepId: string) => Promise<WorkflowRun<TContext>>;
  waitFor: (runId: string, options?: WaitForOptions) => Promise<WorkflowRun<TContext>>;
  shutdown: () => void;
  definition: WorkflowDefinition<TContext>;
  engine: WorkflowEngine<TContext>;
  /** The container used by this workflow (for testing or custom integrations) */
  container: StreamlineContainer;
}

// ============================================================================
// createWorkflow()
// ============================================================================

/**
 * Create a workflow with inline step handlers
 *
 * @example
 * ```typescript
 * const orderProcess = createWorkflow('order-process', {
 *   steps: {
 *     validate: async (ctx) => validateOrder(ctx.input),
 *     charge: async (ctx) => chargeCard(ctx.getOutput('validate')),
 *     fulfill: async (ctx) => shipOrder(ctx.getOutput('charge')),
 *     notify: async (ctx) => sendConfirmation(ctx.context.email),
 *   },
 *   context: (input) => ({ orderId: input.id, email: input.email }),
 * });
 *
 * await orderProcess.start({ id: '123', email: 'user@example.com' });
 * ```
 *
 * @example Per-step configuration
 * ```typescript
 * const pipeline = createWorkflow('ci-pipeline', {
 *   steps: {
 *     clone: { handler: async (ctx) => { ... }, timeout: 120_000 },
 *     build: { handler: async (ctx) => { ... }, retries: 5 },
 *     deploy: {
 *       handler: async (ctx) => { ... },
 *       skipIf: (ctx) => !ctx.shouldDeploy,
 *     },
 *   },
 * });
 * ```
 */
export function createWorkflow<TContext = Record<string, unknown>, TInput = unknown>(
  id: string,
  config: WorkflowConfig<TContext, TInput>
): Workflow<TContext, TInput> {
  validateId(id, 'workflow');

  const stepIds = Object.keys(config.steps);
  if (stepIds.length === 0) {
    throw new Error('Workflow must have at least one step');
  }

  if (config.defaults) {
    validateRetryConfig(config.defaults.retries, config.defaults.timeout);
  }

  // Normalize: separate handlers, compensation handlers, and step definitions
  const handlers: Record<string, StepHandler<unknown, TContext>> = {};
  const compensationHandlers: Record<string, StepHandler<unknown, TContext>> = {};
  const steps: Step[] = stepIds.map((stepId) => {
    // stepId comes from Object.keys(config.steps) — always defined
    const entry = config.steps[stepId]!;

    if (isStepConfig(entry)) {
      handlers[stepId] = entry.handler;
      if (entry.onCompensate) {
        compensationHandlers[stepId] = entry.onCompensate;
      }
      return toStepDef(stepId, entry);
    }

    handlers[stepId] = entry;
    return { id: stepId, name: toName(stepId) };
  });

  const definition: WorkflowDefinition<TContext> = {
    id,
    name: toName(id),
    version: config.version ?? '1.0.0',
    steps,
    createContext: (config.context ?? ((input) => input)) as (input: unknown) => TContext,
    defaults: config.defaults,
  };

  const container = config.container ?? createContainer();

  const engine = new WorkflowEngine(definition, handlers, container, {
    ...(config.autoExecute !== undefined && { autoExecute: config.autoExecute }),
    compensationHandlers: Object.keys(compensationHandlers).length > 0
      ? compensationHandlers as unknown as Record<string, import('../core/types.js').StepHandler<unknown, unknown>>
      : undefined,
  });

  const waitFor = async (
    runId: string,
    options: WaitForOptions = {}
  ): Promise<WorkflowRun<TContext>> => {
    const { pollInterval = 1000, timeout } = options;
    const startTime = Date.now();

    while (true) {
      const run = await engine.get(runId);

      if (!run) {
        throw new WorkflowNotFoundError(runId);
      }

      if (isTerminalState(run.status)) {
        return run;
      }

      if (timeout && Date.now() - startTime >= timeout) {
        throw new Error(
          `Timeout waiting for workflow "${runId}" to complete after ${timeout}ms. Current status: ${run.status}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  };

  return {
    start: (input, meta) => engine.start(input, meta),
    get: (runId) => engine.get(runId),
    execute: (runId) => engine.execute(runId),
    resume: (runId, payload) => engine.resume(runId, payload),
    cancel: (runId) => engine.cancel(runId),
    pause: (runId) => engine.pause(runId),
    rewindTo: (runId, stepId) => engine.rewindTo(runId, stepId),
    waitFor,
    shutdown: () => engine.shutdown(),
    definition,
    engine,
    container,
  };
}

/**
 * Hook for waiting on external input (webhooks, approvals, etc.)
 *
 * @example
 * ```typescript
 * const approval = createWorkflow('approval', {
 *   steps: {
 *     request: async (ctx) => {
 *       await sendApprovalRequest(ctx.input.documentId);
 *     },
 *     waitForApproval: async (ctx) => {
 *       // Pauses workflow until resumed with payload
 *       return ctx.wait('Waiting for approval');
 *     },
 *     process: async (ctx) => {
 *       const approval = ctx.getOutput('waitForApproval');
 *       if (approval.approved) {
 *         await processDocument(ctx.input.documentId);
 *       }
 *     },
 *   },
 * });
 *
 * // Resume from webhook handler
 * await approval.resume(runId, { approved: true, approvedBy: 'admin' });
 * ```
 */
export type { StepContext, WorkflowRun };
