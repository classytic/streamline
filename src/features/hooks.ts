/**
 * Hooks & Webhooks — Durable external resume
 *
 * Pause execution and wait for external input (webhooks, approvals, etc.).
 * Durable across process restarts and multi-worker deployments:
 * - Fast path: in-memory hookRegistry (same-process)
 * - Fallback: MongoDB lookup + repository-based resume (cross-process)
 *
 * @example
 * ```typescript
 * const approval = createWorkflow('doc-approval', {
 *   steps: {
 *     request: async (ctx) => {
 *       const hook = createHook(ctx, 'approval');
 *       return ctx.wait(hook.token, { hookToken: hook.token });
 *     },
 *     process: async (ctx) => {
 *       const { approved } = ctx.getOutput<{ approved: boolean }>('request');
 *       if (approved) await publishDoc(ctx.input.docId);
 *     },
 *   },
 * });
 *
 * // Resume from API route — works across workers/restarts
 * const result = await resumeHook(token, { approved: true });
 * ```
 */

import { randomBytes } from 'node:crypto';
import { hookRegistry, workflowRegistry } from '../execution/engine.js';
import { workflowRunRepository } from '../storage/run.repository.js';
import { WorkflowRunModel } from '../storage/run.model.js';
import type { StepContext, WorkflowRun } from '../core/types.js';

export interface HookOptions {
  /** Custom token (default: auto-generated with crypto-random suffix) */
  token?: string;
}

export interface HookResult {
  /** Token to use for resuming (includes secure random component) */
  token: string;
  /** URL path for webhook (if using webhook manager) */
  path: string;
}

/**
 * Create a hook that pauses workflow until external input.
 * The token includes a crypto-random suffix for security.
 *
 * @example
 * ```typescript
 * const hook = createHook(ctx, 'waiting-for-approval');
 * return ctx.wait(hook.token, { hookToken: hook.token });
 * ```
 */
export function createHook(ctx: StepContext, reason: string, options?: HookOptions): HookResult {
  const randomSuffix = randomBytes(16).toString('hex');
  const token = options?.token ?? `${ctx.runId}:${ctx.stepId}:${randomSuffix}`;
  const path = `/hooks/${token}`;

  return { token, path };
}

/**
 * Resume a paused workflow by hook token.
 *
 * **Durable**: Works across process restarts and multi-worker deployments.
 * - Fast path: Uses in-memory hookRegistry if the engine is in this process.
 * - Fallback: Looks up the workflow in MongoDB and resumes via atomic DB operations.
 *
 * Security: Validates the token against the stored hookToken if present.
 *
 * @example
 * ```typescript
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
  const [runId] = token.split(':');

  if (!runId) {
    throw new Error(`Invalid hook token: ${token}`);
  }

  // Fast path: in-memory registry (same process)
  const engine = hookRegistry.getEngine(runId);

  if (engine) {
    return resumeViaEngine(engine, runId, token, payload);
  }

  // Fallback: DB-based resume (cross-process / post-restart)
  return resumeViaDb(runId, token, payload);
}

/** Resume using the in-memory engine reference (fast path) */
async function resumeViaEngine(
  engine: ReturnType<typeof hookRegistry.getEngine> & {},
  runId: string,
  token: string,
  payload: unknown
): Promise<{ runId: string; run: WorkflowRun }> {
  const run = await engine.container.repository.getById(runId);

  if (!run) {
    throw new Error(`Workflow not found for token: ${token}`);
  }

  if (run.status !== 'waiting') {
    throw new Error(`Workflow ${runId} is not waiting (status: ${run.status})`);
  }

  validateHookToken(run as WorkflowRun, token);

  const resumedRun = await engine.resume(runId, payload);
  return { runId: run._id, run: resumedRun as WorkflowRun };
}

/**
 * Resume using direct MongoDB operations (durable fallback).
 * Works when the engine that started the workflow is gone (restart, different worker).
 */
