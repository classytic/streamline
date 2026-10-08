/**
 * `@classytic/streamline/testkit` — a real workflow-engine test harness.
 *
 * One call gives a test an ISOLATED streamline world on a real (ephemeral)
 * MongoDB: its own connection, a container bound to it, real indexes. On top:
 *
 *   - `env.workflow(name, config)` — `createWorkflow` with a unique id, this
 *     env's container, `autoExecute: false` (tests drive execution), and
 *     automatic shutdown on `clear()` / `close()`.
 *   - `env.runs.*`  — persist the run shapes engine tests need (crash / stale /
 *     due / waiting / mid-saga), derived from the workflow's own definition.
 *   - `env.until()` — wait for a run to reach a state; never a guessed sleep.
 *   - `env.tick()`  — one scheduler poll + the work it dispatched, now.
 *   - `env.trace()` — every MongoDB command a block sends: writes, reads, bytes.
 *
 * Framework-agnostic (no vitest/jest import): wire `clear()` / `close()` into
 * your runner's hooks. `mongodb-memory-server` is an optional peer, loaded only
 * when a server is started; pass `{ uri }` or set `MONGODB_URI` to run against
 * a real MongoDB / replica set instead.
 *
 * ```ts
 * const env = await createStreamlineTestEnv();
 * afterEach(() => env.clear());
 * afterAll(() => env.close());
 *
 * it('approves', async () => {
 *   const wf = env.workflow('approval', {
 *     steps: { gate: async (ctx) => ctx.waitFor('approved'), ship: async () => 'ok' },
 *   });
 *   const run = await wf.start({});
 *   await wf.execute(run._id);
 *   await wf.signal(run._id, 'approved', { by: 'ops' });
 *   expect((await env.until(run._id, 'done')).output).toBe('ok');
 * });
 * ```
 */

import { createMongoMemory, type MongoMemoryOptions } from '@classytic/mongokit/testkit';
import type { Connection, Model } from 'mongoose';
import { createConnection, mongo } from 'mongoose';
import {
  type ContainerOptions,
  createContainer,
  type StreamlineContainer,
} from '../core/container.js';
import type { RunStatus, StepState, WorkflowRun } from '../core/types.js';
import { makeCounterId } from '../storage/concurrency-counter.model.js';
import { createWorkflow, type Workflow, type WorkflowConfig } from '../workflow/define.js';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface StreamlineTestEnvOptions extends MongoMemoryOptions {
  /** Extra container options (retention, signal store, tenant config…). The connection is the env's. */
  container?: Omit<ContainerOptions, 'connection'>;
}

/**
 * What the harness needs from a workflow — structural, so a workflow of ANY
 * context/input type fits (`Workflow<TContext>` is invariant in TContext).
 */
export interface WorkflowLike {
  readonly engine: {
    readonly definition: {
      readonly id: string;
      readonly version: string;
      readonly steps: ReadonlyArray<{ readonly id: string }>;
    };
    pollScheduler(options?: { wait?: boolean }): Promise<void>;
  };
}

/** A workflow, or just its id, that a fixture should belong to. */
export type WorkflowRef = WorkflowLike | string;

export interface UntilOptions {
  /** Give up after this many ms (throws, naming the last status seen). Default 5000. */
  timeout?: number;
  /** Poll interval in ms. Default 20. */
  interval?: number;
  /** What is being waited for — leads the timeout error (`eventually` / `untilCount`). */
  message?: string;
}

export interface TracedCommand {
  name: string;
  /** The collection the command targeted, when it names one. */
  collection?: string;
  bytesSent: number;
  bytesReceived: number;
  /** The command document as sent (filter / update / pipeline …). */
  command: Record<string, unknown>;
}

