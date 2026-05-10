/**
 * Retention — TTL indexes, multi-tenant compounds, and stale-run sweeper.
 *
 * Closes three operational gaps the host previously had to remember:
 *
 * 1. **TTL on terminal runs** — without a TTL, `workflow_runs` grows
 *    forever. Hosts had to know the internal model name and call
 *    `WorkflowRunModel.collection.createIndex(...)` after mongoose
 *    connects. This module owns the index spec; the container exposes
 *    `syncRetentionIndexes()` which is idempotent on reconnect.
 *
 * 2. **Tenant-prefixed compound** — multi-tenant deployments need
 *    `{ <tenantField>: 1, workflowId: 1, createdAt: -1 }` so org-scoped
 *    list queries hit a covering index instead of fanning out across
 *    every tenant. Built automatically when the repository was
 *    constructed with `multiTenant.tenantField`. PACKAGE_RULES §33
 *    (scope-field prefix on compound indexes) made literal.
 *
 * 3. **Stale-run sweep** — the scheduler ships stale-recovery (re-exec
 *    from the last heartbeat) but no terminator. Workers that crash and
 *    never come back leave runs stuck in `running` forever, blocking
 *    concurrency slots. The sweeper periodically marks stale runs
 *    `failed` (or `cancelled`) via the repository's atomic
 *    `markStaleAsFailed()` CAS, emits `workflow:failed`, and the
 *    scheduler can finally move on.
 *
 * Design follows PACKAGE_RULES §32 — `syncRetentionIndexes()` is an
 * explicit deploy-time call, NOT auto-run on container construction.
 * The sweeper, by contrast, IS auto-started by `createContainer` when
 * `retention.staleHeartbeatThresholdMs` is set — the host opted in by
 * configuring it, and the timer is `unref()`'d so it can never block
 * process exit.
 */

