/**
 * Which `workflow_runs` indexes does the ENGINE actually use? Runs a mixed
 * workload — executions, retries, sleeps/timers, waits + signals, scheduled
 * drafts, idempotent starts, child workflows, scheduler sweeps (scoped) — then
 * prints `$indexStats` accesses per index. An index with zero accesses is pure
 * write cost for the engine (hosts may still query it — check before dropping).
 *
 *   npm run build && node bench/index-usage.mjs
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createContainer, createWorkflow, WorkflowRunModel } from '../dist/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await MongoMemoryServer.create({ binary: { version: '7.0.0' } });
try {
  await mongoose.connect(server.getUri());
  await WorkflowRunModel.syncIndexes();
  const container = createContainer();
  const scheduler = { basePollInterval: 50, minPollInterval: 50, staleCheckInterval: 200 };

  let flaky = 0;
  const child = createWorkflow('iu-child', {
    steps: { only: async () => 'child' },
    container,
    scheduler,
  });
  const wf = createWorkflow('iu-main', {
    steps: {
      a: async () => ({ ok: 1 }),
      retry: { handler: async () => { if (flaky++ % 2 === 0) throw new Error('flaky'); return 1; }, retries: 3, retryDelay: 20 },
      nap: async (ctx) => ctx.sleep(30),
      kid: async (ctx) => ctx.startChildWorkflow('iu-child', {}),
      gate: async (ctx) => ctx.waitFor('go'),
      z: async () => 'z',
    },
    container,
    scheduler,
    concurrency: { key: (i) => i.k, limit: 2 },
  });

  const runs = [];
  for (let i = 0; i < 60; i++) {
    runs.push(await wf.start({ k: `k${i % 10}` }, { idempotencyKey: `idem-${i}` }));
    await wf.start({ k: `k${i % 10}` }, { idempotencyKey: `idem-${i}` }); // dedupe hit
  }
  await sleep(3000);
  for (const r of runs) await wf.signal(r._id, 'go', 1).catch(() => undefined);
  await sleep(2000);

  const stats = await WorkflowRunModel.collection
    .aggregate([{ $indexStats: {} }, { $project: { name: 1, ops: '$accesses.ops' } }])
    .toArray();
  const done = await WorkflowRunModel.countDocuments({ workflowId: 'iu-main', status: 'done' });
  console.log(`main runs done: ${done}/${runs.length}\n`);
  for (const s of stats.sort((a, b) => Number(b.ops) - Number(a.ops))) {
    console.log(`${String(s.ops).padStart(7)}  ${s.name}`);
  }
  wf.shutdown();
  child.shutdown();
} finally {
  await mongoose.disconnect();
  await server.stop();
}
