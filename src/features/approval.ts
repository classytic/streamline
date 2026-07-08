/**
 * Approval flow — a typed, durable human-decision primitive.
 *
 * Every durable-workflow host hand-rolls the same "pause → wait for a human
 * approve/reject with a deadline → branch on the outcome" dance on top of the
 * raw hook + wait-resolution machinery. This module packages it into ONE
 * cohesive, fully-typed primitive that discriminates all FOUR real outcomes an
 * approval can have — `approved`, `rejected`, `withdrawn`, `timed_out` — where
 * flow-tools like n8n collapse everything into "resumed / not resumed".
 *
 * It is PURE composition over {@link createHook} / `ctx.wait` / {@link resumeHook}
 * / {@link getWaitResolution} — no engine or storage changes, so it inherits
 * their durability (cross-restart, multi-worker, fail-closed token validation)
 * for free.
 *
 * ## Shape (spans a step boundary, like every durable wait)
 *
 * ```typescript
 * const review = createWorkflow('doc-review', {
 *   steps: {
 *     // 1. Gate step: park the run, hand the token to your entity so an
 *     //    approver UI can find it.
 *     request: (ctx) =>
 *       requestApproval(ctx, {
 *         reason: 'Publish this doc?',
 *         metadata: { allowedReviewers: ['u_42'] },
 *         expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
 *         onToken: (token) => db.docs.update(ctx.context.docId, { reviewToken: token }),
 *       }),
 *     // 2. Next step: read the outcome. Exactly one branch fires.
 *     act: async (ctx) => {
 *       const decision = readApprovalDecision(ctx.outputs.request);
 *       switch (decision?.status) {
 *         case 'approved':  return publish(ctx.context.docId, decision.data);
 *         case 'rejected':  return archive(ctx.context.docId, decision.reason);
 *         case 'withdrawn': return noop();              // request superseded/deleted
 *         case 'timed_out': return escalate(ctx.context.docId); // nobody answered
 *       }
 *     },
 *   },
 * });
 *
 * // Resume side (API routes), durable across workers/restarts:
 * await approve(token, { note: 'LGTM' }); // → decision.status === 'approved'
 * await reject(token, 'off-brand');       // → decision.status === 'rejected'
 * await cancelHook(token, { reason: 'source deleted' }); // → 'withdrawn'
 * // …or nobody answers by expiresAt → 'timed_out' (scheduler expiry sweep)
 * ```
 */

import type { StepContext } from '../core/types.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import { createHook, resumeHook } from './hooks.js';
import { getWaitResolution } from './wait-resolution.js';

/**
 * Marker key stamped on the resume payload so {@link readApprovalDecision} can
 * distinguish a human `approve` from a human `reject` (both are normal wait
 * resumes, NOT the timeout/cancel sentinels). Namespaced to avoid colliding
 * with a host's own approval payload fields.
 */
const APPROVAL_MARKER = '__approvalDecision';

interface ApprovalPayload {
  [APPROVAL_MARKER]: 'approved' | 'rejected';
  reason?: string;
  data?: unknown;
}

/** Options for {@link requestApproval}. */
export interface RequestApprovalOptions {
  /** Human-readable prompt shown to the approver / stored on the waiting step. */
  reason: string;
  /**
   * Opaque host metadata (e.g. `{ allowedReviewers }`) surfaced by
   * `getHookByToken` / `listPendingHooks` for pre-resume authorization without
   * resuming. Forwarded onto the waiting step.
   */
  metadata?: unknown;
  /**
   * Deadline. If nobody answers by then, the scheduler's expiry sweep resolves
   * the wait to `{ status: 'timed_out' }`. Omit to park indefinitely.
   */
  expiresAt?: Date;
  /**
   * Persist the resume token — awaited BEFORE the wait parks — so an approver UI
   * (or your `approve`/`reject` call site) can find the pending request. Stash
   * it on the entity under review.
   */
  onToken?: (token: string) => void | Promise<void>;
  /** Reuse a specific token for an idempotent request (default: crypto-random). */
  token?: string;
}

/**
 * Gate step primitive: mint an approval hook, hand its token to `onToken`, then
 * park the run until someone {@link approve}s / {@link reject}s / withdraws
 * (`cancelHook`) it, or it expires. `return requestApproval(ctx, …)` from the
 * gate step; read the outcome in the NEXT step with {@link readApprovalDecision}.
 *
 * Like every durable wait, this throws a `WaitSignal` (typed `Promise<never>`) —
 * control resumes the workflow at the following step once the decision lands.
 */
