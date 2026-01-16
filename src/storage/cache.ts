import type { WorkflowRun, RunStatus } from '../core/types.js';
import { LIMITS, COMPUTED } from '../config/constants.js';

/** Cache health status for monitoring and alerting */
export type CacheHealthStatus = 'healthy' | 'warning' | 'critical';

/**
 * O(1) LRU cache using Map's insertion-order iteration
 *
 * Map maintains insertion order, so we use delete+set to move items to the end.
 * - set/get/delete: O(1)
 * - eviction: O(1) - just delete first key
 * - Only caches active workflows (running/waiting)
 */
export class WorkflowCache {
  private readonly maxSize: number;
  private cache = new Map<string, WorkflowRun<unknown>>();

  constructor(maxSize: number = LIMITS.MAX_CACHE_SIZE) {
    this.maxSize = maxSize;
  }

  set<TContext>(run: WorkflowRun<TContext>): void {
    if (!this.isActive(run.status)) {
      this.cache.delete(run._id);
      return;
    }

    // Delete first to reset position in Map's ordering
    const exists = this.cache.has(run._id);
    if (exists) {
      this.cache.delete(run._id);
    }

    // Evict oldest if at capacity (only for new entries)
    if (!exists && this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    // Insert at end (most recently used)
    this.cache.set(run._id, run as WorkflowRun<unknown>);
  }

  get<TContext = unknown>(runId: string): WorkflowRun<TContext> | null {
    const run = this.cache.get(runId);
    if (!run) return null;

    // Move to end (most recently used) - O(1)
    this.cache.delete(runId);
    this.cache.set(runId, run);

    return run as WorkflowRun<TContext>;
  }

  delete(runId: string): void {
    this.cache.delete(runId);
  }

  clear(): void {
    this.cache.clear();
  }

  getActive<TContext = unknown>(): WorkflowRun<TContext>[] {
    return Array.from(this.cache.values()) as WorkflowRun<TContext>[];
  }

  size(): number {
    return this.cache.size;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilizationPercent: Math.round((this.cache.size / this.maxSize) * 100),
    };
  }

  /**
   * Check if cache is approaching capacity.
   * Useful for monitoring and proactive scaling.
   *
   * @param threshold - Utilization ratio (0-1), default 0.8 (80%)
   */
  isNearCapacity(threshold = 0.8): boolean {
    return this.cache.size / this.maxSize >= threshold;
  }

  /**
   * Get cache health status for monitoring dashboards.
   * Returns status and human-readable message.
   */
  getHealth(): { status: CacheHealthStatus; message: string; utilizationPercent: number } {
    const utilization = this.cache.size / this.maxSize;
    const utilizationPercent = Math.round(utilization * 100);

    if (this.cache.size < COMPUTED.CACHE_WARNING_THRESHOLD) {
      return {
        status: 'healthy',
        message: `Cache at ${utilizationPercent}% capacity`,
        utilizationPercent,
      };
    }

    if (this.cache.size < COMPUTED.CACHE_CRITICAL_THRESHOLD) {
      return {
        status: 'warning',
        message: `Cache at ${utilizationPercent}% - consider increasing maxSize`,
        utilizationPercent,
      };
    }

    return {
      status: 'critical',
      message: `Cache at ${utilizationPercent}% - frequent evictions may impact performance`,
      utilizationPercent,
    };
  }

  private isActive(status: RunStatus): boolean {
    return status === 'running' || status === 'waiting';
  }
}

/** Singleton for test utilities - each workflow creates its own cache via container */
export const workflowCache = new WorkflowCache();
