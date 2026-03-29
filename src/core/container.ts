/**
 * Dependency Injection Container
 *
 * Enables testability and multi-instance support by eliminating global singletons.
 * All shared dependencies are passed through this container.
 */

import { WorkflowCache } from '../storage/cache.js';
import { WorkflowEventBus, globalEventBus } from './events.js';
import { workflowRunRepository, createWorkflowRepository, type WorkflowRunRepository, type WorkflowRepositoryConfig } from '../storage/run.repository.js';

/**
 * Pluggable signal store for durable cross-process event delivery.
 *
 * Default: in-memory (process-local). For durable signals across workers,
 * plug in Redis, Kafka, BullMQ, or any pub/sub backend.
 *
 * Streamline never depends on these — users bring their own adapter.
 *
 * @example Redis adapter (user-provided)
 * ```typescript
 * import Redis from 'ioredis';
 *
 * const redis = new Redis();
 * const signalStore: SignalStore = {
 *   publish: (channel, data) => redis.publish(channel, JSON.stringify(data)),
 *   subscribe: (channel, handler) => {
 *     const sub = redis.duplicate();
 *     sub.subscribe(channel);
 *     sub.on('message', (ch, msg) => handler(JSON.parse(msg)));
 *     return () => { sub.unsubscribe(channel); sub.disconnect(); };
 *   },
 * };
 *
 * const container = createContainer({ signalStore });
 * ```
 */
export interface SignalStore {
  /** Publish a signal to a named channel */
  publish(channel: string, data: unknown): Promise<void> | void;
  /** Subscribe to a channel. Returns an unsubscribe function. */
  subscribe(channel: string, handler: (data: unknown) => void): (() => void) | Promise<() => void>;
}

/**
 * Default in-memory signal store (process-local).
 * Sufficient for single-worker deployments and testing.
 */
class InMemorySignalStore implements SignalStore {
  private listeners = new Map<string, Set<(data: unknown) => void>>();

  publish(channel: string, data: unknown): void {
    const handlers = this.listeners.get(channel);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
  }

  subscribe(channel: string, handler: (data: unknown) => void): () => void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(handler);
    return () => {
      this.listeners.get(channel)?.delete(handler);
    };
  }
}

/**
 * Container holding all shared dependencies for a workflow engine instance.
 *
 * @example
 * ```typescript
 * // Use default container (creates new instances)
 * const container = createContainer();
 *
 * // Use in workflow
 * const workflow = createWorkflow('my-workflow', {
 *   steps: { ... },
 *   container
 * });
 * ```
 */
export interface StreamlineContainer {
  /** MongoDB repository for workflow runs */
  repository: WorkflowRunRepository;
  /** Event bus for workflow lifecycle events */
  eventBus: WorkflowEventBus;
  /** In-memory cache for active workflows */
  cache: WorkflowCache;
  /** Pluggable signal store for durable cross-process event delivery */
  signalStore: SignalStore;
}

/**
 * Options for creating a container
 */
export interface ContainerOptions {
  /**
   * Custom repository instance or configuration
   * - If WorkflowRunRepository: uses the provided instance
   * - If WorkflowRepositoryConfig: creates a new repository with the config
   * - If undefined: uses the default singleton repository
   */
  repository?: WorkflowRunRepository | WorkflowRepositoryConfig;

  /**
   * Custom event bus instance
   * - If WorkflowEventBus: uses the provided instance
   * - If 'global': uses the globalEventBus (for telemetry integration)
   * - If undefined: creates a new isolated event bus
   */
  eventBus?: WorkflowEventBus | 'global';

  /**
   * Custom cache instance
   * If undefined: creates a new isolated cache
   */
  cache?: WorkflowCache;

  /**
   * Custom signal store for durable cross-process event delivery.
   * - If SignalStore: uses the provided instance (e.g., Redis, Kafka, BullMQ adapter)
   * - If undefined: uses default in-memory store (process-local)
   */
  signalStore?: SignalStore;
}

/**
 * Create a new container with configurable dependencies.
 *
 * @param options - Optional configuration for container dependencies
 * @returns A container with the specified or default dependencies
 *
 * @example Default container (isolated instances)
 * ```typescript
 * const container = createContainer();
 * ```
 *
 * @example Multi-tenant container
 * ```typescript
 * const container = createContainer({
 *   repository: { multiTenant: { tenantField: 'meta.tenantId', strict: true } }
 * });
 * ```
 *
 * @example Container with global event bus (for telemetry)
 * ```typescript
 * const container = createContainer({ eventBus: 'global' });
 * ```
 *
 * @example Fully custom container
 * ```typescript
 * const container = createContainer({
 *   repository: myCustomRepo,
 *   eventBus: myCustomEventBus,
 *   cache: myCustomCache
 * });
 * ```
 */
export function createContainer(options: ContainerOptions = {}): StreamlineContainer {
  // Resolve repository
  let repository: WorkflowRunRepository;
  if (!options.repository) {
    repository = workflowRunRepository;
  } else if ('create' in options.repository && 'getById' in options.repository) {
    // It's a WorkflowRunRepository instance
    repository = options.repository as WorkflowRunRepository;
  } else {
    // It's a config object
    repository = createWorkflowRepository(options.repository as WorkflowRepositoryConfig);
  }

  // Resolve event bus
  let eventBus: WorkflowEventBus;
  if (options.eventBus === 'global') {
    eventBus = globalEventBus;
  } else if (options.eventBus instanceof WorkflowEventBus) {
    eventBus = options.eventBus;
  } else {
    eventBus = new WorkflowEventBus();
  }

  // Resolve cache
  const cache = options.cache ?? new WorkflowCache();

  // Resolve signal store
  const signalStore = options.signalStore ?? new InMemorySignalStore();

  return { repository, eventBus, cache, signalStore };
}

/**
 * Type guard to check if an object is a valid StreamlineContainer
 */
export function isStreamlineContainer(obj: unknown): obj is StreamlineContainer {
  if (!obj || typeof obj !== 'object') return false;
  const container = obj as Record<string, unknown>;
  return (
    'repository' in container &&
    'eventBus' in container &&
    'cache' in container &&
    container.eventBus instanceof WorkflowEventBus &&
    container.cache instanceof WorkflowCache
  );
}