async function resumeViaDb(
  runId: string,
  token: string,
  payload: unknown
): Promise<{ runId: string; run: WorkflowRun }> {
  const run = await workflowRunRepository.getById(runId);

  if (!run) {
    throw new Error(`Workflow not found for token: ${token}`);
  }

  if (run.status !== 'waiting') {
    throw new Error(`Workflow ${runId} is not waiting (status: ${run.status})`);
  }

  validateHookToken(run as WorkflowRun, token);

  // Find the waiting step and mark it done with the payload
  const stepIndex = run.steps.findIndex((s) => s.status === 'waiting');
  if (stepIndex === -1) {
    throw new Error(`No waiting step found in workflow ${runId}`);
  }

  const now = new Date();
  const stepId = run.steps[stepIndex]!.stepId;

  // Atomic claim: only resume if still waiting (prevents concurrent double-resume)
  const result = await workflowRunRepository.updateOne(
    {
      _id: runId,
      status: 'waiting',
      [`steps.${stepIndex}.status`]: 'waiting',
    },
    {
      $set: {
        status: 'running',
        updatedAt: now,
        lastHeartbeat: now,
        [`steps.${stepIndex}.status`]: 'done',
        [`steps.${stepIndex}.endedAt`]: now,
        [`steps.${stepIndex}.output`]: payload,
      },
      $unset: {
        [`steps.${stepIndex}.waitingFor`]: '',
      },
    },
    { bypassTenant: true }
  );

  if (result.modifiedCount === 0) {
    throw new Error(`Failed to resume workflow ${runId} — already resumed or cancelled`);
  }

  // Advance currentStepId to the next step in the sequence.
  // Without this, the workflow is running but stuck at the completed step.
  const allStepIds = run.steps.map((s) => s.stepId);
  const currentIndex = allStepIds.indexOf(stepId);
  const nextStepId = currentIndex < allStepIds.length - 1 ? allStepIds[currentIndex + 1] : null;

  if (nextStepId) {
    await workflowRunRepository.updateOne(
      { _id: runId },
      { $set: { currentStepId: nextStepId, updatedAt: new Date() } },
      { bypassTenant: true }
    );
  } else {
    // No next step — workflow is complete
    await workflowRunRepository.updateOne(
      { _id: runId },
      {
        $set: {
          status: 'done',
          currentStepId: null,
          endedAt: new Date(),
          updatedAt: new Date(),
          output: payload,
        },
      },
      { bypassTenant: true }
    );
  }

  // Try to find an engine to continue execution (best-effort)
  const engine = workflowRegistry.getEngine(run.workflowId);
  if (engine) {
    // Invalidate cache so the engine reads fresh state from DB
    engine.container.cache.delete(runId);

    if (nextStepId) {
      // Engine available — continue execution asynchronously
      setImmediate(() => {
        engine.execute(runId).catch(() => {
          // Execution failed — scheduler will pick it up via stale detection
        });
      });
    }
  } else if (nextStepId) {
    // No engine in this process (true cross-process restart).
    // Set lastHeartbeat to the past so stale recovery picks it up immediately
    // on the next poll cycle instead of waiting for the full stale threshold.
    await workflowRunRepository.updateOne(
      { _id: runId },
      { $set: { lastHeartbeat: new Date(0) } },
      { bypassTenant: true }
    );
  }

  const updated = await workflowRunRepository.getById(runId);
  if (!updated) {
    throw new Error(`Workflow ${runId} disappeared after resume`);
  }

  return { runId, run: updated as WorkflowRun };
}

/** Validate hook token against stored token (security) */
function validateHookToken(run: WorkflowRun, token: string): void {
  const waitingStep = run.steps.find((s) => s.status === 'waiting');
  const waitingData = waitingStep?.waitingFor?.data as { hookToken?: string } | undefined;
  const storedToken = waitingData?.hookToken;

  if (storedToken && storedToken !== token) {
    throw new Error(`Invalid hook token for workflow ${run._id}`);
  }
}

/**
 * Generate a deterministic token for idempotent hooks
 *
 * @example
 * ```typescript
 * const token = hookToken('slack', channelId);
 * const hook = createHook(ctx, 'slack-message', { token });
 * ```
 */
export function hookToken(...parts: string[]): string {
  return parts.join(':');
}