import type { IndexSpecification } from 'mongodb';
import type { Collection } from 'mongoose';
import type { WorkflowEventBus } from '../core/events.js';
import { toError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { WorkflowRunModel } from './run.model.js';
import type { WorkflowRunRepository } from './run.repository.js';

// ============================================================================
// Public options
// ============================================================================

export interface RetentionOptions {
  /**
   * TTL on terminal runs (`done` / `failed` / `cancelled`). Mongo's TTL
   * monitor purges expired docs every ~60s. Pass `0` or omit to disable.
   *
   * Index shape: `{ endedAt: 1 }` with
   * `partialFilterExpression: { endedAt: { $exists: true }, status: { $in: [...] } }`.
   *
   * Filtering on `endedAt: { $exists: true }` matters — a fresh `running`
   * run has no `endedAt`, so MongoDB skips it for the partial index entirely
   * (no index entry, no TTL eligibility). The TTL monitor only sees runs
   * the engine has actually terminated.
   *
   * @example 30-day retention
   * ```ts
   * createContainer({ retention: { terminalRunsTtlSeconds: 30 * 24 * 60 * 60 } });
   * ```
   */
  terminalRunsTtlSeconds?: number;

  /**
   * Build the tenant-prefixed compound index when the repository was
   * constructed with `multiTenant.tenantField`. Index shape:
   * `{ <tenantField>: 1, workflowId: 1, createdAt: -1 }` — covers the
   * canonical "list this org's recent runs of workflow X" query without
   * a cross-tenant scan.
   *
   * @default `true` when the repository is multi-tenant; `false` otherwise.
   */
  multiTenantIndexes?: boolean;

  /**
   * Threshold in ms above which a `running` run with no recent heartbeat
   * is considered crashed. The sweeper terminates these via the repo's
   * atomic CAS (`markStaleAsFailed`). Setting this enables the sweeper
   * loop; omitting it leaves only the engine's recover-and-retry path
   * (which never gives up).
   *
   * Pick this WELL ABOVE the engine's heartbeat interval and above any
   * step's max execution time, otherwise a healthy long step gets
   * terminated. A sensible floor is `5 * heartbeatIntervalMs`. The
   * default if you enable the sweeper without a value: 30 min.
   */
  staleHeartbeatThresholdMs?: number;

  /**
   * How often the sweep runs. Defaults to 60_000 (1 min) — matches Mongo's
   * TTL monitor cadence. Smaller is wasteful (the sweep is a cross-tenant
   * scan), larger is fine for less time-sensitive deployments.
   *
   * Only consulted when `staleHeartbeatThresholdMs` is set.
   */
  staleRunSweepIntervalMs?: number;

  /**
   * Terminal status for stale runs.
   * - `'fail'` — `status: 'failed'`. Default. Compensation handlers run, retry
   *   policy applies on the host side, and `workflow:failed` is emitted.
   * - `'cancel'` — `status: 'cancelled'`. Use when the host wants the run to
   *   be ignored entirely (no retry, no compensation, no failure metric).
   *
   * @default 'fail'
   */
  staleRunAction?: 'fail' | 'cancel';

  /**
   * Max runs swept per sweep cycle. Bounds the per-cycle Mongo round-trips
   * so a multi-thousand-run pile-up doesn't flood the cluster.
   *
   * @default 100
   */
  staleRunBatchSize?: number;

  /**
   * Cap on how many times the stale path (engine `recoverStale` +
   * sweeper `markStaleAsFailed`) may touch a single run before it's
   * dead-lettered. A run that crashes-recovers-crashes-recovers… in a
   * loop without making progress is wedged for a real reason; the
   * sweeper marks it permanently failed (`error.code === 'dead_lettered'`)
   * so the scheduler can move on instead of cycling forever.
   *
   * The counter increments on every recovery / sweep, so the limit
   * applies across BOTH paths together — set it high enough to absorb
   * normal transient failures (3–10 is typical) and the sweep window is
   * tight enough that a "real" failure trips it within a few minutes.
   *
   * @default 5
   */
  maxStaleRecoveries?: number;
}

// ============================================================================
// Index sync
// ============================================================================

const TERMINAL_RUNS_TTL_INDEX_NAME = 'streamline_terminal_runs_ttl';
const TENANT_WORKFLOW_RECENT_INDEX_NAME = 'streamline_tenant_workflow_recent';

/**
 * Idempotently build the retention indexes on `workflow_runs`.
 *
 * Safe to call repeatedly — already-built indexes are no-ops, and a
 * `terminalRunsTtlSeconds` change between calls drops + recreates the
 * TTL index (Mongo refuses to mutate `expireAfterSeconds` in place via
 * `createIndex`).
 *
 * Must be called AFTER `mongoose.connect(...)`. The container method of
 * the same name resolves the underlying `WorkflowRunModel` for the
 * caller; this lower-level export is for hosts that want to call it
 * directly from a deploy script (PACKAGE_RULES §32).
 */
export async function syncRetentionIndexes(
  repository: WorkflowRunRepository,
  options: RetentionOptions,
): Promise<void> {
  const collection = WorkflowRunModel.collection;

  if (options.terminalRunsTtlSeconds && options.terminalRunsTtlSeconds > 0) {
    await ensureIndex(
      collection,
      { endedAt: 1 },
      {
        name: TERMINAL_RUNS_TTL_INDEX_NAME,
        expireAfterSeconds: options.terminalRunsTtlSeconds,
        partialFilterExpression: {
          endedAt: { $exists: true },
          status: { $in: ['done', 'failed', 'cancelled'] },
        },
      },
    );
  }

  const wantsTenantIndex = repository.isMultiTenant && options.multiTenantIndexes !== false;
  if (wantsTenantIndex) {
    const tenantField = repository.tenantField;
    await ensureIndex(
      collection,
      { [tenantField]: 1, workflowId: 1, createdAt: -1 },
      { name: TENANT_WORKFLOW_RECENT_INDEX_NAME },
    );
  }
}

interface EnsureIndexOptions {
  name: string;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

/**
 * `createIndex` with conflict recovery — Mongo throws `IndexOptionsConflict`
 * (code 85) or `IndexKeySpecsConflict` (code 86) when the spec drifts from
 * what's already on disk (e.g., the host bumped `terminalRunsTtlSeconds`).
 * Drop + recreate is the documented remediation; idempotent on repeated
 * calls thereafter.
 */
async function ensureIndex(
  collection: Collection,
  spec: IndexSpecification,
  options: EnsureIndexOptions,
): Promise<void> {
  try {
    await collection.createIndex(spec, options);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 85 || code === 86) {
      try {
        await collection.dropIndex(options.name);
      } catch {
        // Index may not exist by that name — fall through to recreate.
      }
      await collection.createIndex(spec, options);
      return;
    }
    throw err;
  }
}

// ============================================================================
// Stale-run sweeper
// ============================================================================

/**
 * Resolved sweeper config — every option non-optional after `createContainer`
 * has applied defaults.
 */
interface SweeperConfig {
  staleHeartbeatThresholdMs: number;
  staleRunSweepIntervalMs: number;
  staleRunAction: 'fail' | 'cancel';
  staleRunBatchSize: number;
  maxStaleRecoveries: number;
}

/**
 * Periodic sweep that terminates stale `running` runs the engine never
 * recovered. Runs as a self-rescheduling `setTimeout` (not `setInterval`)
 * so a slow sweep can't pile up overlapping invocations.
 */
export class StaleRunSweeper {
  private timer?: NodeJS.Timeout;
  private active = false;
  /** Re-entrancy guard — sweeps don't overlap even on manual `sweepOnce()`. */
  private inFlight = false;

  constructor(
    private readonly repository: WorkflowRunRepository,
    private readonly config: SweeperConfig,
    private readonly eventBus?: WorkflowEventBus,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.scheduleNext();
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Run one sweep cycle. Exposed so deploy scripts and tests can trigger
   * a sweep on demand without waiting for the next interval.
   */
  async sweepOnce(): Promise<{ swept: number; errors: number }> {
    if (this.inFlight) return { swept: 0, errors: 0 };
    this.inFlight = true;
    let swept = 0;
    let errors = 0;
    try {
      const stale = await this.repository.getStaleRunningWorkflows(
        this.config.staleHeartbeatThresholdMs,
        this.config.staleRunBatchSize,
        { bypassTenant: true },
      );
      for (const run of stale) {
        try {
          // Dead-letter check first — a run that's already at the cap
          // gets terminated with `error.code === 'dead_lettered'` instead
          // of a normal `stale_heartbeat`. The CAS in `markAsDeadLettered`
          // races safely against a healthy worker that recovered the
          // run between the read above and the write below.
          const attempts = (run as unknown as { recoveryAttempts?: number }).recoveryAttempts ?? 0;
          if (attempts >= this.config.maxStaleRecoveries) {
            const dlOk = await this.repository.markAsDeadLettered(
              run._id,
              attempts,
              this.config.maxStaleRecoveries,
            );
            if (dlOk) {
              swept++;
              this.emitDeadLettered(run._id, attempts);
            }
            continue;
          }

          const ok = await this.repository.markStaleAsFailed(
            run._id,
            this.config.staleHeartbeatThresholdMs,
            this.config.staleRunAction,
          );
          if (ok) {
            swept++;
            this.emitFailed(run._id);
          }
        } catch (err) {
          errors++;
          logger.warn('[streamline] stale-sweep mark failed', {
            runId: run._id,
            error: toError(err).message,
          });
        }
      }
    } catch (err) {
      errors++;
      logger.warn('[streamline] stale-sweep query failed', {
        error: toError(err).message,
      });
    } finally {
      this.inFlight = false;
    }
    return { swept, errors };
  }

  private scheduleNext(): void {
    if (!this.active) return;
    this.timer = setTimeout(async () => {
      await this.sweepOnce();
      this.scheduleNext();
    }, this.config.staleRunSweepIntervalMs);
    this.timer.unref();
  }

  private emitFailed(runId: string): void {
    if (!this.eventBus) return;
    const message = `Worker heartbeat older than ${this.config.staleHeartbeatThresholdMs}ms — terminated by retention sweep`;
    // Match the canonical `workflow:failed` payload shape — `error` is
    // either an `Error` or `{ message; code? }`. Hosts already discriminate
    // on `error.code === 'stale_heartbeat'` per the bug report.
    this.eventBus.emit('workflow:failed', {
      runId,
      error: { code: 'stale_heartbeat', message },
    });
  }

  private emitDeadLettered(runId: string, attempts: number): void {
    if (!this.eventBus) return;
    this.eventBus.emit('workflow:failed', {
      runId,
      error: {
        code: 'dead_lettered',
        message: `Run exceeded maxStaleRecoveries (${attempts}/${this.config.maxStaleRecoveries})`,
      },
    });
  }
}

// ============================================================================
// Defaults
// ============================================================================

export const RETENTION_DEFAULTS = {
  /** Sensible default if the host enables sweep without picking a threshold. */
  staleHeartbeatThresholdMs: 30 * 60 * 1000,
  staleRunSweepIntervalMs: 60 * 1000,
  staleRunAction: 'fail' as const,
  staleRunBatchSize: 100,
  maxStaleRecoveries: 5,
} satisfies Required<
  Pick<
    RetentionOptions,
    | 'staleHeartbeatThresholdMs'
    | 'staleRunSweepIntervalMs'
    | 'staleRunAction'
    | 'staleRunBatchSize'
    | 'maxStaleRecoveries'
  >
>;

/**
 * Resolve a partial `RetentionOptions.stale*` block into the fully-specified
 * sweeper config. Only the host's explicit values override defaults.
 */
export function resolveSweeperConfig(options: RetentionOptions): SweeperConfig {
  return {
    staleHeartbeatThresholdMs:
      options.staleHeartbeatThresholdMs ?? RETENTION_DEFAULTS.staleHeartbeatThresholdMs,
    staleRunSweepIntervalMs:
      options.staleRunSweepIntervalMs ?? RETENTION_DEFAULTS.staleRunSweepIntervalMs,
    staleRunAction: options.staleRunAction ?? RETENTION_DEFAULTS.staleRunAction,
    staleRunBatchSize: options.staleRunBatchSize ?? RETENTION_DEFAULTS.staleRunBatchSize,
    maxStaleRecoveries: options.maxStaleRecoveries ?? RETENTION_DEFAULTS.maxStaleRecoveries,
  };
}
