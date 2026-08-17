/**
 * Dependency Injection Container
 *
 * Enables testability and multi-instance support by eliminating global singletons.
 * All shared dependencies are passed through this container.
 */

import type { EventTransport } from '@classytic/primitives/events';
import type { Connection } from 'mongoose';
import { bridgeBusToTransport } from '../events/bridge.js';
import { InProcessStreamlineBus } from '../events/in-process-bus.js';
import { WorkflowCache } from '../storage/cache.js';
import {
  WorkflowConcurrencyCounterRepository,
  workflowConcurrencyCounterRepository,
} from '../storage/concurrency-counter.repository.js';
import { defineStreamlineModels } from '../storage/models.js';
import {
  type RetentionOptions,
  resolveSweeperConfig,
  StaleRunSweeper,
  syncRetentionIndexes as syncRetentionIndexesImpl,
} from '../storage/retention.js';
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
  /**
   * Strict-concurrency counter repository — only used when a workflow
   * declares `concurrency.strict: true`. Best-effort `concurrency.limit`
   * doesn't touch this collection. The default singleton works for every
   * deployment; override for testing or to swap the counter collection.
   */
  readonly concurrencyCounterRepository: WorkflowConcurrencyCounterRepository;
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
  /**
   * Stale-run sweeper. Present iff `retention.staleHeartbeatThresholdMs`
   * was set on this container. The container starts it on construction
   * and stops it on `dispose()` — the host normally never touches it,
   * but it's exposed for tests + manual sweep triggers.
   */
  readonly staleRunSweeper?: StaleRunSweeper | undefined;
  /**
   * Build ALL of streamline's indexes idempotently against the live mongoose
   * connection — the deploy-time index-sync helper (kernel `syncIndexes()`
   * convention). Three idempotent steps:
   *
   *   1. drops the legacy `idempotencyKey_1` unique index on upgrade (pre-2.9
   *      global idempotency → 2.9 tenant-scoped compound);
   *   2. builds the schema-defined indexes (tenant-scoped idempotency compound,
   *      …) non-destructively;
   *   3. builds retention extras — terminal-runs TTL and tenant-prefixed
   *      compound — when `retention` was configured on this container.
   *
   * Runs steps 1–2 even when `retention` is unset (the upgrade migration
   * matters regardless), so it's safe to call unconditionally from a deploy
   * script. Must be called AFTER `mongoose.connect(...)` / the connection is
   * open. Honours PACKAGE_RULES §32 — explicit, deploy-time, never auto-run on
   * every boot.
   *
   * @example
   * ```ts
   * const container = createContainer({
   *   retention: { terminalRunsTtlSeconds: 30 * 86400 },
   * });
   * await mongoose.connect(uri);
   * await container.syncRetentionIndexes();
   * ```
   */
  syncRetentionIndexes(): Promise<void>;
  /**
   * Stop background sweepers, release timers, and detach this container's
   * bus→transport bridge listeners. Idempotent. Hosts that gracefully shut
   * down (test teardown, SIGTERM) should call this — the underlying timers
   * are `unref()`'d so omitting it won't block process exit, but hosts
   * using `eventBus: 'global'` MUST call it or the bridge listeners leak
   * on the process-wide bus across container lifetimes (2.8.3).
   */
  dispose(): void;
}

/**
 * Options for creating a container
 */
export interface ContainerOptions {
  /**
   * Mongoose connection to bind streamline's models on. When provided (and
   * `repository` is a config, not an instance), the container binds the FULL
   * model set — run + concurrency-counter — on this connection with the
   * configured `tenant.tenantField`, so the idempotency index, retention
   * indexes, and concurrency reconciliation are all correct and connection-
   * consistent WITHOUT the host hand-building a model. Omit to use the default
   * eager models bound on `mongoose.connection`.
   *
   * (This is the clean way to run a custom `tenantField`: pass your connection
   * here — no separate `defineStreamlineModels().bind()` + `repository.model`.)
   */
  connection?: Connection | undefined;
  /**
   * Custom repository instance or configuration
   * - If WorkflowRunRepository: uses the provided instance (as-is; `connection` ignored)
   * - If WorkflowRepositoryConfig: creates a new repository with the config
   * - If undefined: uses the default singleton repository (or a connection-bound one)
   */
  repository?: WorkflowRunRepository | WorkflowRepositoryConfig | undefined;

  /**
   * Custom event bus instance
   * - If WorkflowEventBus: uses the provided instance
   * - If 'global': uses the globalEventBus (for telemetry integration)
   * - If undefined: creates a new isolated event bus
   */
  eventBus?: WorkflowEventBus | 'global' | undefined;

  /**
   * Custom cache instance
   * If undefined: creates a new isolated cache
   */
  cache?: WorkflowCache | undefined;

  /**
   * Custom signal store for durable cross-process event delivery.
   * - If SignalStore: uses the provided instance (e.g., Redis, Kafka, BullMQ adapter)
   * - If undefined: uses default in-memory store (process-local)
   */
  signalStore?: SignalStore | undefined;

  /**
   * Custom strict-concurrency counter repository — only consulted when a
   * workflow declares `concurrency.strict: true`. Default is the singleton
   * from `concurrency-counter.repository.ts` (one shared collection,
   * `workflow_concurrency_counters`). Override for tests or to point at
   * a custom collection.
   */
  concurrencyCounterRepository?: WorkflowConcurrencyCounterRepository | undefined;

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
  eventTransport?: EventTransport | undefined;

