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
};

export class SmartScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private pollInterval?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private staleCheckTimer?: NodeJS.Timeout;
  private isPolling = false;
  private isStaleCheckActive = false;
  private currentInterval: number;
  private consecutiveFailures = 0;
  private readonly metrics: SchedulerMetrics;
  private staleRecoveryCallback?: (runId: string, thresholdMs: number) => Promise<unknown>;
  private retryCallback?: (runId: string) => Promise<unknown>;

  constructor(
    private readonly repository: WorkflowRunRepository,
    private readonly resumeCallback: (runId: string) => Promise<void>,
    private readonly config: SmartSchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
    private readonly eventBus?: WorkflowEventBus,
  ) {
    this.currentInterval = config.basePollInterval;
    this.metrics = new SchedulerMetrics();
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

    // Schedule in-memory timer for fast resume (< 24.8 days)
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

      // Concurrency gating: check how many slots are available
      if (this.config.maxConcurrentExecutions !== Infinity) {
        const running = await this.repository.getRunningRuns();
        const activeCount = running.length;
        if (activeCount >= this.config.maxConcurrentExecutions) {
          // All slots full — skip this poll cycle
          const duration = Date.now() - startTime;
          this.metrics.recordPoll(duration, true, 0);
          return;
        }
        const availableSlots = this.config.maxConcurrentExecutions - activeCount;
        limit = Math.min(limit, availableSlots);
      }

      // Query workflows ready to resume (timer-based) - PAGINATED
      const waiting = await this.repository.getReadyToResume(now, limit);

      // Query workflows ready for retry (exponential backoff) - PAGINATED
      const retrying = await this.repository.getReadyForRetry(now, limit);

      let resumedCount = 0;

      // Resume waiting workflows
      for (const run of waiting) {
        // Skip if already has in-memory timer (will resume via setTimeout)
        if (this.timers.has(run._id)) continue;

        // Resume workflow (atomic claim happens inside resumeCallback/engine)
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

      // Execute scheduled workflows (timezone-aware scheduling) - PAGINATED
      // Query: status='draft' AND executionTime <= now AND paused != true
      const scheduledResult = await this.repository.getScheduledWorkflowsReadyToExecute(now, {
        limit,
      });
      const scheduled = scheduledResult.docs || [];

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
      const concurrencyDrafts = await this.repository.getConcurrencyDrafts(limit);

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

      // Recover stale running workflows (no heartbeat threshold) - PAGINATED
      const stale = await this.repository.getStaleRunningWorkflows(
        this.config.staleThreshold,
        limit,
      );

      for (const run of stale) {
        // Use dedicated stale recovery callback if available
        // This uses atomic claim on 'running' status with stale heartbeat check
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

      // Record successful poll
      const duration = Date.now() - startTime;
      const totalWorkflows = waiting.length + retrying.length + scheduled.length + stale.length;
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
      const waiting = await this.repository.getWaitingRuns();
      return waiting.length > 0;
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
      // Check for waiting workflows (need resume/retry)
      const waiting = await this.repository.getWaitingRuns();
      if (waiting.length > 0) return true;

      // Check for scheduled workflows ready to execute (timezone-aware)
      const scheduled = await this.repository.getScheduledWorkflowsReadyToExecute(new Date(), {
        limit: 1,
      });
      if (scheduled.docs && scheduled.docs.length > 0) return true;

      // Check for STALE running workflows (might need recovery after crashes)
      // Don't start scheduler for healthy running workflows
      const stale = await this.repository.getStaleRunningWorkflows(this.config.staleThreshold, 1);
      if (stale.length > 0) return true;

      // Check for concurrency-queued drafts waiting for promotion
      const draftCount = await this.repository.countConcurrencyDrafts();
      if (draftCount > 0) return true;

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
