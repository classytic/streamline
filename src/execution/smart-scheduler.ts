/**
 * Intelligent Workflow Scheduler
 *
 * Features:
 * - Lazy start: Only polls when workflows exist
 * - Auto-stop: Stops when no workflows
 * - Adaptive polling: Adjusts interval based on load
 * - Circuit breaker: Handles failures gracefully
 * - Metrics: Tracks performance for monitoring
 *
 * Philosophy: Be smart, not wasteful. Iron Man, not Homer Simpson.
 */

import { COMPUTED, LIMITS, SCHEDULER, TIMING } from '../config/constants.js';
import type { WorkflowEventBus } from '../core/events.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import { toError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Scheduler Metrics (inlined from scheduler-metrics.ts)
// ============================================================================

export interface SchedulerStats {
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  lastPollAt?: Date;
  avgPollDuration: number;
  activeWorkflows: number;
  resumedWorkflows: number;
  missedResumes: number;
  isPolling: boolean;
  pollInterval: number;
  uptime: number;
}

class SchedulerMetrics {
  private stats: SchedulerStats = {
    totalPolls: 0,
    successfulPolls: 0,
    failedPolls: 0,
    avgPollDuration: 0,
    activeWorkflows: 0,
    resumedWorkflows: 0,
    missedResumes: 0,
    isPolling: false,
    pollInterval: 0,
    uptime: 0,
  };

  /** Ring buffer for O(1) insert — avoids Array.shift() which is O(n) */
  private readonly pollDurations = new Array<number>(100).fill(0);
  private pollDurationsIndex = 0;
  private pollDurationsCount = 0;
  private startTime?: Date;
  private readonly maxDurationsToTrack = 100;

  start(pollInterval: number): void {
    this.startTime = new Date();
    this.stats.isPolling = true;
    this.stats.pollInterval = pollInterval;
  }

  stop(): void {
    this.stats.isPolling = false;
  }

  recordPoll(duration: number, success: boolean, workflowsFound: number): void {
    this.stats.totalPolls++;
    this.stats.lastPollAt = new Date();

    if (success) {
      this.stats.successfulPolls++;
    } else {
      this.stats.failedPolls++;
    }

    // Ring buffer insert — O(1), no array resizing or shifting
    this.pollDurations[this.pollDurationsIndex] = duration;
    this.pollDurationsIndex = (this.pollDurationsIndex + 1) % this.maxDurationsToTrack;
    if (this.pollDurationsCount < this.maxDurationsToTrack) {
      this.pollDurationsCount++;
    }

    let sum = 0;
    for (let i = 0; i < this.pollDurationsCount; i++) {
      sum += this.pollDurations[i];
    }
    this.stats.avgPollDuration = sum / this.pollDurationsCount;

    this.stats.activeWorkflows = workflowsFound;
  }

  recordResume(success: boolean): void {
    if (success) {
      this.stats.resumedWorkflows++;
    } else {
      this.stats.missedResumes++;
    }
  }

  getStats(): SchedulerStats {
    if (this.startTime) {
      this.stats.uptime = Date.now() - this.startTime.getTime();
    }
    return { ...this.stats };
  }

  isHealthy(): boolean {
    const stats = this.getStats();

    if (stats.isPolling && !stats.lastPollAt) {
      return false;
    }

    if (stats.lastPollAt) {
      const timeSinceLastPoll = Date.now() - stats.lastPollAt.getTime();
      if (timeSinceLastPoll > stats.pollInterval * 2) {
        return false;
      }
    }

    if (stats.totalPolls > 10) {
      const successRate = stats.successfulPolls / stats.totalPolls;
      if (successRate < 0.9) {
        return false;
      }
    }

    if (stats.missedResumes > 0) {
      return false;
    }

    return true;
  }
}

/** JavaScript setTimeout max delay: 2^31-1 ms (~24.8 days) */
const MAX_SETTIMEOUT_DELAY = COMPUTED.MAX_TIMEOUT_SAFE_MS;