export async function requestApproval<TContext, TOutputs>(
  ctx: StepContext<TContext, TOutputs>,
  opts: RequestApprovalOptions,
): Promise<never> {
  return parkOnHook(ctx, opts.reason, opts);
}

/**
 * Shared plumbing for the human-in-the-loop primitives: mint a hook, hand the
 * token to `onToken`, then park the run on a `human` wait carrying the token +
 * metadata + deadline. Both {@link requestApproval} and {@link ask} are thin
 * semantic wrappers over this.
 */
async function parkOnHook<TContext, TOutputs>(
  ctx: StepContext<TContext, TOutputs>,
  reason: string,
  opts: {
    metadata?: unknown;
    expiresAt?: Date;
    onToken?: (token: string) => void | Promise<void>;
    token?: string;
  },
): Promise<never> {
  const hook = createHook(ctx, reason, {
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });

  if (opts.onToken) await opts.onToken(hook.token);

  return ctx.wait(hook.reason, {
    hookToken: hook.token,
    ...(hook.metadata !== undefined ? { metadata: hook.metadata } : {}),
    ...(hook.expiresAt !== undefined ? { expiresAt: hook.expiresAt } : {}),
  });
}

/** Resume-side option bag shared by {@link approve} / {@link reject}. */
export interface ApprovalResumeOptions {
  /** Repository for the DB-fallback resume (multi-tenant / custom container). See {@link resumeHook}. */
  repository?: WorkflowRunRepository;
}

/**
 * Approve a pending request (resume side). Durable across workers/restarts and
 * token-validated exactly like {@link resumeHook}. Optional `data` is surfaced
 * to the next step as `decision.data`. → next step sees `status: 'approved'`.
 */
export function approve(
  token: string,
  data?: unknown,
  options?: ApprovalResumeOptions,
): ReturnType<typeof resumeHook> {
  const payload: ApprovalPayload = {
    [APPROVAL_MARKER]: 'approved',
    ...(data !== undefined ? { data } : {}),
  };
  return resumeHook(token, payload, options);
}

/**
 * Reject a pending request (resume side) — a real human "no", DISTINCT from a
 * withdrawal (`cancelHook`, which means "the request no longer applies"). →
 * next step sees `status: 'rejected'` with the optional `reason`.
 */
export function reject(
  token: string,
  reason?: string,
  options?: ApprovalResumeOptions,
): ReturnType<typeof resumeHook> {
  const payload: ApprovalPayload = {
    [APPROVAL_MARKER]: 'rejected',
    ...(reason !== undefined ? { reason } : {}),
  };
  return resumeHook(token, payload, options);
}

/** The four terminal outcomes of an approval request. */
export type ApprovalDecision =
  | { status: 'approved'; data?: unknown }
  | { status: 'rejected'; reason?: string }
  | { status: 'withdrawn'; reason?: string }
  | { status: 'timed_out' };

/**
 * Read a gate step's output into a typed {@link ApprovalDecision}, or `null`
 * when the output isn't an approval resolution (an unrelated step, or the gate
 * hasn't resolved). Call it in the step AFTER {@link requestApproval}, passing
 * that step's output (`ctx.outputs.<gate>` or `ctx.getOutput('<gate>')`).
 *
 * Maps: the `timeout` wait-sentinel → `timed_out`, the `cancelled` sentinel →
 * `withdrawn`, an {@link approve} payload → `approved`, a {@link reject} payload
 * → `rejected`.
 */
export function readApprovalDecision(output: unknown): ApprovalDecision | null {
  const resolution = getWaitResolution(output);
  if (resolution?.__waitResolved === 'timeout') {
    return { status: 'timed_out' };
  }
  if (resolution?.__waitResolved === 'cancelled') {
    return {
      status: 'withdrawn',
      ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
    };
  }

  if (output && typeof output === 'object' && APPROVAL_MARKER in output) {
    const payload = output as ApprovalPayload;
    if (payload[APPROVAL_MARKER] === 'approved') {
      return { status: 'approved', ...(payload.data !== undefined ? { data: payload.data } : {}) };
    }
    if (payload[APPROVAL_MARKER] === 'rejected') {
      return {
        status: 'rejected',
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      };
    }
  }

  return null;
}

