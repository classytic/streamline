/**
 * System-wide timing and limit constants
 * Centralized to avoid magic numbers scattered across codebase
 */
export const TIMING = {
  /** Heartbeat interval to prevent workflows from being marked stale */
  HEARTBEAT_INTERVAL_MS: 30_000, // 30 seconds

  /** Threshold for inline vs scheduled execution */
  SHORT_DELAY_THRESHOLD_MS: 5_000, // 5 seconds

  /** Workflows with no heartbeat for this duration are considered crashed */
  STALE_WORKFLOW_THRESHOLD_MS: 5 * 60 * 1000, // 5 minutes

  /** Maximum retry delay (exponential backoff cap) */
  MAX_RETRY_DELAY_MS: 60_000, // 60 seconds

  /** Base delay for retry exponential backoff */
  RETRY_BASE_DELAY_MS: 1_000, // 1 second

  /** Multiplier for exponential backoff */
  RETRY_MULTIPLIER: 2,

  /** Default webhook timeout */
  WEBHOOK_TIMEOUT_MS: 30_000, // 30 seconds

  /** Hook registry cleanup interval */
  HOOK_CLEANUP_INTERVAL_MS: 60_000, // 1 minute
} as const;

export const LIMITS = {
  /** Maximum workflows in memory cache (LRU eviction) */
  MAX_CACHE_SIZE: 10_000,

  /** Default batch size for bulk operations */
  DEFAULT_BATCH_SIZE: 100,

  /** Maximum workflows to process per scheduler poll */
  SCHEDULER_BATCH_SIZE: 100,

  /** Maximum step ID length */
  MAX_ID_LENGTH: 100,

  /** Maximum steps per workflow */
  MAX_STEPS_PER_WORKFLOW: 1000,

  /** Maximum retries per step */
  MAX_RETRIES: 20,

  /** Maximum step timeout (30 minutes) */
  MAX_STEP_TIMEOUT_MS: 30 * 60 * 1000,
} as const;

export const RETRY = {
  /** Default number of retry attempts (including initial) */
  DEFAULT_MAX_ATTEMPTS: 3,

  /** Default step timeout in milliseconds */
  DEFAULT_TIMEOUT_MS: 30_000, // 30 seconds

  /** Jitter percentage for retry delays (±30%) */
  JITTER_FACTOR: 0.3,
} as const;

export const SCHEDULER = {
  /** Minimum polling interval (under heavy load) */
  MIN_POLL_INTERVAL_MS: 10_000, // 10 seconds

  /** Maximum polling interval (idle state) */
  MAX_POLL_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  /** Base polling interval */
  BASE_POLL_INTERVAL_MS: 60_000, // 1 minute

  /** Idle timeout before stopping scheduler */
  IDLE_TIMEOUT_MS: 120_000, // 2 minutes

  /** Circuit breaker: max consecutive failures */
  MAX_CONSECUTIVE_FAILURES: 5,

  /** Stale check interval */
  STALE_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
} as const;

export const SCHEDULING = {
  /** Grace period for scheduling in the past (clock skew tolerance) */
  PAST_SCHEDULE_GRACE_MS: 60_000, // 1 minute
} as const;

/**
 * Computed values derived from base constants.
 * Useful for monitoring, alerting, and capacity planning.
 */
export const COMPUTED = {
  /** Cache utilization threshold for warnings (80% of max) */
  CACHE_WARNING_THRESHOLD: Math.floor(LIMITS.MAX_CACHE_SIZE * 0.8),

  /** Cache utilization threshold for critical alerts (95% of max) */
  CACHE_CRITICAL_THRESHOLD: Math.floor(LIMITS.MAX_CACHE_SIZE * 0.95),

  /** JavaScript setTimeout max safe delay (2^31-1 ms = ~24.8 days) */
  MAX_TIMEOUT_SAFE_MS: 0x7fffffff,

  /** Retry delay sequence preview (for documentation/debugging) */
  RETRY_DELAY_SEQUENCE_MS: Array.from({ length: 5 }, (_, i) =>
    Math.min(TIMING.RETRY_BASE_DELAY_MS * TIMING.RETRY_MULTIPLIER ** i, TIMING.MAX_RETRY_DELAY_MS),
  ),
} as const;