export interface SmartSchedulerConfig {
  /** Base poll interval (when active) */
  basePollInterval: number;
  /** Max poll interval (when load is low) */
  maxPollInterval: number;
  /** Min poll interval (when load is high) */
  minPollInterval: number;
  /** Max workflows to process per poll cycle (for efficiency at scale) */
  maxWorkflowsPerPoll: number;
  /** How long to wait before stopping (no workflows) */
  idleTimeout: number;
  /** Circuit breaker: max consecutive failures */
  maxConsecutiveFailures: number;
  /** Enable adaptive polling */
  adaptivePolling: boolean;
  /** Stale workflow check interval (runs even when scheduler is idle) */
  staleCheckInterval: number;
  /** Threshold for stale workflow detection */
  staleThreshold: number;
  /**
   * Max workflows executing simultaneously.
   * When the limit is reached, the scheduler skips processing new workflows until slots free up.
   * @default Infinity (no limit — current behavior)
   */
  maxConcurrentExecutions: number;
  /**
   * Whether `scheduleResume` arms an in-process `setTimeout` for fast,
   * sub-poll-interval resume of timer/sleep waits.
   *
   * SCALE TRADEOFF: with this `true` (default, current behavior) every
   * sub-~24.8-day `ctx.sleep`/timer wait creates one unref'd process timer so
   * the run resumes the instant it's due rather than waiting up to one poll
   * interval. At high sleeping-workflow volume (tens of thousands) that's tens
   * of thousands of live timers — memory + event-loop pressure. MongoDB
   * polling is the DURABLE backstop and resumes the same waits regardless, so
   * high-scale deployments can set this `false` to rely PURELY on DB polling
   * for bounded process-timer usage (trading instant resume for up-to-one-poll
   * latency). Long delays (≥ ~24.8 days) already skip the timer unconditionally.
   * @default true (in-process timers — current behavior, byte-for-byte)
   */
  inMemoryTimers?: boolean;
}

export const DEFAULT_SCHEDULER_CONFIG: SmartSchedulerConfig = {
  basePollInterval: SCHEDULER.BASE_POLL_INTERVAL_MS,
  maxPollInterval: SCHEDULER.MAX_POLL_INTERVAL_MS,
  minPollInterval: SCHEDULER.MIN_POLL_INTERVAL_MS,
  maxWorkflowsPerPoll: LIMITS.SCHEDULER_BATCH_SIZE,
  idleTimeout: SCHEDULER.IDLE_TIMEOUT_MS,
  adaptivePolling: true,
  maxConsecutiveFailures: SCHEDULER.MAX_CONSECUTIVE_FAILURES,
  staleCheckInterval: SCHEDULER.STALE_CHECK_INTERVAL_MS,
  staleThreshold: TIMING.STALE_WORKFLOW_THRESHOLD_MS,
  maxConcurrentExecutions: Infinity,
  inMemoryTimers: true,
};

