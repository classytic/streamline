/**
 * Dependency Injection Container
 *
 * Enables testability and multi-instance support by eliminating global singletons.
 * All shared dependencies are passed through this container.
 */

import type { EventTransport } from '@classytic/primitives/events';
import { bridgeBusToTransport } from '../events/bridge.js';
import { InProcessStreamlineBus } from '../events/in-process-bus.js';
import { WorkflowCache } from '../storage/cache.js';
import {
  createWorkflowRepository,
  type WorkflowRepositoryConfig,
  type WorkflowRunRepository,
  workflowRunRepository,
} from '../storage/run.repository.js';
import { globalEventBus, WorkflowEventBus } from './events.js';

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
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

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
    this.listeners.get(channel)?.add(handler);
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
  readonly repository: WorkflowRunRepository;
  /** Event bus for workflow lifecycle events (internal, legacy shape) */
  readonly eventBus: WorkflowEventBus;
  /**
   * Arc-compatible event transport. Every event emitted on `eventBus` is
   * republished here under its canonical `streamline:<resource>.<verb>`
   * name in arc `DomainEvent` shape. Defaults to an in-process bus; pass
   * `eventTransport` to `createContainer` to use Redis/Kafka/etc.
   */
  readonly eventTransport: EventTransport;
  /** In-memory cache for active workflows */
  readonly cache: WorkflowCache;
  /** Pluggable signal store for durable cross-process event delivery */
  readonly signalStore: SignalStore;
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

  /**
   * Arc-compatible event transport (from `@classytic/arc/events` or any
   * implementation of `@classytic/primitives/events`' `EventTransport`
   * interface).
   *
   * If provided: internal events are bridged to this transport using
   * canonical `streamline:<resource>.<verb>` names. Hosts can
   * `transport.subscribe('streamline:*', handler)` to consume every event.
   *
   * If omitted: defaults to `InProcessStreamlineBus`, which wraps
   * primitives' `matchEventPattern` and mirrors arc's
   * `MemoryEventTransport` semantics.
   */
  eventTransport?: EventTransport;
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
  // Resolve repository: instance (has 'create' method) vs config object
  let repository: WorkflowRunRepository;
  if (!options.repository) {
    repository = workflowRunRepository;
  } else if (
    typeof options.repository === 'object' &&
    'create' in options.repository &&
    'getById' in options.repository
  ) {
    repository = options.repository;
  } else {
    repository = createWorkflowRepository(options.repository);
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

  // Resolve arc-shape event transport (default: in-process bus).
  const eventTransport: EventTransport = options.eventTransport ?? new InProcessStreamlineBus();

  // Bridge every legacy event bus emission onto the transport using
  // canonical streamline:<resource>.<verb> names. The bridge lives for the
  // lifetime of the container — no explicit teardown needed in normal use.
  bridgeBusToTransport(eventBus, eventTransport);

  return { repository, eventBus, eventTransport, cache, signalStore };
}

/**
 * Type guard to check if an object is a valid StreamlineContainer
 */
export function isStreamlineContainer(obj: unknown): obj is StreamlineContainer {
  if (obj == null || typeof obj !== 'object') return false;
  return (
    'repository' in obj &&
    'eventBus' in obj &&
    'eventTransport' in obj &&
    'cache' in obj &&
    (obj as StreamlineContainer).eventBus instanceof WorkflowEventBus &&
    (obj as StreamlineContainer).cache instanceof WorkflowCache
  );
}