  /**
   * Retention block — TTL on terminal runs, tenant-prefixed compound
   * indexes, and the stale-run sweeper. See `RetentionOptions` for each
   * knob's semantics.
   *
   * Setting `staleHeartbeatThresholdMs` AUTO-STARTS the sweeper on
   * `createContainer` (timer is `unref()`'d, won't block process exit).
   * Setting `terminalRunsTtlSeconds` or `multiTenantIndexes` does NOT —
   * call `container.syncRetentionIndexes()` from a deploy script after
   * mongoose connects (PACKAGE_RULES §32).
   */
  retention?: RetentionOptions | undefined;
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
 *   repository: { tenant: { tenantField: 'meta.tenantId', required: true } }
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
  // Resolve repository: instance (has 'create' method) vs config object.
  // When a `connection` is supplied with a config, bind the FULL model set on
  // it (with the configured tenantField) and thread those models into BOTH the
  // run repo and the concurrency counter — so idempotency, retention, and
  // reconciliation all share one connection + one tenant field.
  const isRepoInstance =
    typeof options.repository === 'object' &&
    options.repository !== null &&
    'create' in options.repository &&
    'getById' in options.repository;

  let repository: WorkflowRunRepository;
  let boundModels: ReturnType<ReturnType<typeof defineStreamlineModels>['bind']> | undefined;

  if (isRepoInstance) {
    repository = options.repository as WorkflowRunRepository; // host-owned; `connection` ignored
  } else {
    const repoConfig = (options.repository ?? {}) as WorkflowRepositoryConfig;
    if (options.connection) {
      const tenantField =
        typeof repoConfig.tenant === 'object' ? repoConfig.tenant.tenantField : undefined;
      boundModels = defineStreamlineModels(tenantField ? { tenantField } : {}).bind(
        options.connection,
      );
      repository = createWorkflowRepository({
        ...repoConfig,
        model: repoConfig.model ?? boundModels.WorkflowRun,
      });
    } else if (!options.repository) {
      repository = workflowRunRepository;
    } else {
      repository = createWorkflowRepository(repoConfig);
    }
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
  // lifetime of the container and is torn down by `dispose()`. That teardown
  // is LOAD-BEARING for `eventBus: 'global'` hosts: the global bus is a
  // process-wide singleton, so a bridge left attached after the container is
  // discarded accumulates one listener per event name per container — repeated
  // create/dispose cycles (test suites booting an app per scenario) grow the
  // bus until MaxListenersExceededWarning fires.
  const unbridge = bridgeBusToTransport(eventBus, eventTransport);

  // Strict-concurrency counter — singleton; the counter collection is
  // global per `(workflowId, key)` and the same scheduler / engine
  // serves every container. Override via `options.concurrencyCounterRepository`
  // for tests or custom collections.
  const concurrencyCounterRepository =
    options.concurrencyCounterRepository ??
    (boundModels
      ? new WorkflowConcurrencyCounterRepository({
          counterModel: boundModels.WorkflowConcurrencyCounter,
          runModel: boundModels.WorkflowRun,
        })
      : workflowConcurrencyCounterRepository);

  // Retention — TTL/index sync stays explicit (PACKAGE_RULES §32) but the
  // stale-run sweeper auto-starts when the host configured a threshold.
  // Wiring the sweeper here means the host gets terminator semantics
  // out-of-the-box without an additional .start() call. Timer is
  // `unref()`'d in StaleRunSweeper so process exit isn't blocked.
  const retention = options.retention;
  const sweeper =
    retention?.staleHeartbeatThresholdMs !== undefined
      ? new StaleRunSweeper(repository, resolveSweeperConfig(retention), eventBus)
      : undefined;
  if (sweeper) sweeper.start();

  const container: StreamlineContainer = {
    repository,
    concurrencyCounterRepository,
    eventBus,
    eventTransport,
    cache,
    signalStore,
    staleRunSweeper: sweeper,
    syncRetentionIndexes: async () => {
      // Always run: builds the base schema indexes (tenant-scoped idempotency
      // compound) and drops the legacy `idempotencyKey_1` on upgrade — the
      // migration matters even for hosts that never configured `retention`.
      // TTL / tenant-compound extras kick in only when `retention` is set.
      await syncRetentionIndexesImpl(repository, retention ?? {});
    },
    dispose: () => {
      sweeper?.stop();
      // Detach the bus→transport bridge. Without this, containers created
      // against the shared `globalEventBus` leak their bridge listeners for
      // the life of the process (idempotent — `off` on removed listeners is
      // a no-op, so double-dispose is safe).
      unbridge();
    },
  };

  return container;
}

/**
 * Type guard to check if an object is a valid StreamlineContainer.
 *
 * Only checks the load-bearing structural fields. Newer surface (e.g.
 * `dispose`, `syncRetentionIndexes`) is intentionally NOT in the guard
 * so test fixtures and partial mocks built before those methods existed
 * still satisfy the guard.
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

export type { RetentionOptions } from '../storage/retention.js';
export { StaleRunSweeper } from '../storage/retention.js';