export class SmartScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  // `| undefined` (exactOptionalPropertyTypes): stop() clears these by
  // assigning `undefined`.
  private pollInterval: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private staleCheckTimer: NodeJS.Timeout | undefined;
  private isPolling = false;
  private isStaleCheckActive = false;
  private currentInterval: number;
  private consecutiveFailures = 0;
  private readonly metrics: SchedulerMetrics;
  private staleRecoveryCallback?: (runId: string, thresholdMs: number) => Promise<unknown>;
  private retryCallback?: (runId: string) => Promise<unknown>;
  private compensationRecoveryCallback?: (runId: string, thresholdMs: number) => Promise<unknown>;
  private expiryCallback?: (runId: string) => Promise<unknown>;

  /**
   * Engine-scoping filter (v2.4.0 distributed-correctness fix). Every engine
   * owns its own scheduler; passing the engine's `workflowId` here scopes
   * EVERY pickup query (resume/retry/scheduled/stale/concurrency/child/
   * branchJoin/compensating) to this workflow's runs only. Without it, in a
   * multi-workflow deployment engine B's scheduler would pick up engine A's
   * run and run B's step graph against it (step-not-found / wrong-handler).
   * `undefined` preserves the legacy cross-workflow sweep (single-workflow
   * deployments, or callers that intentionally span all workflows).
   */
  private readonly scopedOpts: { bypassTenant: true; workflowId?: string };

  constructor(
    private readonly repository: WorkflowRunRepository,
    private readonly resumeCallback: (runId: string) => Promise<void>,
    private readonly config: SmartSchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
    private readonly eventBus?: WorkflowEventBus,
    workflowId?: string,
  ) {
    this.currentInterval = config.basePollInterval;
    this.metrics = new SchedulerMetrics();
    this.scopedOpts = workflowId ? { bypassTenant: true, workflowId } : { bypassTenant: true };
  }

  private emitError(context: string, error: unknown, runId?: string): void {
    if (this.eventBus) {
      this.eventBus.emit('scheduler:error', {
        runId,
        error: toError(error),
        context,
      });
    }
  }

  /**
   * Set callback for recovering stale 'running' workflows
   * Separate from resume because stale recovery requires different atomic claim logic
   */
  setStaleRecoveryCallback(
    callback: (runId: string, thresholdMs: number) => Promise<unknown>,
  ): void {
    this.staleRecoveryCallback = callback;
  }

  /**
   * Set callback for retrying failed steps
   * Separate from resume because retries need execute() (re-run step), not resumeStep() (mark done with payload)
   */
  setRetryCallback(callback: (runId: string) => Promise<unknown>): void {
    this.retryCallback = callback;
  }

  /**
   * Set callback for recovering runs left in `compensating` after a crash
   * mid-saga-rollback (durable saga, v2.4). Separate from stale-running
   * recovery: the compensation phase re-enters via its own state-machine path
   * and skips already-`done` per-step compensations (effectively-once).
   */
  setCompensationRecoveryCallback(
    callback: (runId: string, thresholdMs: number) => Promise<unknown>,
  ): void {
    this.compensationRecoveryCallback = callback;
  }

  /**
   * Set callback for resuming a `human`/`webhook` wait that has hit its
   * `expiresAt` deadline. Separate from `resumeCallback` because it must
   * resume WITH a timeout sentinel payload (so the next step can branch on the
   * timeout), whereas the generic resume sweep passes none. The engine wires
   * this to `resume(runId, timeoutSentinel)`.
   */
  setExpiryCallback(callback: (runId: string) => Promise<unknown>): void {
    this.expiryCallback = callback;
  }

  /**
   * Intelligent start: Only starts if workflows exist
   * Checks for both waiting workflows AND running workflows that might need stale recovery
   */
  async startIfNeeded(): Promise<boolean> {
    // Always start background stale check (runs independently)
    this.startStaleCheck();

    if (this.isPolling) return true;

    const hasActive = await this.hasActiveWorkflows();
    if (hasActive) {
      this.startPolling();
      return true;
    }

    return false;
  }

  /**
   * Force start polling immediately
   */
  start(): void {
    if (!this.isPolling) {
      this.startPolling();
    }
    // Always start background stale check (runs independently of polling)
    this.startStaleCheck();
  }

  /**
   * Stop polling
   */
  stop(): void {
    this.stopPolling();
    this.stopStaleCheck();
  }

  /**
   * Schedule a workflow to resume at specific time
   * Handles both short delays (setTimeout) and long delays (MongoDB polling)
   */
  scheduleResume(runId: string, resumeAt: Date): void {
    const delay = resumeAt.getTime() - Date.now();

    // Start polling if not already (workflow exists now)
    if (!this.isPolling) {
      this.startPolling();
    }

    // Clear idle timer (we have work)
    this.resetIdleTimer();

    if (delay <= 0) {
      // Resume immediately
      setImmediate(() => this.resumeWorkflow(runId));
      return;
    }

    // Check if delay exceeds setTimeout limit (~24.8 days)
    if (delay >= MAX_SETTIMEOUT_DELAY) {
      logger.info(`Long delay scheduled - using MongoDB polling`, {
        runId,
        delayDays: Math.round(delay / 86400000),
      });
      // Don't schedule setTimeout - rely on MongoDB polling
      // Polling will pick it up when resumeAt arrives
      return;
    }

    // OPT-IN DB-ONLY POLLING (`inMemoryTimers: false`): skip the per-wait
    // process timer entirely and let the MongoDB poll resume this run when
    // `resumeAt` passes. Trades instant resume for up-to-one-poll latency but
    // bounds process-timer count at high sleeping-workflow volume. See the
    // `inMemoryTimers` config doc for the full scale tradeoff.
    if (this.config.inMemoryTimers === false) {
      return;
    }

    // SCALE TRADEOFF (default `inMemoryTimers !== false`): each sub-~24.8-day
    // timer/sleep wait arms ONE unref'd in-process `setTimeout` so the run
    // resumes the moment it's due instead of waiting up to a poll interval. At
    // very high sleeping-workflow volume this is many thousands of live timers;
    // MongoDB polling is the DURABLE backstop that resumes these waits even
    // with no timer, so set `inMemoryTimers: false` to rely purely on polling.
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      this.resumeWorkflow(runId);
    }, delay);
    timer.unref();

    this.timers.set(runId, timer);
  }

  /**
   * Cancel scheduled resume
   */
  cancelSchedule(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
  }

  /**
   * Get scheduler statistics
   */
  getStats(): ReturnType<SchedulerMetrics['getStats']> {
    return this.metrics.getStats();
  }

  /**
   * Health check
   */
  isHealthy(): boolean {
    return this.metrics.isHealthy();
  }

  /**
   * Get current polling interval
   */
  getCurrentInterval(): number {
    return this.currentInterval;
  }

  // ============ Private Methods ============

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.metrics.start(this.currentInterval);
    this.schedulePoll();
    this.resetIdleTimer();
  }

  private stopPolling(): void {
    if (!this.isPolling) return;

    this.isPolling = false;
    this.metrics.stop();

    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = undefined;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Clear all timers
    this.timers.forEach((timer) => {
      clearTimeout(timer);
    });
    this.timers.clear();
  }

  /**
   * Start background stale workflow check
   * Runs independently of main polling loop to ensure crashed workflows are always recovered
   */
  private startStaleCheck(): void {
    if (this.isStaleCheckActive) return; // Already running

    this.isStaleCheckActive = true;

    const scheduleNext = () => {
      // Guard: Don't re-arm if stopped (prevents race condition)
      if (!this.isStaleCheckActive) return;

      this.staleCheckTimer = setTimeout(async () => {
        await this.checkForStaleWorkflows();
        scheduleNext(); // Schedule next check
      }, this.config.staleCheckInterval);
      this.staleCheckTimer.unref();
    };

    scheduleNext();
  }

  /**
   * Stop background stale workflow check
   * Guarantees no further checks will be scheduled, even if one is currently running
   */
  private stopStaleCheck(): void {
    this.isStaleCheckActive = false;

    if (this.staleCheckTimer) {
      clearTimeout(this.staleCheckTimer);
      this.staleCheckTimer = undefined;
    }
  }

  /**
   * Background check for stale workflows (runs even when scheduler is idle)
   * If stale workflows found, start the main polling loop
   */
  private async checkForStaleWorkflows(): Promise<void> {
    try {
      const staleWorkflows = await this.repository.getStaleRunningWorkflows(
        this.config.staleThreshold,
        1,
        this.scopedOpts,
      );

      if (staleWorkflows.length > 0 && !this.isPolling) {
        logger.info(`Background check found stale workflows - starting polling`, {
          count: staleWorkflows.length,
        });
        this.startPolling();
      }
    } catch (error) {
      // Emit error but don't crash - stale check will retry on next interval
      this.emitError('stale-check', error);
    }
  }

  private schedulePoll(): void {
    if (!this.isPolling) return;

    this.pollInterval = setTimeout(async () => {
      await this.poll();
      this.schedulePoll(); // Schedule next poll
    }, this.currentInterval);
    this.pollInterval.unref();
  }

  private async poll(): Promise<void> {
    const startTime = Date.now();

    try {
      const now = new Date();
      let limit = this.config.maxWorkflowsPerPoll;

      // Concurrency gating: check how many slots are available.
      // Cross-tenant — `maxConcurrentExecutions` is a global cap across all
      // tenants this scheduler serves.
      if (this.config.maxConcurrentExecutions !== Infinity) {
        const activeCount = await this.repository.countRunning({ bypassTenant: true });
        if (activeCount >= this.config.maxConcurrentExecutions) {
          // All slots full — skip this poll cycle
          const duration = Date.now() - startTime;
          this.metrics.recordPoll(duration, true, 0);
          return;
        }
        const availableSlots = this.config.maxConcurrentExecutions - activeCount;
        limit = Math.min(limit, availableSlots);
      }

      // Query workflows ready to resume (timer-based) - PAGINATED.
      // Cross-tenant sweep — bypass scope; per-row writes downstream are id-scoped.
      const waiting = await this.repository.getReadyToResume(now, limit, this.scopedOpts);

      // Query workflows ready for retry (exponential backoff) - PAGINATED.
      const retrying = await this.repository.getReadyForRetry(now, limit, this.scopedOpts);

      // Query workflows blocked on a childWorkflow wait that are due for
      // crash-durable reconciliation - PAGINATED.
      //
      // THE BUG THIS CLOSES: a parent suspended on ctx.startChildWorkflow()
      // is normally resumed only by in-process event-bus listeners. After a
      // crash/restart those listeners are gone and NO other sweep reclaims
      // the wait (it has no resumeAt/retryAfter and isn't status='running').
      // This sweep hands the orphaned wait to resumeCallback → engine.resume,
      // which reconciles against the child run (resume if the child already
      // finished, else re-register listeners + bump nextReconcileAt). The
      // engine's waiting→running atomic claim makes a concurrent in-memory
      // listener or a second polling worker a no-op (race-safe, idempotent).
      // Cross-tenant sweep — bypass scope; per-row writes downstream are
      // id-scoped.
      const childWaiting = await this.repository.getChildWaitingRuns(now, limit, this.scopedOpts);

      // Query workflows blocked on a branchJoin (declarative parallel) wait
      // due for crash-durable reconciliation - PAGINATED. Same orphaned-wait
      // bug class as childWorkflow: a parent parked on ctx.joinBranches() is
      // normally resumed by in-process listeners; after a crash those are gone
      // and no other sweep reclaims it. This hands the wait to resumeCallback →
      // engine.resume, which re-reads each branch child and resolves the join
      // quorum. The waiting→running claim makes concurrent drivers no-op.
      const branchJoinWaiting = await this.repository.getBranchJoinWaitingRuns(
        now,
        limit,
        this.scopedOpts,
      );

      let resumedCount = 0;

      // Resume waiting workflows
      for (const run of waiting) {
        // Skip if already has in-memory timer (will resume via setTimeout)
        if (this.timers.has(run._id)) continue;

        // Resume workflow (atomic claim happens inside resumeCallback/engine)
        await this.resumeWorkflow(run._id);
        resumedCount++;
      }

      // Reconcile childWorkflow waits. resumeCallback → engine.resume drives
      // reconciliation; the waiting→running claim guards against double-drive
      // by an in-memory listener or another worker.
      for (const run of childWaiting) {
        await this.resumeWorkflow(run._id);
        resumedCount++;
      }

      // Reconcile branchJoin waits — same race-safe drive as childWorkflow.
      for (const run of branchJoinWaiting) {
        await this.resumeWorkflow(run._id);
        resumedCount++;
      }

      // Execute workflows ready for retry
      // Retries need execute() (re-run step), not resumeStep() (mark done with payload)
      for (const run of retrying) {
        if (this.retryCallback) {
          try {
            await this.retryCallback(run._id);
            resumedCount++;
          } catch (err) {
            this.emitError('retry-workflow', err, run._id);
          }
        } else {
          logger.warn(`Retry workflow detected but no retry callback set`, { runId: run._id });
        }
      }

      // Expire human/webhook waits that have hit their `expiresAt` deadline.
      // Hands each to expiryCallback → engine.resume(runId, timeoutSentinel),
      // completing the waiting step with `{ __waitResolved: 'timeout' }` so the
      // next step can branch on the timeout — an unanswered approval can't park
      // a long-running workflow forever. The waiting→running CAS inside resume
      // makes this race-safe against a concurrent resumeHook (whichever wins,
      // the other is a no-op). Cross-tenant sweep; per-row writes are id-scoped.
      if (this.expiryCallback) {
        const expired = await this.repository.getExpiredWaits(now, limit, this.scopedOpts);
        for (const run of expired) {
          try {
            await this.expiryCallback(run._id);
            resumedCount++;
          } catch (err) {
            this.emitError('expire-wait', err, run._id);
          }
        }
      }

      // Execute scheduled workflows (timezone-aware scheduling) - PAGINATED
      // Query: status='draft' AND executionTime <= now AND paused != true.
      // Cross-tenant sweep — bypass scope; per-row writes downstream are id-scoped.
      const scheduledResult = await this.repository.getScheduledWorkflowsReadyToExecute(now, {
        limit,
        ...this.scopedOpts,
      });
      const scheduled = scheduledResult.data || [];

      for (const run of scheduled) {
        if (this.retryCallback) {
          try {
            // Delegate atomic claim to executeRetry() — it handles both
            // draft→running (scheduled) and waiting→running (retry) transitions.
            // The scheduler must NOT pre-claim here, otherwise executeRetry()
            // sees status='running' and its own claim filters don't match.
            await this.retryCallback(run._id);
            resumedCount++;
          } catch (err) {
            this.emitError('execute-scheduled', err, run._id);
          }
        } else {
          logger.warn(`Scheduled workflow detected but no execution callback set`, {
            runId: run._id,
          });
        }
      }

      // Promote concurrency-queued drafts (status='draft', no scheduling, has concurrencyKey)
      // These are runs that were queued because the concurrency limit was reached at start time.
      // Cross-tenant sweep — one scheduler serves every tenant's queue, so
      // bypass tenant scope on the read. Per-row promotion writes downstream
      // are `_id`-scoped.
      const concurrencyDrafts = await this.repository.getConcurrencyDrafts(limit, this.scopedOpts);

      for (const draft of concurrencyDrafts) {
        if (this.retryCallback) {
          try {
            await this.retryCallback(draft._id);
            resumedCount++;
          } catch (err) {
            this.emitError('promote-concurrency-draft', err, draft._id);
          }
        }
      }

      // Recover stale running workflows — STREAMING via mongokit's cursor().
      // Cross-tenant sweep; per-row recovery writes are id-scoped.
      //
      // Why cursor instead of buffered findAll: a cluster crash can leave
      // thousands of stale runs. Buffering the full page peaks memory at
      // `limit × runDocSize` (potentially MBs); streaming holds one doc.
      // The consumer breaks at `limit` for the per-poll budget, so wire
      // cost is identical to the bounded read.
      let staleCount = 0;
      for await (const run of this.repository.cursorStaleRunning(
        this.config.staleThreshold,
        this.scopedOpts,
      )) {
        if (staleCount >= limit) break;
        staleCount++;
        if (this.staleRecoveryCallback) {
          try {
            await this.staleRecoveryCallback(run._id, this.config.staleThreshold);
            resumedCount++;
          } catch (err) {
            this.emitError('recover-stale', err, run._id);
          }
        } else {
          logger.warn(`Stale workflow detected but no recovery callback set`, { runId: run._id });
        }
      }

      // Recover runs stuck in `compensating` after a crash mid-saga-rollback
      // (durable saga, v2.4). Mirrors stale-running recovery: a genuinely
      // crashed compensation has a stale heartbeat (a live one heartbeats),
      // and the recovery callback re-enters the compensation phase which skips
      // per-step compensations already `done` (effectively-once, no
      // double-compensation). Cross-tenant sweep; per-row writes id-scoped.
      let compensatingCount = 0;
      if (this.compensationRecoveryCallback) {
        const stuckCompensating = await this.repository.getStaleCompensatingRuns(
          this.config.staleThreshold,
          limit,
          this.scopedOpts,
        );
        for (const run of stuckCompensating) {
          compensatingCount++;
          try {
            await this.compensationRecoveryCallback(run._id, this.config.staleThreshold);
            resumedCount++;
          } catch (err) {
            this.emitError('recover-compensation', err, run._id);
          }
        }
      }

      // Record successful poll
      const duration = Date.now() - startTime;
      const totalWorkflows =
        waiting.length +
        retrying.length +
        childWaiting.length +
        branchJoinWaiting.length +
        scheduled.length +
        staleCount +
        compensatingCount;
      this.metrics.recordPoll(duration, true, totalWorkflows);
      this.consecutiveFailures = 0;

      // Adjust interval based on load (if adaptive)
      if (this.config.adaptivePolling) {
        this.adjustInterval(totalWorkflows);
      }

      // Check if should stop (no workflows)
      if (totalWorkflows === 0 && resumedCount === 0) {
        // Only start idle timer if not already running
        // This ensures we respect the idleTimeout from the FIRST empty poll
        if (!this.idleTimer) {
          this.resetIdleTimer();
        }
      } else {
        // Clear idle timer if we have work
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = undefined;
        }
      }
    } catch (error) {
      // Record failed poll
      const duration = Date.now() - startTime;
      this.metrics.recordPoll(duration, false, 0);
      this.consecutiveFailures++;

      this.emitError('poll', error);

      // Circuit breaker: Stop if too many failures
      if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        if (this.eventBus) {
          this.eventBus.emit('scheduler:circuit-open', {
            error: new Error(
              `Circuit breaker triggered after ${this.consecutiveFailures} consecutive failures`,
            ),
            context: 'circuit-breaker',
          });
        }
        this.stopPolling();
      }
    }
  }

  private async resumeWorkflow(runId: string): Promise<void> {
    try {
      await this.resumeCallback(runId);
      this.metrics.recordResume(true);
    } catch (error) {
      this.emitError('resume-workflow', error, runId);
      this.metrics.recordResume(false);
    }
  }

  private async hasWaitingWorkflows(): Promise<boolean> {
    try {
      return await this.repository.hasWaitingWorkflows(this.scopedOpts);
    } catch (error) {
      this.emitError('check-waiting', error);
      return false;
    }
  }

  /**
   * Check if there are any active workflows that need scheduler attention
   * Checks for waiting workflows (resume/retry), scheduled workflows, OR stale running workflows
   * Note: Healthy running workflows don't need the scheduler
   */
  private async hasActiveWorkflows(): Promise<boolean> {
    try {
      // Cross-tenant wake-up probes — scheduler activates when ANY tenant
      // has work pending. Bypass tenant scope on every read; per-row writes
      // downstream are id-scoped.
      if (await this.repository.hasWaitingWorkflows(this.scopedOpts)) return true;

      // Check for childWorkflow waits due for crash-durable reconciliation.
      // `hasWaitingWorkflows` already matches any status='waiting' run, so this
      // is usually redundant — but it's an explicit, cadence-gated wake reason
      // so the child-reconciliation sweep stays correct even if the broad
      // waiting probe's semantics narrow later.
      const childWaiting = await this.repository.getChildWaitingRuns(
        new Date(),
        1,
        this.scopedOpts,
      );
      if (childWaiting.length > 0) return true;

      // Check for branchJoin (declarative parallel) waits due for reconciliation.
      const branchJoinWaiting = await this.repository.getBranchJoinWaitingRuns(
        new Date(),
        1,
        this.scopedOpts,
      );
      if (branchJoinWaiting.length > 0) return true;

      // Check for scheduled workflows ready to execute (timezone-aware)
      const scheduled = await this.repository.getScheduledWorkflowsReadyToExecute(new Date(), {
        limit: 1,
        ...this.scopedOpts,
      });
      if (scheduled.data && scheduled.data.length > 0) return true;

      // Check for STALE running workflows (might need recovery after crashes)
      // Don't start scheduler for healthy running workflows
      const stale = await this.repository.getStaleRunningWorkflows(
        this.config.staleThreshold,
        1,
        this.scopedOpts,
      );
      if (stale.length > 0) return true;

      // Check for crashed saga compensations stuck in `compensating` (v2.4).
      const stuckCompensating = await this.repository.getStaleCompensatingRuns(
        this.config.staleThreshold,
        1,
        this.scopedOpts,
      );
      if (stuckCompensating.length > 0) return true;

      // Check for concurrency-queued drafts waiting for promotion (bounded
      // exists-query — short-circuits on the first match). Cross-tenant
      // probe — the scheduler decides whether to wake based on global
      // queue depth across all tenants.
      if (await this.repository.hasConcurrencyDrafts(this.scopedOpts)) return true;

      return false;
    } catch (error) {
      this.emitError('check-active', error);
      return false;
    }
  }

  private adjustInterval(workflowCount: number): void {
    const { minPollInterval, maxPollInterval, basePollInterval } = this.config;

    // More workflows = shorter interval (more responsive)
    // Fewer workflows = longer interval (less wasteful)
    if (workflowCount === 0) {
      this.currentInterval = maxPollInterval;
    } else if (workflowCount >= 100) {
      this.currentInterval = minPollInterval;
    } else if (workflowCount >= 10) {
      this.currentInterval = basePollInterval / 2;
    } else {
      this.currentInterval = basePollInterval;
    }

    // Update metrics
    this.metrics.start(this.currentInterval);
  }

  private resetIdleTimer(): void {
    // Clear existing timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    // Set new idle timer
    this.idleTimer = setTimeout(async () => {
      // Double-check no workflows before stopping
      const hasWaiting = await this.hasWaitingWorkflows();
      if (!hasWaiting && this.timers.size === 0) {
        logger.info('No workflows for idle timeout - stopping polling');
        this.stopPolling();
      }
    }, this.config.idleTimeout);
    this.idleTimer.unref();
  }
}
