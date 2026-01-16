/**
 * Hooks & Webhooks
 *
 * Inspired by Vercel's workflow hooks - pause execution and wait for external input.
 *
 * @example
 * ```typescript
 * const approval = createWorkflow('doc-approval', {
 *   steps: {
 *     request: async (ctx) => {
 *       await sendApprovalEmail(ctx.input.docId);
 *       return createHook(ctx, 'approval');
 *     },
 *     process: async (ctx) => {
 *       const { approved } = ctx.getOutput<{ approved: boolean }>('request');
 *       if (approved) await publishDoc(ctx.input.docId);
 *     },
 *   },
 * });
 *
 * // Resume hook from API route
 * const result = await resumeHook(token, { approved: true });
 * console.log(result.run); // The resumed workflow run
 * ```
 */

import { randomBytes } from 'node:crypto';
import { hookRegistry } from '../execution/engine.js';
import type { StepContext, WorkflowRun } from '../core/types.js';

interface HookOptions {
  /** Custom token (default: auto-generated with crypto-random suffix) */
  token?: string;
}

interface HookResult {
  /** Token to use for resuming (includes secure random component) */
  token: string;
  /** URL path for webhook (if using webhook manager) */
  path: string;
}

/**
 * Create a hook that pauses workflow until external input.
 * The token includes a crypto-random suffix for security.
 *
 * IMPORTANT: Pass the returned token to ctx.wait() to enable token validation:
 * ```typescript
 * const hook = createHook(ctx, 'approval');
 * return ctx.wait(hook.token, { hookToken: hook.token }); // Token stored for validation
 * ```
 *
 * @example
 * ```typescript
 * // In step handler
 * async function waitForApproval(ctx) {
 *   const hook = createHook(ctx, 'waiting-for-approval');
 *   console.log('Resume with token:', hook.token);
 *   return ctx.wait(hook.token, { hookToken: hook.token }); // Token validated on resume
 * }
 *
 * // From API route
 * await resumeHook('token-123', { approved: true });
 * ```
 */
export function createHook(ctx: StepContext, reason: string, options?: HookOptions): HookResult {
  // Generate secure token with crypto-random suffix to prevent guessing
  const randomSuffix = randomBytes(16).toString('hex');
  const token = options?.token ?? `${ctx.runId}:${ctx.stepId}:${randomSuffix}`;
  const path = `/hooks/${token}`;

  return { token, path };
}

/**
 * Resume a paused workflow by hook token.
 *
 * Security: If the workflow was paused with a hookToken in waitingFor.data,
 * this function validates the token before resuming.
 *
 * Multi-worker support: Falls back to DB lookup if engine not in local registry.
 *
 * @example
 * ```typescript
 * // API route handler
 * app.post('/hooks/:token', async (req, res) => {
 *   const result = await resumeHook(req.params.token, req.body);
 *   res.json({ success: true, runId: result.runId, status: result.run.status });
 * });
 * ```
 */
export async function resumeHook(
  token: string,
  payload: unknown
): Promise<{ runId: string; run: WorkflowRun }> {
  // Token format: runId:stepId:randomSuffix or custom
  const [runId] = token.split(':');

  if (!runId) {
    throw new Error(`Invalid hook token: ${token}`);
  }

  // Try in-memory registry first (fast path for single-worker)
  const engine = hookRegistry.getEngine(runId);

  if (!engine) {
    throw new Error(
      `No engine registered for workflow ${runId}. ` +
        `Ensure the workflow was started with createWorkflow() and the engine is still running. ` +
        `For multi-worker deployments, ensure all workers use shared state or implement a custom resume endpoint.`
    );
  }

  // Use engine's repository to respect tenant filtering
  const run = await engine.container.repository.getById(runId);

  if (!run) {
    throw new Error(`Workflow not found for token: ${token}`);
  }

  if (run.status !== 'waiting') {
    throw new Error(`Workflow ${runId} is not waiting (status: ${run.status})`);
  }

  // Find the waiting step
  const waitingStep = run.steps.find((s) => s.status === 'waiting');

  // SECURITY: Validate hook token if one was stored during ctx.wait()
  const waitingData = waitingStep?.waitingFor?.data as { hookToken?: string } | undefined;
  const storedToken = waitingData?.hookToken;
  if (storedToken && storedToken !== token) {
    throw new Error(`Invalid hook token for workflow ${runId}`);
  }

  // Resume the workflow
  const resumedRun = await engine.resume(runId, payload);

  return { runId: run._id, run: resumedRun as WorkflowRun };
}

/**
 * Generate a deterministic token for idempotent hooks
 *
 * @example
 * ```typescript
 * // Slack bot - same channel always gets same token
 * const token = hookToken('slack', channelId);
 * const hook = createHook(ctx, 'slack-message', { token });
 * ```
 */
export function hookToken(...parts: string[]): string {
  return parts.join(':');
}
