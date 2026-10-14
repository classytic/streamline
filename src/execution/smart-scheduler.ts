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
  /** When the next poll is due (while polling). A poll overdue past its grace = unhealthy. */
  nextPollAt?: Date;
  uptime: number;
}

/**
 * How late a poll may be before the scheduler reports unhealthy: half the
 * interval, clamped to 1s–30s. A poll takes seconds at most, so the backed-off
 * 5-min interval must not stretch the grace to minutes.
 */
function pollGraceMs(interval: number): number {
  return Math.min(30_000, Math.max(1_000, interval / 2));
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
    delete this.stats.nextPollAt;
  }

  /** The poll loop armed its next poll for `at`. */
  scheduled(at: Date): void {
    this.stats.nextPollAt = at;
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

    // Liveness: the loop knows exactly when its next poll is due. Overdue past
    // the grace means the loop died or a poll is stuck (the next one is only
    // armed when the current one ends). The old "2× the interval since the last
    // poll" rule followed the ADAPTIVE interval — after idle backoff to 5 min, a
    // hung scheduler still read healthy for 10.
    if (stats.isPolling && stats.nextPollAt) {
      const overdueMs = Date.now() - stats.nextPollAt.getTime();
      if (overdueMs > pollGraceMs(stats.pollInterval)) return false;
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
   * In-process dispatch pool: how many runs this scheduler drives at once.
   * A poll DISPATCHES and returns — one slow workflow no longer stalls
   * discovery, recovery, or every other run behind it — and its budget is
   * reduced by the work still in flight. A run already in flight here is never
   * dispatched twice. `drain()` awaits the pool (shutdown, tests).
   * @default 10
   */
  dispatchConcurrency?: number;
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

/** One kind of due work a poll admits (timer waits, retries, scheduled drafts, …). */
interface AdmissionCategory {
  /** `scheduler:error` context for a failure while driving one of these runs. */
  context: string;
  /** Up to `limit` due runs, oldest first. */
  fetch(limit: number): Promise<Array<{ _id: string }>>;
  /** The work for one run, or `null` to skip it (it still used budget). */
  work(runId: string): (() => Promise<unknown>) | null;
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
  dispatchConcurrency: 10,
  inMemoryTimers: true,
};

export class SmartScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  // `| undefined` (exactOptionalPropertyTypes): stop() clears these by
  // assigning `undefined`.
  private pollInterval: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private staleCheckTimer: NodeJS.Timeout | undefined;
  /** One timer for the next scheduled deadline while idle — see `armNextDeadline`. */
  private deadlineTimer: NodeJS.Timeout | undefined;
  private isPolling = false;
  private isStaleCheckActive = false;
  private currentInterval: number;
  private consecutiveFailures = 0;
  private readonly metrics: SchedulerMetrics;
  private staleRecoveryCallback?: (runId: string, thresholdMs: number) => Promise<unknown>;
  private retryCallback?: (runId: string) => Promise<unknown>;
  private compensationRecoveryCallback?: (runId: string, thresholdMs: number) => Promise<unknown>;
  private expiryCallback?: (runId: string) => Promise<unknown>;
  private signalCallback?: (runId: string) => Promise<unknown>;
  /** Runs this scheduler is driving right now — the dispatch pool. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Rotates which admission category goes first — see `admitFairly`. */
  private admissionRound = 0;

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

  /** Free pool slots right now. */
  private freeSlots(): number {
    const limit =
      this.config.dispatchConcurrency ?? DEFAULT_SCHEDULER_CONFIG.dispatchConcurrency ?? 10;
    return Math.max(0, limit - this.inFlight.size);
  }

  /**
   * Hand one run to the pool WITHOUT awaiting it. Returns false when the run
   * is already in flight here (an overlapping poll picked it up again).
   * Errors become `scheduler:error` with `context` — never a poll failure.
   */
  private dispatch(runId: string, context: string, work: () => Promise<unknown>): boolean {
    if (this.inFlight.has(runId)) return false;
    const task = (async () => {
      try {
        await work();
      } catch (err) {
        this.emitError(context, err, runId);
      } finally {
        this.inFlight.delete(runId);
      }
    })();
    this.inFlight.set(runId, task);
    return true;
  }

  /**
   * Split one poll's admission budget FAIRLY across work categories. A fixed
   * order let a continuous backlog in the first category (timer waits) take
   * every slot, starving retries, scheduled starts and drafts indefinitely.
   *
   *   Pass 1 — each category gets an equal share (at least 1), starting from a
   *            category that rotates every poll (so a budget smaller than the
   *            category count still reaches each in turn).
   *   Pass 2 — leftover budget goes to categories that FILLED their share, in
   *            the same rotated order, re-reading past the rows already taken.
   * Unsaturated categories cost one query, as before; pass 2 runs only under load.
   */
  private async admitFairly(
    categories: AdmissionCategory[],
    budget: number,
  ): Promise<Array<{ category: AdmissionCategory; runs: Array<{ _id: string }> }>> {
    const n = categories.length;
    if (n === 0 || budget <= 0) return [];
    const start = this.admissionRound++ % n;
    const order = [...categories.slice(start), ...categories.slice(0, start)];
    const share = Math.max(1, Math.floor(budget / n));
    let remaining = budget;

    const taken = order.map((category) => ({
      category,
      runs: [] as Array<{ _id: string }>,
      full: false,
    }));
    for (const slot of taken) {
      if (remaining <= 0) break;
      const want = Math.min(share, remaining);
      slot.runs = await slot.category.fetch(want);
      slot.full = slot.runs.length === want;
      remaining -= slot.runs.length;
    }
    for (const slot of taken) {
      if (remaining <= 0) break;
      if (!slot.full) continue;
      const have = slot.runs.length;
      const more = (await slot.category.fetch(have + remaining)).slice(have);
      const seen = new Set(slot.runs.map((r) => r._id));
      const extra = more.filter((r) => !seen.has(r._id));
      slot.runs.push(...extra);
      remaining -= extra.length;
    }
    return taken.map(({ category, runs }) => ({ category, runs }));
  }

  /**
   * Run ONE poll now — recovery then admission — outside the timer cadence.
   * Dispatches like a timed poll (does not await the work; see `drain()`).
   */
  async pollOnce(): Promise<void> {
    await this.poll();
  }

  /** Await every run the pool is driving (shutdown, tests). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /** Runs currently in flight in this scheduler's pool. */
  get inFlightCount(): number {
    return this.inFlight.size;
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
   * Set callback that delivers a queued durable signal to a run whose current
   * `waitFor` it matches — the sweep for a crash between `signal()`'s push and
   * its delivery. The engine wires this to `deliverSignal`.
   */
  setSignalCallback(callback: (runId: string) => Promise<unknown>): void {
    this.signalCallback = callback;
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

    // Nothing due now — but a scheduled draft may become due before the next
    // discovery tick. Best-effort: discovery re-arms on its own cadence.
    await this.armNextDeadline().catch((error) => this.emitError('discovery', error));
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
    // First poll NOW: polling only starts because work was just found (idle
    // discovery, boot, a new wait). Arming it a full interval out left a
    // crashed run unrecovered for that long — with a 60s interval, 60s.
    this.schedulePoll(0);
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
        await this.discoverWork();
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
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }

  /**
   * Background discovery — runs even while the scheduler is idle.
   *
   * An idle scheduler stops polling, so this is how it learns about work it
   * did not create itself: anything `hasActiveWorkflows()` reports (runs
   * another process inserted, stale runs, promotable drafts). When nothing is
   * due yet it arms ONE timer for the next scheduled deadline — checking only
   * for stale runs here left a future scheduled draft undiscovered forever
   * once polling had gone idle.
   */
  private async discoverWork(): Promise<void> {
    try {
      if (this.isPolling) return;
      if (await this.hasActiveWorkflows()) {
        logger.info('Background discovery found work - starting polling');
        this.startPolling();
        return;
      }
      await this.armNextDeadline();
    } catch (error) {
      // Emit error but don't crash - discovery retries on the next interval
      this.emitError('discovery', error);
    }
  }

  /**
   * Arm a single timer for the earliest scheduled draft, so it starts on time
   * rather than at the next discovery tick. Deadlines beyond that tick are left
   * to it (it re-arms), which keeps this to one short-lived timer, never one
   * per run.
   */
  private async armNextDeadline(): Promise<void> {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
    const at = await this.repository.getNextScheduledTime(this.scopedOpts);
    if (!at || !this.isStaleCheckActive) return;
    const delay = Math.max(0, at.getTime() - Date.now());
    if (delay > this.config.staleCheckInterval) return;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      if (this.isStaleCheckActive && !this.isPolling) this.startPolling();
    }, delay);
    this.deadlineTimer.unref();
  }

  private schedulePoll(delay: number = this.currentInterval): void {
    if (!this.isPolling) return;

    // Stays at this time until the poll ENDS and re-arms — a hung poll shows up
    // as overdue in `isHealthy()`.
    this.metrics.scheduled(new Date(Date.now() + delay));
    this.pollInterval = setTimeout(async () => {
      await this.poll();
      this.schedulePoll(); // Schedule next poll
    }, delay);
    this.pollInterval.unref();
  }

  private async poll(): Promise<void> {
    const startTime = Date.now();

    try {
      const now = new Date();

      // ── Maintenance: recover runs that already COUNT as executing (stale
      // `running`, stuck `compensating`). Never gated by the execution cap —
      // stale runs occupy the very slots their recovery would free, so gating
      // recovery on free slots deadlocked it.
      const recovery = await this.recoverStuck();

      // ── Admission: new work, under the execution cap and ONE shared budget.
      // Each category draws from the same `maxWorkflowsPerPoll`; handing every
      // category the full budget let one poll dispatch several times it.
      // (`countRunning` is an observation, not a reservation — a cross-replica
      // hard cap needs a durable counter; this bounds each worker's intake.)
      // The pool bounds THIS process: work still in flight from earlier polls
      // occupies slots, so intake never outruns what this worker can drive.
      let budget = Math.min(this.config.maxWorkflowsPerPoll, this.freeSlots());
      if (this.config.maxConcurrentExecutions !== Infinity) {
        const activeCount = await this.repository.countRunning({ bypassTenant: true });
        budget = Math.min(budget, Math.max(0, this.config.maxConcurrentExecutions - activeCount));
      }
      // Everything below DISPATCHES into the pool and moves on — the claims
      // inside the callbacks keep concurrent drivers (listeners, other
      // workers, an overlapping poll) to one winner. Cross-tenant sweeps;
      // per-row writes downstream are id-scoped.
      const repo = this.repository;
      const opts = this.scopedOpts;
      const resume = (runId: string) => this.resumeWorkflow(runId);
      const retry = this.retryCallback;
      const expire = this.expiryCallback;
      const deliver = this.signalCallback;
      const categories: AdmissionCategory[] = [
        // Timer waits ready to resume (runs an in-memory timer will resume are skipped).
        {
          context: 'resume-workflow',
          fetch: (n) => repo.getReadyToResume(now, n, opts),
          work: (id) => (this.timers.has(id) ? null : () => resume(id)),
        },
        // Exponential-backoff retries: execute() re-runs the step.
        ...(retry
          ? [
              {
                context: 'retry-workflow',
                fetch: (n: number) => repo.getReadyForRetry(now, n, opts),
                work: (id: string) => () => retry(id),
              },
            ]
          : []),
        // Orphaned childWorkflow / branchJoin waits (no listener after a crash):
        // engine.resume reconciles against the children; the waiting→running
        // claim keeps a live listener or another worker to one driver.
        {
          context: 'resume-workflow',
          fetch: (n) => repo.getChildWaitingRuns(now, n, opts),
          work: (id) => () => resume(id),
        },
        {
          context: 'resume-workflow',
          fetch: (n) => repo.getBranchJoinWaitingRuns(now, n, opts),
          work: (id) => () => resume(id),
        },
        // Human/webhook waits past `expiresAt` resume WITH a timeout sentinel.
        ...(expire
          ? [
              {
                context: 'expire-wait',
                fetch: (n: number) => repo.getExpiredWaits(now, n, opts),
                work: (id: string) => () => expire(id),
              },
            ]
          : []),
        // Due scheduled drafts — executeRetry() owns the draft→running claim
        // (pre-claiming here would make its own filter miss).
        ...(retry
          ? [
              {
                context: 'execute-scheduled',
                fetch: (n: number) => repo.getScheduledReady(now, n, opts),
                work: (id: string) => () => retry(id),
              },
            ]
          : []),
        // Concurrency-queued drafts awaiting a free slot.
        ...(retry
          ? [
              {
                context: 'promote-concurrency-draft',
                fetch: (n: number) => repo.getConcurrencyDrafts(n, opts),
                work: (id: string) => () => retry(id),
              },
            ]
          : []),
        // Durable signals stranded by a crash between push and delivery.
        ...(deliver
          ? [
              {
                context: 'deliver-signal',
                fetch: (n: number) => repo.getSignalReadyRuns(n, opts),
                work: (id: string) => () => deliver(id),
              },
            ]
          : []),
      ];

      const admitted = await this.admitFairly(categories, budget);
      let resumedCount = recovery.dispatched;
      for (const { category, runs } of admitted) {
        for (const run of runs) {
          const work = category.work(run._id);
          if (work && this.dispatch(run._id, category.context, work)) resumedCount++;
        }
      }

      // Record successful poll
      const duration = Date.now() - startTime;
      const totalWorkflows = admitted.reduce((sum, a) => sum + a.runs.length, 0) + recovery.found;
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

  /**
   * Maintenance phase of a poll: recover runs left `running` (stale heartbeat)
   * or `compensating` / `failed`-awaiting-saga after a crash. Has its own
   * `maxWorkflowsPerPoll` budget and is NEVER gated by `maxConcurrentExecutions`
   * or by the dispatch pool being full — a pool busy with long steps must not
   * delay crash recovery. Dispatched (not awaited) and deduped like the rest.
   * Cross-tenant sweeps; per-row recovery writes are id-scoped.
   */
  private async recoverStuck(): Promise<{ found: number; dispatched: number }> {
    const budget = this.config.maxWorkflowsPerPoll;
    const threshold = this.config.staleThreshold;
    let found = 0;
    let dispatched = 0;

    // Stale running — STREAMING via mongokit's cursor(): a cluster crash can
    // leave thousands; streaming holds one doc and breaks at the budget, so the
    // wire cost equals a bounded read without its `budget × docSize` peak.
    const recoverStale = this.staleRecoveryCallback;
    for await (const run of this.repository.cursorStaleRunning(threshold, this.scopedOpts)) {
      if (found >= budget) break;
      found++;
      if (!recoverStale) {
        logger.warn(`Stale workflow detected but no recovery callback set`, { runId: run._id });
        continue;
      }
      if (this.dispatch(run._id, 'recover-stale', () => recoverStale(run._id, threshold))) {
        dispatched++;
      }
    }

    // Stuck sagas: a crashed rollback (stale `compensating`) or a crash before
    // the saga was entered (`failed` + `compensationDue`). The callback
    // re-enters the walk, skipping per-step compensations already `done`.
    const recoverSaga = this.compensationRecoveryCallback;
    if (recoverSaga && found < budget) {
      const stuck = await this.repository.getStaleCompensatingRuns(
        threshold,
        budget - found,
        this.scopedOpts,
      );
      for (const run of stuck) {
        found++;
        if (this.dispatch(run._id, 'recover-compensation', () => recoverSaga(run._id, threshold))) {
          dispatched++;
        }
      }
    }

    return { found, dispatched };
  }

  /** Resume one run, recording the outcome. Never throws (errors → `scheduler:error`). */
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
      const scheduled = await this.repository.getScheduledReady(new Date(), 1, this.scopedOpts);
      if (scheduled.length > 0) return true;

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
        // Going idle must not strand a scheduled draft that is not due yet.
        await this.armNextDeadline().catch((error) => this.emitError('discovery', error));
      }
    }, this.config.idleTimeout);
    this.idleTimer.unref();
  }
}
