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
import type { WorkflowDefinition, StepHandler, WorkflowRun, StepContext } from '../core/types.js';
import { validateId, validateRetryConfig } from '../utils/validation.js';

// camelCase/kebab-case -> Title Case
const toName = (id: string) =>
  id
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());

interface WorkflowConfig<TContext, TInput = unknown> {
  steps: Record<string, StepHandler<unknown, TContext>>;
  context?: (input: TInput) => TContext;
  version?: string;
  defaults?: { retries?: number; timeout?: number };
  autoExecute?: boolean;
  /** Optional custom container for dependency injection */
  container?: StreamlineContainer;
}

interface Workflow<TContext, TInput = unknown> {
  start: (input: TInput, meta?: Record<string, unknown>) => Promise<WorkflowRun<TContext>>;
  get: (runId: string) => Promise<WorkflowRun<TContext> | null>;
  execute: (runId: string) => Promise<WorkflowRun<TContext>>;
  resume: (runId: string, payload?: unknown) => Promise<WorkflowRun<TContext>>;
  cancel: (runId: string) => Promise<WorkflowRun<TContext>>;
  pause: (runId: string) => Promise<WorkflowRun<TContext>>;
  rewindTo: (runId: string, stepId: string) => Promise<WorkflowRun<TContext>>;
  shutdown: () => void;
  definition: WorkflowDefinition<TContext>;
  engine: WorkflowEngine<TContext>;
  /** The container used by this workflow (for testing or custom integrations) */
  container: StreamlineContainer;
}

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
 * @example Custom container for testing
 * ```typescript
 * const container = createContainer();
 * const workflow = createWorkflow('test-workflow', {
 *   steps: { ... },
 *   container
 * });
 * ```
 */
export function createWorkflow<TContext = Record<string, unknown>, TInput = unknown>(
  id: string,
  config: WorkflowConfig<TContext, TInput>
): Workflow<TContext, TInput> {
  // Basic validation (full validation happens in WorkflowRegistry)
  validateId(id, 'workflow');

  const stepIds = Object.keys(config.steps);
  if (stepIds.length === 0) {
    throw new Error('Workflow must have at least one step');
  }

  // Validate defaults early for better error messages
  if (config.defaults) {
    validateRetryConfig(config.defaults.retries, config.defaults.timeout);
  }

  const definition: WorkflowDefinition<TContext> = {
    id,
    name: toName(id),
    version: config.version ?? '1.0.0',
    steps: stepIds.map((stepId) => ({ id: stepId, name: toName(stepId) })),
    createContext: (config.context ?? ((input) => input)) as (input: unknown) => TContext,
    defaults: config.defaults,
  };

  // Use provided container or create a new one
  const container = config.container ?? createContainer();

  // WorkflowEngine -> WorkflowRegistry will do full validation
  const engine = new WorkflowEngine(definition, config.steps, container, {
    ...(config.autoExecute !== undefined && { autoExecute: config.autoExecute }),
  });

  return {
    start: (input, meta) => engine.start(input, meta),
    get: (runId) => engine.get(runId),
    execute: (runId) => engine.execute(runId),
    resume: (runId, payload) => engine.resume(runId, payload),
    cancel: (runId) => engine.cancel(runId),
    pause: (runId) => engine.pause(runId),
    rewindTo: (runId, stepId) => engine.rewindTo(runId, stepId),
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
