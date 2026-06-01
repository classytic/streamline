import { assertAndClaim } from '@classytic/primitives/state-machine';
import { TIMING } from '../config/constants.js';
import { globalEventBus, type WorkflowEventBus } from '../core/events.js';
import { RUN_MACHINE } from '../core/status.js';
import type { WorkflowCache } from '../storage/cache.js';
import type { WorkflowRunRepository } from '../storage/run.repository.js';
import type { WorkflowEngine } from './engine.js';

// ============================================================================
// Hook Registry (inlined from hook-registry.ts)
// ============================================================================

/**
 * Registry mapping runId to the engine managing that run.
 * Enables resumeHook() to find the correct engine for resuming.
 */
class HookRegistry {
  private engines = new Map<string, WeakRef<WorkflowEngine<unknown>>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  register(runId: string, engine: WorkflowEngine<unknown>): void {
    this.engines.set(runId, new WeakRef(engine));

    // Lazily start cleanup interval on first registration
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => this.cleanup(), TIMING.HOOK_CLEANUP_INTERVAL_MS);
      this.cleanupInterval.unref();
    }
  }

  unregister(runId: string): void {
    this.engines.delete(runId);
  }

  getEngine(runId: string): WorkflowEngine<unknown> | undefined {
    const ref = this.engines.get(runId);
    if (!ref) return undefined;

    const engine = ref.deref();
    if (!engine) {
      this.engines.delete(runId);
      return undefined;
    }

    return engine;
  }

  private cleanup(): void {
    for (const [runId, ref] of this.engines) {
      if (!ref.deref()) {
        this.engines.delete(runId);
      }
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.engines.clear();
  }
}

/** Global hook registry instance */
export const hookRegistry = new HookRegistry();

// ============================================================================
// Workflow Registry (for child workflow lookup by workflowId)
// ============================================================================

/**
 * Global registry mapping workflowId → engine, with optional
 * `(workflowId, version)` keying for in-flight version pinning.
 *
 * Two parallel maps:
 *   - `engines` — single "active" engine per workflowId. Backwards-compat
 *     for ctx.startChildWorkflow() and resumeHook(); always points at
 *     the most recently registered engine.
 *   - `versionedEngines` — `(workflowId, version)` → engine. Populated
 *     when the engine registers; consulted by `lookupVersion()` so a
 *     run started under v1 can be resumed by v1's engine even after v2
 *     has registered for the same workflowId.
 *
 * `WeakRef` lets engines GC normally — a stale entry just resolves to
 * `undefined`, mirroring "engine not registered."
 */
class WorkflowRegistryGlobal {
  private engines = new Map<string, WeakRef<WorkflowEngine<unknown>>>();
  private versionedEngines = new Map<string, WeakRef<WorkflowEngine<unknown>>>();

  register(workflowId: string, engine: WorkflowEngine<unknown>): void {
    this.engines.set(workflowId, new WeakRef(engine));
    const version = engine.definition.version;
    if (version) {
      this.versionedEngines.set(this.versionKey(workflowId, version), new WeakRef(engine));
    }
  }

  getEngine(workflowId: string): WorkflowEngine<unknown> | undefined {
    const ref = this.engines.get(workflowId);
    if (!ref) return undefined;
    const engine = ref.deref();
    if (!engine) {
      this.engines.delete(workflowId);
      return undefined;
    }
    return engine;
  }

  /**
   * Resolve an engine pinned to a specific definition version. Returns
   * `undefined` when no version-pinned engine is registered — callers
   * (engine.execute / engine.resume) treat that as "fall back to active
   * version" and fire the optional migration hook so the host can decide
   * whether to remap the run.
   */
  lookupVersion(workflowId: string, version: string): WorkflowEngine<unknown> | undefined {
    const ref = this.versionedEngines.get(this.versionKey(workflowId, version));
    if (!ref) return undefined;
    const engine = ref.deref();
    if (!engine) {
      this.versionedEngines.delete(this.versionKey(workflowId, version));
      return undefined;
    }
    return engine;
  }

