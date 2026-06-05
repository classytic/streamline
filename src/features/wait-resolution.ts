/**
 * Wait-resolution sentinels.
 *
 * The output a `human` / `webhook` wait step receives when it is resolved
 * WITHOUT a normal external answer:
 *   - `timeout`   — the scheduler's expiry sweep fired (`waitingFor.expiresAt`
 *                   passed). See the scheduler + `getExpiredWaits`.
 *   - `cancelled` — a host withdrew the wait via `cancelHook(token)`.
 *
 * In both cases the waiting step's output is set to this sentinel and the
 * workflow advances normally, so the NEXT step branches on it (auto-reject,
 * escalate, compensate) instead of mistaking it for an approval payload. Use
 * {@link getWaitResolution} in that next step to detect + discriminate.
 *
 * Lives in its own dependency-free module so both the engine (which produces
 * the `timeout` sentinel) and `features/hooks.ts` (which produces `cancelled`)
 * import it without a circular reference.
 */

export type WaitResolutionKind = 'timeout' | 'cancelled';

export interface WaitResolution {
  /** Discriminator: `'timeout'` (deadline reached) or `'cancelled'` (withdrawn). */
  __waitResolved: WaitResolutionKind;
  /** Optional human-readable reason — set by `cancelHook(token, { reason })`. */
  reason?: string;
  /** When the resolution was applied. */
  at: Date;
}

/** Build the sentinel the expiry sweep resumes a timed-out wait with. */
export function makeWaitTimeout(at: Date = new Date()): WaitResolution {
  return { __waitResolved: 'timeout', at };
}

/** Build the sentinel `cancelHook` resumes a withdrawn wait with. */
export function makeWaitCancelled(reason?: string, at: Date = new Date()): WaitResolution {
  return {
    __waitResolved: 'cancelled',
    ...(reason !== undefined ? { reason } : {}),
    at,
  };
}

/**
 * Read a wait-resolution sentinel from a step's output, or `null` when the
 * step resolved normally (a real external payload). Use in the step AFTER a
 * human wait to branch on timeout / cancellation.
 *
 * @example
 * ```typescript
 * decide: async (ctx) => {
 *   const resolution = getWaitResolution(ctx.getOutput('request'));
 *   if (resolution?.__waitResolved === 'timeout') return autoReject(ctx);
 *   if (resolution?.__waitResolved === 'cancelled') return onWithdrawn(ctx, resolution.reason);
 *   const { approved } = ctx.getOutput<{ approved: boolean }>('request') ?? {};
 *   // …normal approval handling…
 * }
 * ```
 */
export function getWaitResolution(output: unknown): WaitResolution | null {
  if (!output || typeof output !== 'object') return null;
  const kind = (output as { __waitResolved?: unknown }).__waitResolved;
  return kind === 'timeout' || kind === 'cancelled' ? (output as WaitResolution) : null;
}
