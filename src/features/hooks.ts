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
import type { StepContext, WorkflowRun } from '../core/types.js';
import { hookRegistry, workflowRegistry } from '../execution/engine.js';
import { workflowRunRepository } from '../storage/run.repository.js';
import { makeWaitCancelled } from './wait-resolution.js';

export interface HookOptions {
  /** Custom token (default: auto-generated with crypto-random suffix) */
  token?: string;
  /**
   * Opaque host metadata carried alongside the wait — surfaced by
   * `getHookByToken` / `listPendingHooks` so an approval UI or an
   * authorization check can read it WITHOUT resuming. Common uses:
   * `{ allowedReviewers: [...] }` for authz, or `{ title, dueAt }` for a
   * review card. Pass it through to `ctx.wait` (see the example) so it
   * lands on the waiting step.
   */
  metadata?: unknown;
  /**
   * Deadline for the wait. If no one resumes by `expiresAt`, the scheduler
   * auto-resumes the step with a timeout sentinel (`getWaitResolution(...)
   * === { __waitResolved: 'timeout' }`) so an unanswered approval can't park
   * a long-running workflow forever. Forward it to `ctx.wait` (see the
   * example). Omit for a wait that parks indefinitely (the default).
   */
  expiresAt?: Date;
}

export interface HookResult {
  /** Token to use for resuming (includes secure random component) */
  token: string;
  /** URL path for webhook (if using webhook manager) */
  path: string;
  /** Human-readable reason — echo into `ctx.wait` so it lands on the waiting step. */
  reason: string;
  /** Host metadata from {@link HookOptions.metadata} — echo into `ctx.wait`. */
  metadata?: unknown;
  /** Deadline from {@link HookOptions.expiresAt} — echo into `ctx.wait`. */
  expiresAt?: Date;
}

/**
 * A pending hook — a run parked on a human wait, awaiting external resume.
 * Returned by {@link getHookByToken} / {@link listPendingHooks} for
 * approval dashboards and pre-resume authorization, WITHOUT mutating the run.
 */
export interface PendingHook {
  /** The resume token (what you pass to {@link resumeHook}). */
  token: string;
  runId: string;
  workflowId: string;
  /** The waiting step's id. */
  stepId: string;
  /** Human-readable reason passed to `ctx.wait(reason, …)`. */
  reason: string;
  /** Host metadata attached via {@link HookOptions.metadata}. */
  metadata?: unknown;
  /** When the run entered the wait (waiting step's `startedAt`, else `updatedAt`). */
  waitingSince?: Date;
}

/**
 * Create a hook that pauses workflow until external input.
 * The token includes a crypto-random suffix for security.
 *
 * **You MUST pass `{ hookToken: hook.token }` to `ctx.wait`.** `resumeHook`
 * fails closed if no stored token is found on the waiting step — pre-fix
 * (≤ v2.2) the validator silently accepted any token whose runId-prefix
 * matched, so a forgotten `hookToken` was a security hole, not just a
 * style nit.
 *
 * `reason` (and any `metadata`) are echoed back on the result so you can
 * forward them to `ctx.wait` in one place — that's what makes them visible
 * to `getHookByToken` / `listPendingHooks` for approval UIs + authz.
 *
 * @example
 * ```typescript
 * const hook = createHook(ctx, 'manager approval', {
 *   metadata: { allowedReviewers: ['u_42'] },
 *   expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // auto-reject after 24h
 * });
 * // Forward reason + token + metadata + deadline onto the waiting step:
 * return ctx.wait(hook.reason, {
 *   hookToken: hook.token,
 *   metadata: hook.metadata,
 *   expiresAt: hook.expiresAt,
 * });
 * ```
 */
export function createHook(ctx: StepContext, reason: string, options?: HookOptions): HookResult {
  const randomSuffix = randomBytes(16).toString('hex');
  const token = options?.token ?? `${ctx.runId}:${ctx.stepId}:${randomSuffix}`;
  const path = `/hooks/${token}`;

  return {
    token,
    path,
    reason,
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(options?.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  };
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
  payload: unknown,
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

/**
 * Cancel (withdraw) a pending hook — the approval is no longer wanted
 * (superseded, escalated, the underlying request was deleted). Resumes the
 * waiting step with a cancellation sentinel and lets the workflow proceed down
 * its handled-cancellation path; the NEXT step detects it via
 * `getWaitResolution(...) === { __waitResolved: 'cancelled', reason }`.
 *
 * This withdraws THE WAIT, not the whole run — to abort the entire workflow,
 * call `engine.cancel(runId)` / `wf.cancel(runId)` instead.
 *
 * Token-validated and fail-closed exactly like {@link resumeHook} (it IS a
 * `resumeHook` with a cancel-sentinel payload). Throws if the hook is no
 * longer pending (already resumed/cancelled, or the run isn't waiting).
 *
 * @example
 * ```typescript
 * await cancelHook(token, { reason: 'request was deleted' });
 * ```
 */
export async function cancelHook(
  token: string,
  options?: { reason?: string },
): Promise<{ runId: string; run: WorkflowRun }> {
  return resumeHook(token, makeWaitCancelled(options?.reason));
}

/** Resume using the in-memory engine reference (fast path) */
async function resumeViaEngine(
  engine: ReturnType<typeof hookRegistry.getEngine> & {},
  runId: string,
  token: string,
  payload: unknown,
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
  payload: unknown,
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
  const stepId = run.steps[stepIndex]?.stepId;

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
    { bypassTenant: true },
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
      { bypassTenant: true },
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
      { bypassTenant: true },
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
      { bypassTenant: true },
    );
  }

  const updated = await workflowRunRepository.getById(runId);
  if (!updated) {
    throw new Error(`Workflow ${runId} disappeared after resume`);
  }

  return { runId, run: updated as WorkflowRun };
}