  /**
   * Remove this engine from BOTH maps. Called from `engine.shutdown()`
   * so a stopped engine no longer accepts version-pinned routing — a
   * v2 engine resuming a v1 run shouldn't delegate execution to a v1
   * engine the host has explicitly torn down. Last-write-wins means
   * another engine may have already replaced us in the active map; the
   * `ref.deref() === engine` guards prevent us from deleting that
   * other engine's entry.
   */
  unregister(workflowId: string, engine: WorkflowEngine<unknown>): void {
    const activeRef = this.engines.get(workflowId);
    if (activeRef && activeRef.deref() === engine) {
      this.engines.delete(workflowId);
    }
    const version = engine.definition.version;
    if (version) {
      const key = this.versionKey(workflowId, version);
      const versionedRef = this.versionedEngines.get(key);
      if (versionedRef && versionedRef.deref() === engine) {
        this.versionedEngines.delete(key);
      }
    }
  }

  private versionKey(workflowId: string, version: string): string {
    return `${workflowId}@${version}`;
  }
}

export const workflowRegistry = new WorkflowRegistryGlobal();

// ============================================================================
// Inline Utilities
// ============================================================================

/** Shape of the listener bookkeeping map the engine keeps per run. */
export type EventListenerMap = Map<
  string,
  { listener: (...args: unknown[]) => void; eventName: string }
>;

/**
 * Clean up all event listeners for a specific workflow.
 *
 * Listeners fall into three key shapes:
 *   - `<runId>:<event>`              → container event-bus listener
 *   - `global:<runId>:<event>`       → globalEventBus listener (same fn wrapped)
 *   - `signal:<runId>:<event>`       → SignalStore unsub closure
 */
export function cleanupEventListeners(
  runId: string,
  listeners: EventListenerMap,
  eventBus: WorkflowEventBus,
): void {
  const prefixes = [`${runId}:`, `global:${runId}:`, `signal:${runId}:`];
  const keysToRemove = Array.from(listeners.keys()).filter((key) =>
    prefixes.some((p) => key.startsWith(p)),
  );

  for (const key of keysToRemove) {
    const entry = listeners.get(key);
    if (!entry) continue;

    if (key.startsWith('signal:')) {
      // Signal store unsub: the listener IS the unsub closure — call it.
      entry.listener();
    } else if (key.startsWith('global:')) {
      // Remove from globalEventBus (shared across all containers).
      globalEventBus.off(entry.eventName, entry.listener);
    } else {
      // Container event bus listener.
      eventBus.off(entry.eventName, entry.listener);
    }
    listeners.delete(key);
  }
}

/**
 * Handle short delay (< 5s) inline or schedule for later
 */
export async function handleShortDelayOrSchedule(
  runId: string,
  targetTime: Date,
  scheduleLongDelay: () => void,
  repository: WorkflowRunRepository,
  cache: WorkflowCache,
): Promise<boolean> {
  const delayMs = targetTime.getTime() - Date.now();

  if (delayMs > 0 && delayMs <= TIMING.SHORT_DELAY_THRESHOLD_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const remaining = targetTime.getTime() - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining + 10));
    }
  }

  if (delayMs <= TIMING.SHORT_DELAY_THRESHOLD_MS) {
    // Status-transition CAS — `assertAndClaim` runs `RUN_MACHINE.assertTransition`
    // (sync, in-memory) before the Mongo CAS. An illegal `waiting → running`
    // would be a programmer bug; the sync throw surfaces it before the
    // round-trip. The CAS itself still rejects concurrent writers via null.
    const claimed = await assertAndClaim(RUN_MACHINE, repository, runId, {
      from: 'waiting',
      to: 'running',
      where: { paused: { $ne: true } },
      patch: { lastHeartbeat: new Date(), updatedAt: new Date() },
      options: { bypassTenant: true },
    });

    if (claimed) {
      cache.delete(runId);
      return true;
    }

    return false;
  }

  scheduleLongDelay();
  return false;
}