export interface Trace<T> {
  result: T;
  /** Every command on the env's connection during the block — including other workflows' scheduler probes. */
  commands: TracedCommand[];
  /** insert / update / findAndModify / delete commands. */
  writes: number;
  /** find / aggregate / count / distinct commands. */
  reads: number;
  bytesSent: number;
  bytesReceived: number;
  /**
   * The update document (its `$set`, when it has one) of every write that
   * targeted `runId` — `update` and `findAndModify` alike — in order.
   */
  updatesTo(runId: string): Record<string, unknown>[];
  /** The reads whose filter / pipeline names `runId`. */
  readsOf(runId: string): TracedCommand[];
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Fields a fixture may override; anything else on a run doc is allowed too. */
export type RunFields = Partial<WorkflowRun> & Record<string, unknown>;

export interface RunFixtures {
  /**
   * Insert a run as given, over defaults derived from the workflow: every step
   * `pending`, `currentStepId` = first step, the definition's version pinned.
   * Writes straight to the collection — the shape a crash or another process
   * would leave, with no engine involved.
   */
  insert(wf: WorkflowRef, fields?: RunFields): Promise<WorkflowRun>;
  /** `running` with `step` mid-attempt and a heartbeat `heartbeatAgeMs` old (default 1h). */
  staleRunning(
    wf: WorkflowRef,
    opts?: { step?: string; heartbeatAgeMs?: number },
  ): Promise<WorkflowRun>;
  /** `waiting` with `step` pending a retry that is already due. */
  retryDue(wf: WorkflowRef, opts?: { step?: string }): Promise<WorkflowRun>;
  /** `waiting` on a timer (`ctx.sleep`) that is already due. */
  timerDue(wf: WorkflowRef, opts?: { step?: string }): Promise<WorkflowRun>;
  /** `waiting` on `ctx.waitFor(eventName)` at `step`. */
  waitingFor(wf: WorkflowRef, eventName: string, opts?: { step?: string }): Promise<WorkflowRun>;
  /** A `draft` scheduled to execute at a time already past. */
  scheduledDue(wf: WorkflowRef): Promise<WorkflowRun>;
  /**
   * A run whose `failed` step was written but whose saga never started — the
   * crash between the failure write and `failed → compensating`. `done` steps
   * precede it. Old enough for the recovery sweep.
   */
  failedAwaitingCompensation(
    wf: WorkflowRef,
    opts: { done: string[]; failed: string },
  ): Promise<WorkflowRun>;
  /** `compensating` with a stale heartbeat — a rollback whose walker died. */
  staleCompensating(
    wf: WorkflowRef,
    opts: { done: string[]; failed: string },
  ): Promise<WorkflowRun>;
  /** Read a run straight from the collection (no engine cache). */
  get(runId: string): Promise<WorkflowRun | null>;
  /**
   * Write to a stored run (a Mongo update document, or plain fields → `$set`)
   * AND drop it from the engine cache, so the next engine read sees the edit.
   * Direct `env.runModel` writes skip that and leave a cached run stale.
   */
  update(runId: string, update: Record<string, unknown>): Promise<WorkflowRun | null>;
  /**
   * Make whatever the run is waiting on due NOW — a retry's `retryAfter`, a
   * timer's `resumeAt`, a scheduled draft's `executionTime` — without waiting
   * out the real delay. Cache-safe (see `update`).
   */
  makeDue(runId: string): Promise<WorkflowRun | null>;
}

// ─── The env ─────────────────────────────────────────────────────────────────

export interface StreamlineTestEnv {
  /** The env's own connection — never the global `mongoose.connection`. */
  connection: Connection;
  uri: string;
  /** A container bound to `connection`. Every `env.workflow()` uses it. */
  container: StreamlineContainer;
  /** The run model on this env's connection, for direct reads/asserts. */
  runModel: Model<WorkflowRun>;
  /**
   * `createWorkflow` for tests: a unique id (`name-N`), this env's container,
   * and `autoExecute: false` unless the config says otherwise. Shut down by
   * `clear()` / `close()`.
   */
  workflow<
    TContext = Record<string, unknown>,
    TInput = unknown,
    TOutputs = Record<string, unknown>,
  >(name: string, config: WorkflowConfig<TContext, TInput, TOutputs>): Workflow<TContext, TInput>;
  runs: RunFixtures;
  /**
   * Wait until the stored run satisfies `until` — a status, or a predicate —
   * and return it. Reads the collection (never a cached copy). Throws after
   * `timeout`, naming the status it last saw.
   */
  until(
    runId: string,
    until: RunStatus | ((run: WorkflowRun) => boolean),
    options?: UntilOptions,
  ): Promise<WorkflowRun>;
  /**
   * Retry `check` until it passes — it may throw (an assertion) or return
   * `false`. For conditions that are not one run's state: counters, handler
   * side effects, scheduler stats. Throws the last failure after `timeout`.
   */
  eventually<T>(check: () => T | Promise<T>, options?: UntilOptions): Promise<Exclude<T, false>>;
  /** Wait until at least `count` stored runs match `filter` (runs whose ids you don't know). */
  untilCount(
    filter: Record<string, unknown>,
    count: number,
    options?: UntilOptions,
  ): Promise<WorkflowRun[]>;
  /**
   * Another WORKER of `wf`: the same workflow id on its OWN container (own bus,
   * cache, scheduler) over the env's connection — a second process. `config`
   * is that process's definition (same steps, or a different version). Shut
   * down and disposed by `clear()`.
   */
  worker<TContext = Record<string, unknown>, TInput = unknown, TOutputs = Record<string, unknown>>(
    wf: WorkflowLike,
    config: WorkflowConfig<TContext, TInput, TOutputs>,
  ): Workflow<TContext, TInput>;
  /**
   * Re-create `wf` on the SAME container under the same id — a deploy of a new
   * version, or a restart in the same process. Shut down by `clear()`.
   */
  redefine<
    TContext = Record<string, unknown>,
    TInput = unknown,
    TOutputs = Record<string, unknown>,
  >(
    wf: WorkflowLike,
    config: WorkflowConfig<TContext, TInput, TOutputs>,
  ): Workflow<TContext, TInput>;
  /** An extra container on the env's connection (its own bus/cache). Disposed by `clear()`. */
  createContainer(options?: Omit<ContainerOptions, 'connection'>): StreamlineContainer;
  /** The strict-concurrency counter for `(wf, key)` — `null` before the first claim. */
  counter(
    wf: WorkflowRef,
    key: string,
  ): Promise<{ count: number; limit: number; rev?: number } | null>;
  /** One scheduler poll for `wf` (recovery + admission), then wait for what it dispatched. */
  tick(wf: WorkflowLike): Promise<void>;
  /** Run `fn` and record every MongoDB command it sends on this env's connection. */
  trace<T>(fn: () => Promise<T>): Promise<Trace<T>>;
  /** Shut down this env's workflows and empty every collection. For `afterEach`. */
  clear(): Promise<void>;
  /** `clear()`, close the connection, stop the server. Idempotent. For `afterAll`. */
  close(): Promise<void>;
}

const WRITE_COMMANDS = new Set(['insert', 'update', 'findAndModify', 'delete']);
const READ_COMMANDS = new Set(['find', 'aggregate', 'count', 'distinct', 'getMore']);
const IGNORED_COMMANDS = new Set(['hello', 'isMaster', 'ping', 'endSessions', 'createIndexes']);
const LONG_AGO = 60 * 60 * 1000;
let envSeq = 0;

/** Does a traced command's filter / pipeline / query name `runId`? */
function mentions(c: TracedCommand, runId: string): boolean {
  const where = c.command.filter ?? c.command.pipeline ?? c.command.query ?? c.command.updates;
  return JSON.stringify(where ?? {}).includes(runId);
}

/** The update document (its `$set`, when present) of every write to `runId`, in order. */
function updatesTo(commands: TracedCommand[], runId: string): Record<string, unknown>[] {
  const asSet = (u: unknown) =>
    ((u as { $set?: Record<string, unknown> }).$set ?? u) as Record<string, unknown>;
  const out: Record<string, unknown>[] = [];
  for (const c of commands) {
    if (c.name === 'update') {
      for (const s of (c.command.updates ?? []) as Array<{ q: { _id?: unknown }; u: unknown }>) {
        if (s.q._id === runId) out.push(asSet(s.u));
      }
    } else if (c.name === 'findAndModify') {
      const query = c.command.query as { _id?: unknown } | undefined;
      if (query?._id === runId) out.push(asSet(c.command.update));
    }
  }
  return out;
}

/**
 * Boot an isolated streamline world: an ephemeral MongoDB (or `uri` /
 * `MONGODB_URI`), a dedicated connection with command monitoring, a container
 * bound to it, and streamline's real indexes.
 */
export async function createStreamlineTestEnv(
  options: StreamlineTestEnvOptions = {},
): Promise<StreamlineTestEnv> {
  const { container: containerOptions, ...memory } = options;
  const server = await createMongoMemory(memory);
  // Each env gets its OWN database — on a shared server (`uri` / MONGODB_URI)
  // too — so suites never see each other's runs.
  const dbName = options.dbName ?? `streamline-test-${process.pid}-${(++envSeq).toString(36)}`;
  const connection = await createConnection(server.uri, {
    dbName,
    monitorCommands: true,
  }).asPromise();
  const container = createContainer({ ...containerOptions, connection });
  const runModel = container.repository.runModel;
  await container.syncRetentionIndexes();
  await container.concurrencyCounterRepository.Model.init();

  // ── command monitoring (trace) ──
  type Pending = {
    name: string;
    collection?: string;
    command: Record<string, unknown>;
    sent: number;
  };
  let recording: TracedCommand[] | null = null;
  const inflight = new Map<number, Pending>();
  // The driver via mongoose (`mongodb` is mongoose's dependency, not ours).
  const { BSON } = mongo;
  const client = connection.getClient();
  client.on('commandStarted', (e) => {
    if (!recording || IGNORED_COMMANDS.has(e.commandName)) return;
    const target = e.command[e.commandName];
    inflight.set(e.requestId, {
      name: e.commandName,
      ...(typeof target === 'string' ? { collection: target } : {}),
      command: e.command as Record<string, unknown>,
      sent: BSON.calculateObjectSize(e.command),
    });
  });
  client.on('commandSucceeded', (e) => {
    const started = inflight.get(e.requestId);
    if (!started || !recording) return;
    inflight.delete(e.requestId);
    recording.push({
      name: started.name,
      ...(started.collection !== undefined ? { collection: started.collection } : {}),
      command: started.command,
      bytesSent: started.sent,
      bytesReceived: e.reply ? BSON.calculateObjectSize(e.reply) : 0,
    });
  });

  // ── workflows + extra containers (all torn down by clear()) ──
  let seq = 0;
  const workflows = new Set<{ shutdown(): void }>();
  const extraContainers = new Set<StreamlineContainer>();
  const workflowIdOf = (wf: WorkflowRef) => (typeof wf === 'string' ? wf : wf.engine.definition.id);
  const newContainer = (opts: Omit<ContainerOptions, 'connection'> = {}) => {
    const extra = createContainer({ ...containerOptions, ...opts, connection });
    extraContainers.add(extra);
    return extra;
  };
  /** Drop a run from every engine cache this env owns. */
  const forget = (runId: string) => {
    container.cache.delete(runId);
    for (const c of extraContainers) c.cache.delete(runId);
  };
  const shutdownAll = () => {
    for (const wf of workflows) wf.shutdown();
    workflows.clear();
    for (const c of extraContainers) c.dispose();
    extraContainers.clear();
  };

  /** Retry `check` (throws or returns false = not yet) until it passes or `timeout`; returns its value. */
  async function eventually<T>(
    check: () => T | Promise<T>,
    opts: UntilOptions = {},
  ): Promise<Exclude<T, false>> {
    const timeout = opts.timeout ?? 5000;
    const interval = opts.interval ?? 20;
    const deadline = Date.now() + timeout;
    for (;;) {
      let failure: unknown;
      try {
        const value = await check();
        if (value !== false) return value as Exclude<T, false>;
        failure = new Error('check returned false');
      } catch (err) {
        failure = err;
      }
      if (Date.now() >= deadline) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        const what = opts.message ? `${opts.message}: ` : '';
        throw new Error(`eventually(): ${what}not satisfied within ${timeout}ms — ${reason}`, {
          cause: failure,
        });
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ── fixtures ──
  function baseDoc(wf: WorkflowRef, fields: RunFields): Record<string, unknown> {
    const now = new Date();
    const definition = typeof wf === 'string' ? undefined : wf.engine.definition;
    const stepIds = definition?.steps.map((s) => s.id) ?? ['step'];
    const steps: StepState[] = stepIds.map((stepId) => ({
      stepId,
      status: 'pending',
      attempts: 0,
    }));
    return {
      _id: `run-${Date.now().toString(36)}-${(++seq).toString(36)}`,
      workflowId: workflowIdOf(wf),
      ...(definition ? { definitionVersion: definition.version } : {}),
      status: 'running',
      steps,
      currentStepId: stepIds[0],
      context: {},
      input: {},
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
  }

  async function insert(wf: WorkflowRef, fields: RunFields = {}): Promise<WorkflowRun> {
    const doc = baseDoc(wf, fields);
    await runModel.collection.insertOne(doc as never);
    return (await runs.get(doc._id as string)) as WorkflowRun;
  }

  /** Steps with `patch` applied to `stepId` (and `before` marked done, in order). */
  function stepsWith(
    wf: WorkflowRef,
    stepId: string | undefined,
    patch: Partial<StepState>,
    before: { done?: string[] } = {},
  ): { steps: StepState[]; currentStepId: string } {
    const { steps } = baseDoc(wf, {}) as { steps: StepState[] };
    const target = stepId ?? steps[0]?.stepId ?? 'step';
    const at = new Date(Date.now() - LONG_AGO);
    return {
      currentStepId: target,
      steps: steps.map((s) => {
        if (before.done?.includes(s.stepId)) {
          return {
            ...s,
            status: 'done',
            attempts: 1,
            startedAt: at,
            endedAt: at,
            output: { ok: true },
          };
        }
        return s.stepId === target ? { ...s, startedAt: at, ...patch } : s;
      }),
    };
  }

  const past = () => new Date(Date.now() - 1000);
  const longAgo = () => new Date(Date.now() - LONG_AGO);

  const runs: RunFixtures = {
    insert,
    staleRunning: (wf, opts = {}) =>
      insert(wf, {
        status: 'running',
        lastHeartbeat: new Date(Date.now() - (opts.heartbeatAgeMs ?? LONG_AGO)),
        ...stepsWith(wf, opts.step, { status: 'running', attempts: 1 }),
      }),
    retryDue: (wf, opts = {}) =>
      insert(wf, {
        status: 'waiting',
        ...stepsWith(wf, opts.step, { status: 'pending', attempts: 1, retryAfter: past() }),
      }),
    timerDue: (wf, opts = {}) =>
      insert(wf, {
        status: 'waiting',
        ...stepsWith(wf, opts.step, {
          status: 'waiting',
          attempts: 1,
          waitingFor: { type: 'timer', reason: 'sleep', resumeAt: past() },
        }),
      }),
    waitingFor: (wf, eventName, opts = {}) =>
      insert(wf, {
        status: 'waiting',
        ...stepsWith(wf, opts.step, {
          status: 'waiting',
          attempts: 1,
          waitingFor: { type: 'event', reason: `Waiting for ${eventName}`, eventName },
        }),
      }),
    scheduledDue: (wf) => {
      const at = past();
      return insert(wf, {
        status: 'draft',
        scheduling: {
          executionTime: at,
          scheduledFor: at.toISOString(),
          localTimeDisplay: at.toISOString(),
          timezone: 'UTC',
          isDSTTransition: false,
        },
      });
    },
    failedAwaitingCompensation: (wf, opts) =>
      insert(wf, {
        status: 'failed',
        compensationDue: true,
        updatedAt: longAgo(),
        ...stepsWith(
          wf,
          opts.failed,
          { status: 'failed', attempts: 1, error: { message: 'failed' } },
          { done: opts.done },
        ),
      }),
    staleCompensating: (wf, opts) =>
      insert(wf, {
        status: 'compensating',
        lastHeartbeat: longAgo(),
        updatedAt: longAgo(),
        ...stepsWith(
          wf,
          opts.failed,
          { status: 'failed', attempts: 1, error: { message: 'failed' } },
          { done: opts.done },
        ),
      }),
    get: async (runId) =>
      (await runModel.collection.findOne({ _id: runId as never })) as WorkflowRun | null,
    async update(runId, update) {
      const isOperatorDoc = Object.keys(update).some((k) => k.startsWith('$'));
      await runModel.collection.updateOne(
        { _id: runId as never },
        (isOperatorDoc ? update : { $set: update }) as never,
      );
      forget(runId);
      return runs.get(runId);
    },
    async makeDue(runId) {
      const run = await runs.get(runId);
      if (!run) return null;
      const at = past();
      const set: Record<string, unknown> = {};
      run.steps.forEach((s, i) => {
        if (s.stepId !== run.currentStepId) return;
        if (s.retryAfter) set[`steps.${i}.retryAfter`] = at;
        if (s.waitingFor?.resumeAt) set[`steps.${i}.waitingFor.resumeAt`] = at;
        if (s.waitingFor?.nextReconcileAt) set[`steps.${i}.waitingFor.nextReconcileAt`] = at;
      });
      if (run.scheduling?.executionTime) set['scheduling.executionTime'] = at;
      if (Object.keys(set).length === 0) {
        throw new Error(
          `makeDue(${runId}): nothing to make due — status "${run.status}" at step "${run.currentStepId}" ` +
            'has no retryAfter / resumeAt / nextReconcileAt / scheduled executionTime',
        );
      }
      return runs.update(runId, { $set: set });
    },
  };

  let closed = false;

  const env: StreamlineTestEnv = {
    connection,
    uri: server.uri,
    container,
    runModel,
    runs,

    workflow(name, config) {
      const wf = createWorkflow(`${name}-${++seq}`, {
        autoExecute: false,
        container,
        ...config,
      });
      workflows.add(wf);
      return wf;
    },

    async until(runId, until, opts = {}) {
      const timeout = opts.timeout ?? 5000;
      const interval = opts.interval ?? 20;
      const matches =
        typeof until === 'function' ? until : (run: WorkflowRun) => run.status === until;
      const deadline = Date.now() + timeout;
      let last: WorkflowRun | null = null;
      for (;;) {
        last = await runs.get(runId);
        if (last && matches(last)) return last;
        if (Date.now() >= deadline) {
          const want = typeof until === 'function' ? 'the predicate' : `status "${until}"`;
          throw new Error(
            `until(${runId}): ${want} not reached within ${timeout}ms — last status ` +
              `"${last?.status ?? 'missing'}"${last?.currentStepId ? ` at step "${last.currentStepId}"` : ''}`,
          );
        }
        await new Promise((r) => setTimeout(r, interval));
      }
    },

    eventually,

    async untilCount(filter, count, opts = {}) {
      let found: WorkflowRun[] = [];
      await eventually(async () => {
        found = (await runModel.collection.find(filter).toArray()) as unknown as WorkflowRun[];
        if (found.length < count) throw new Error(`${found.length} of ${count} runs match`);
      }, opts);
      return found;
    },

    worker(wf, config) {
      const other = createWorkflow(wf.engine.definition.id, {
        autoExecute: false,
        ...config,
        container: newContainer(),
      });
      workflows.add(other);
      return other;
    },

    redefine(wf, config) {
      const next = createWorkflow(wf.engine.definition.id, {
        autoExecute: false,
        container,
        ...config,
      });
      workflows.add(next);
      return next;
    },

    createContainer: newContainer,

    async counter(wf, key) {
      const doc = await container.concurrencyCounterRepository.getCounter(
        makeCounterId(workflowIdOf(wf), key),
      );
      return doc
        ? { count: doc.count, limit: doc.limit, ...(doc.rev !== undefined ? { rev: doc.rev } : {}) }
        : null;
    },

    async tick(wf) {
      await wf.engine.pollScheduler();
    },

    async trace(fn) {
      const commands: TracedCommand[] = [];
      recording = commands;
      let result: Awaited<ReturnType<typeof fn>>;
      try {
        result = await fn();
      } finally {
        recording = null;
      }
      return {
        result,
        commands,
        writes: commands.filter((c) => WRITE_COMMANDS.has(c.name)).length,
        reads: commands.filter((c) => READ_COMMANDS.has(c.name)).length,
        bytesSent: commands.reduce((sum, c) => sum + c.bytesSent, 0),
        bytesReceived: commands.reduce((sum, c) => sum + c.bytesReceived, 0),
        updatesTo: (runId) => updatesTo(commands, runId),
        readsOf: (runId) => commands.filter((c) => READ_COMMANDS.has(c.name) && mentions(c, runId)),
      };
    },

    async clear() {
      shutdownAll();
      container.cache.clear();
      const collections = await connection.db?.collections();
      await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
    },

    async close() {
      if (closed) return;
      closed = true;
      shutdownAll();
      container.dispose();
      // On a shared server the database is ours alone — drop it, leave no trace.
      if (!server.server) await connection.db?.dropDatabase().catch(() => undefined);
      await connection.close().catch(() => undefined);
      await server.stop();
    },
  };
  return env;
}
