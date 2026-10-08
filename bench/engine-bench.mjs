/**
 * Streamline engine benchmarks — run against the BUILT package (`dist/`), on an
 * in-memory MongoDB 7, with driver command monitoring for wire cost.
 *
 *   npm run bench            (builds first)
 *   BENCH_RUNS=1000 npm run bench
 *
 * Sections:
 *   1. Run throughput      — N runs × 5 steps: runs/s, latency, Mongo cost per run.
 *   2. Scatter checkpoints — per-task delta writes vs whole-map rewrites (the
 *                            fallback path, i.e. the previous behaviour).
 *   3. Write replies       — bytes back per guarded write, projected vs full doc.
 *   4. Head-of-line        — one slow run among many due runs: dispatch pool vs
 *                            serial dispatch (dispatchConcurrency 1 = old poll).
 *
 * Numbers are machine-relative: compare rows within one run, not across machines.
 */

import { performance } from 'node:perf_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createContainer, createWorkflow, WorkflowRunModel } from '../dist/index.mjs';

const RUNS = Number(process.env.BENCH_RUNS ?? 300);
const PARALLEL = Number(process.env.BENCH_PARALLEL ?? 20);
const SCATTER_TASKS = Number(process.env.BENCH_SCATTER ?? 300);

// ── wire accounting ──────────────────────────────────────────────────────────
const { BSON } = mongoose.mongo;
const wire = { commands: 0, sent: 0, received: 0, updates: 0, updateSent: 0, updateReceived: 0 };
const WRITE_CMDS = new Set(['update', 'findAndModify']);
const pending = new Map();
function resetWire() {
  for (const k of Object.keys(wire)) wire[k] = 0;
}
function monitor(client) {
  client.on('commandStarted', (e) => {
    if (e.commandName === 'hello' || e.commandName === 'isMaster') return;
    const bytes = BSON.calculateObjectSize(e.command);
    wire.commands++;
    wire.sent += bytes;
    if (WRITE_CMDS.has(e.commandName)) {
      wire.updates++;
      wire.updateSent += bytes;
      pending.set(e.requestId, true);
    }
  });
  client.on('commandSucceeded', (e) => {
    if (!e.reply) return;
    const bytes = BSON.calculateObjectSize(e.reply);
    wire.received += bytes;
    if (pending.delete(e.requestId)) wire.updateReceived += bytes;
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const ms = (v) => `${v.toFixed(1)} ms`;
let seq = 0;
const uid = (p) => `${p}-${Date.now()}-${++seq}`;

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function table(title, rows) {
  console.log(`\n### ${title}\n`);
  const cols = Object.keys(rows[0]);
  console.log(`| ${cols.join(' | ')} |`);
  console.log(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(' | ')} |`);
}

// ── 1. run throughput ────────────────────────────────────────────────────────
async function benchThroughput() {
  const payload = { blob: 'x'.repeat(1024) };
  const step = async () => payload;
  const wf = createWorkflow(uid('bench-throughput'), {
    steps: { s1: step, s2: step, s3: step, s4: step, s5: step },
    container: createContainer(),
    autoExecute: false,
  });

  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await wf.start({ i }));

  resetWire();
  const latencies = [];
  const t0 = performance.now();
  await pool(runs, PARALLEL, async (run) => {
    const s = performance.now();
    const done = await wf.execute(run._id);
    if (done.status !== 'done') throw new Error(`run ${run._id} ended ${done.status}`);
    latencies.push(performance.now() - s);
  });
  const elapsed = performance.now() - t0;
  latencies.sort((a, b) => a - b);
  wf.shutdown();

  table(`1. Run throughput — ${RUNS} runs × 5 steps (1 KB output each), ${PARALLEL} in parallel`, [
    {
      'runs/s': (RUNS / (elapsed / 1000)).toFixed(0),
      p50: ms(pct(latencies, 50)),
      p95: ms(pct(latencies, 95)),
      'commands/run': (wire.commands / RUNS).toFixed(1),
      'writes/run': (wire.updates / RUNS).toFixed(1),
      'sent/run': kb(wire.sent / RUNS),
      'received/run': kb(wire.received / RUNS),
      'write replies/run': kb(wire.updateReceived / RUNS),
    },
  ]);
}

// ── 2. scatter checkpoints ───────────────────────────────────────────────────
async function benchScatter() {
  const rows = [];
  for (const [label, key] of [
    ['delta (per-task entry)', (i) => `t${i}`],
    ['whole map (fallback / previous)', (i) => `t.${i}`], // a dot forces the fallback
  ]) {
    const tasks = Object.fromEntries(
      Array.from({ length: SCATTER_TASKS }, (_, i) => [key(i), async () => ({ i, v: 'y'.repeat(256) })]),
    );
    const wf = createWorkflow(uid('bench-scatter'), {
      steps: { fan: async (ctx) => ctx.scatter(tasks, { concurrency: 8 }) },
      container: createContainer(),
      autoExecute: false,
    });
    const run = await wf.start({});
    resetWire();
    const t0 = performance.now();
    const done = await wf.execute(run._id);
    const elapsed = performance.now() - t0;
    if (done.status !== 'done') throw new Error(`scatter ended ${done.status}`);
    rows.push({
      mode: label,
      time: ms(elapsed),
      writes: wire.updates,
      'bytes written': kb(wire.updateSent),
      'per task': kb(wire.updateSent / SCATTER_TASKS),
    });
    wf.shutdown();
  }
  table(`2. Scatter checkpoints — ${SCATTER_TASKS} tasks × ~300 B results`, rows);
}

// ── 3. write replies ─────────────────────────────────────────────────────────
async function benchReplies() {
  // A realistic finished run: 5 steps with 1 KB outputs.
  const wf = createWorkflow(uid('bench-replies'), {
    steps: Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e'].map((s) => [s, async () => ({ blob: 'z'.repeat(1024) })]),
    ),
    container: createContainer(),
    autoExecute: false,
  });
  const run = await wf.start({});
  await wf.execute(run._id);
  wf.shutdown();

  const N = 200;
  const rows = [];
  for (const [label, select] of [
    ['projected `_id` (now)', '_id'],
    ['full document (previous)', undefined],
  ]) {
    resetWire();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const q = WorkflowRunModel.findOneAndUpdate(
        { _id: run._id },
        { $set: { lastHeartbeat: new Date() } },
        { returnDocument: 'after' },
      );
      await (select ? q.select(select) : q).lean();
    }
    rows.push({
      reply: label,
      'bytes back/write': `${Math.round(wire.updateReceived / N)} B`,
      'time/write': ms((performance.now() - t0) / N),
    });
  }
  table('3. Guarded write replies — heartbeat-style update on a 5-step run', rows);
}

// ── 4. head-of-line ──────────────────────────────────────────────────────────
async function benchHeadOfLine() {
  const DUE = 20;
  const SLOW_MS = 1500;
  const rows = [];
  for (const dispatchConcurrency of [1, 10]) {
    const id = uid('bench-hol');
    // DUE runs are already due when the worker boots; the FIRST picked up is slow.
    const past = new Date(Date.now() - 60_000);
    const fast = [];
    for (let i = 0; i < DUE; i++) {
      const _id = `${id}-${String(i).padStart(2, '0')}`;
      if (i > 0) fast.push(_id);
      await WorkflowRunModel.create({
        _id,
        workflowId: id,
        definitionVersion: '1.0.0',
        status: 'waiting',
        currentStepId: 'work',
        steps: [{ stepId: 'work', status: 'pending', attempts: 1, retryAfter: past }],
        context: {},
        input: { ms: i === 0 ? SLOW_MS : 5 },
        createdAt: new Date(past.getTime() - (DUE - i)), // oldest first → slow one first
        updatedAt: new Date(past.getTime() - (DUE - i)),
      });
    }

    // Booting the engine finds the due work and starts polling on its own.
    const t0 = performance.now();
    const wf = createWorkflow(id, {
      steps: { work: async (ctx) => sleep(ctx.input.ms) },
      container: createContainer(),
      autoExecute: false,
      scheduler: { basePollInterval: 50, minPollInterval: 50, adaptivePolling: false, dispatchConcurrency },
    });
    let fastDone = 0;
    while (performance.now() - t0 < 30_000) {
      fastDone = await WorkflowRunModel.countDocuments({ _id: { $in: fast }, status: 'done' });
      if (fastDone === fast.length) break;
      await sleep(10);
    }
    rows.push({
      dispatchConcurrency: dispatchConcurrency === 1 ? '1 (serial — previous poll)' : String(dispatchConcurrency),
      [`${fast.length} fast runs done after`]: ms(performance.now() - t0),
    });
    wf.shutdown();
    await sleep(SLOW_MS); // let the slow handler settle before the next round
  }
  table(`4. Head-of-line — ${DUE} due runs, the first takes ${SLOW_MS} ms`, rows);
}

// ── main ─────────────────────────────────────────────────────────────────────
const server = await MongoMemoryServer.create({ binary: { version: '7.0.0' } });
try {
  await mongoose.connect(server.getUri(), { monitorCommands: true });
  monitor(mongoose.connection.getClient());
  await WorkflowRunModel.syncIndexes();

  console.log(`# Streamline engine benchmarks (node ${process.version}, MongoDB 7 in-memory)`);
  await benchThroughput();
  await benchScatter();
  await benchReplies();
  await benchHeadOfLine();
} finally {
  await mongoose.disconnect();
  await server.stop();
}