// ============================================================================
// Read-only inspection — surface pending hooks for approval UIs + authz
// WITHOUT resuming. These NEVER mutate the run (resuming is resumeHook).
// ============================================================================

/**
 * Build a {@link PendingHook} from a run and its waiting step. When `token`
 * is given, only the step that stored THAT exact token matches (fail-closed,
 * mirrors `validateHookToken`); otherwise the first human wait carrying a
 * `hookToken` is used.
 */
function toPendingHook(run: WorkflowRun, token?: string): PendingHook | null {
  const step = run.steps.find((s) => {
    if (s.status !== 'waiting' || !s.waitingFor) return false;
    const data = s.waitingFor.data as { hookToken?: string } | undefined;
    return token ? data?.hookToken === token : s.waitingFor.type === 'human' && !!data?.hookToken;
  });
  if (!step?.waitingFor) return null;

  const data = step.waitingFor.data as { hookToken?: string; metadata?: unknown } | undefined;
  if (!data?.hookToken) return null;

  return {
    token: data.hookToken,
    runId: run._id,
    workflowId: run.workflowId,
    stepId: step.stepId,
    reason: step.waitingFor.reason,
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
    waitingSince: step.startedAt ?? run.updatedAt,
  };
}

/**
 * Inspect a pending hook by token WITHOUT resuming it — for a pre-resume
 * authorization check or to render an approval card.
 *
 * Returns `null` unless the token matches a run currently waiting on exactly
 * that hook (run missing, not waiting, already resumed, or token mismatch all
 * return `null`). Mirrors `resumeHook`'s fail-closed token check: only the
 * step that stored THIS exact token is returned, so a guessed `<runId>:…`
 * token reveals nothing.
 *
 * @example
 * ```typescript
 * const hook = await getHookByToken(token);
 * if (!hook) return res.status(404).end();
 * const reviewers = (hook.metadata as { allowedReviewers?: string[] })?.allowedReviewers;
 * if (reviewers && !reviewers.includes(req.user.id)) return res.status(403).end();
 * await resumeHook(token, req.body);
 * ```
 */
export async function getHookByToken(token: string): Promise<PendingHook | null> {
  const [runId] = token.split(':');
  if (!runId) return null;

  const run = await workflowRunRepository.getById(runId);
  if (!run || run.status !== 'waiting') return null;

  return toPendingHook(run as WorkflowRun, token);
}

/**
 * List runs currently parked on a human wait — the "pending approvals" queue
 * for an operator dashboard. Read-only. Each entry carries the resume `token`,
 * `reason`, and host `metadata` so a UI can render + route the approval
 * without a second fetch. Oldest wait first (longest-waiting surfaces first).
 *
 * Uses the default repository singleton (single-tenant / cross-process, same
 * as `resumeHook`'s durable path). Multi-tenant hosts should scope the query
 * through their container's repository instead:
 * `container.repository.getWaitingRuns('human', limit, { tenantId })`.
 *
 * @example
 * ```typescript
 * const pending = await listPendingHooks({ workflowId: 'doc-approval' });
 * // [{ token, runId, stepId, reason: 'manager approval', metadata, waitingSince }]
 * ```
 */
export async function listPendingHooks(options?: {
  workflowId?: string;
  limit?: number;
}): Promise<PendingHook[]> {
  const runs = await workflowRunRepository.getWaitingRuns('human', options?.limit ?? 100, {
    ...(options?.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
  });

  const hooks: PendingHook[] = [];
  for (const run of runs) {
    const hook = toPendingHook(run as WorkflowRun);
    if (hook) hooks.push(hook);
  }
  return hooks;
}

/**
 * Validate hook token against stored token (security).
 *
 * **Fail-closed.** Pre-fix this validator silently accepted ANY token whose
 * runId-prefix matched a waiting workflow if the step didn't store
 * `waitingFor.data.hookToken`. The README example was the canonical
 * misuse case (`ctx.wait('Awaiting approval')` without `{ hookToken }`),
 * which let an attacker who guessed `<runId>:anything` resume the
 * workflow.
 *
 * Now: a missing stored token is itself a rejection. The only way to
 * resume is to have stored the exact token via
 * `ctx.wait(reason, { hookToken: hook.token })` — which is what
 * `createHook`'s docstring + the canonical README example now enforce.
 *
 * Migration: workflows using `createHook` MUST pass `hookToken` to
 * `ctx.wait`. Workflows that need a no-token resume path (admin override,
 * trusted in-process resume) should use `engine.resume(runId, payload)`
 * directly — that's the unauthenticated entry point by design.
 */
function validateHookToken(run: WorkflowRun, token: string): void {
  const waitingStep = run.steps.find((s) => s.status === 'waiting');
  const waitingData = waitingStep?.waitingFor?.data as { hookToken?: string } | undefined;
  const storedToken = waitingData?.hookToken;

  if (!storedToken) {
    throw new Error(
      `Hook resume rejected for workflow ${run._id} — no stored hookToken. ` +
        `Pass { hookToken: hook.token } to ctx.wait() so the validator can check it. ` +
        `See https://github.com/classytic/streamline#webhooks for the canonical pattern.`,
    );
  }
  if (storedToken !== token) {
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