// ============================================================================
// ASK — arbitrary human input mid-flow (OTP, captcha, a chosen value)
//
// Approval is a yes/no gate; `ask` is its generalization for when the workflow
// needs a VALUE from a human before it can continue — an OTP typed into a
// background browser automation, a captcha solution, a shipping choice. Same
// durable hook machinery; the resume carries a typed answer instead of a
// boolean.
//
// ## Durable interactive loop (agent needs an OTP each turn)
//
// A step that `ask`s parks the run; the answer becomes that step's output; the
// next step consumes it and — for an UNBOUNDED number of turns — loops back with
// `ctx.goto()`. Each turn is durable: the process can restart between the
// question and the answer and resume exactly where it paused.
//
// ```typescript
// const automation = createWorkflow('browser-login', {
//   steps: {
//     askOtp: (ctx) =>
//       ask(ctx, {
//         question: 'Enter the OTP sent to your phone',
//         expiresAt: new Date(Date.now() + 5 * 60_000),
//         onToken: (token) => notifyUser(ctx.context.sessionId, token),
//       }),
//     useOtp: async (ctx) => {
//       const answer = readAnswer<string>(ctx.outputs.askOtp);
//       if (answer?.status === 'timed_out') return abandon(ctx.context.sessionId);
//       if (answer?.status === 'withdrawn') return abandon(ctx.context.sessionId);
//       const stillNeedsOtp = await driveBrowser(ctx.context.sessionId, answer?.value);
//       if (stillNeedsOtp) return ctx.goto('askOtp'); // ← loop: ask the next OTP, durably
//       return { loggedIn: true };
//     },
//   },
// });
//
// // Resume side, when the user provides the code:
// await answer(token, '481920');
// ```
// ============================================================================

/** Marker key stamped on an {@link answer} payload — see {@link APPROVAL_MARKER}. */
const ANSWER_MARKER = '__askAnswer';

interface AnswerPayload {
  [ANSWER_MARKER]: unknown;
}

/** Options for {@link ask}. Mirrors {@link RequestApprovalOptions} with a `question`. */
export interface AskOptions {
  /** The prompt shown to the human / stored on the waiting step. */
  question: string;
  /** Opaque host metadata for authz / rendering (see {@link RequestApprovalOptions.metadata}). */
  metadata?: unknown;
  /** Deadline → `{ status: 'timed_out' }` if unanswered. Omit to park indefinitely. */
  expiresAt?: Date;
  /** Persist the resume token (awaited before parking) so the answer site can find it. */
  onToken?: (token: string) => void | Promise<void>;
  /** Reuse a specific token for an idempotent question. */
  token?: string;
}

/**
 * Gate step primitive: park the run until a human supplies a VALUE (OTP,
 * captcha, choice) via {@link answer} — or the request is withdrawn
 * (`cancelHook`) or expires. `return ask(ctx, …)` from the step; read the value
 * in the NEXT step with {@link readAnswer}. Loop turns with `ctx.goto()` (see
 * the module example).
 */
export async function ask<TContext, TOutputs>(
  ctx: StepContext<TContext, TOutputs>,
  opts: AskOptions,
): Promise<never> {
  return parkOnHook(ctx, opts.question, opts);
}

/**
 * Supply the answer to a pending {@link ask} (resume side). Durable + token
 * validated like {@link resumeHook}. → next step sees `{ status: 'answered', value }`.
 */
export function answer(
  token: string,
  value: unknown,
  options?: ApprovalResumeOptions,
): ReturnType<typeof resumeHook> {
  const payload: AnswerPayload = { [ANSWER_MARKER]: value };
  return resumeHook(token, payload, options);
}

/** Outcome of an {@link ask}. */
export type AnswerResult<T> =
  | { status: 'answered'; value: T }
  | { status: 'withdrawn'; reason?: string }
  | { status: 'timed_out' };

/**
 * Read a gate step's output into a typed {@link AnswerResult}, or `null` when
 * the output isn't an ask resolution. Call it in the step AFTER {@link ask}.
 * Maps: `timeout` sentinel → `timed_out`, `cancelled` sentinel → `withdrawn`,
 * an {@link answer} payload → `answered` with the typed `value`.
 */
export function readAnswer<T = unknown>(output: unknown): AnswerResult<T> | null {
  const resolution = getWaitResolution(output);
  if (resolution?.__waitResolved === 'timeout') {
    return { status: 'timed_out' };
  }
  if (resolution?.__waitResolved === 'cancelled') {
    return {
      status: 'withdrawn',
      ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
    };
  }

  if (output && typeof output === 'object' && ANSWER_MARKER in output) {
    return { status: 'answered', value: (output as AnswerPayload)[ANSWER_MARKER] as T };
  }

  return null;
}
