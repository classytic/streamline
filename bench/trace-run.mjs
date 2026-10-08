/**
 * Trace every MongoDB command ONE 5-step run's `execute()` sends — the reply
 * size and the streamline call sites behind it. For finding avoidable reads.
 *
 *   npm run build && node bench/trace-run.mjs
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createContainer, createWorkflow } from '../dist/index.mjs';

const server = await MongoMemoryServer.create({ binary: { version: '7.0.0' } });
try {
  await mongoose.connect(server.getUri(), { monitorCommands: true });
  const { BSON } = mongoose.mongo;
  const client = mongoose.connection.getClient();
  const started = new Map();
  const log = [];
  let tracing = false;

  client.on('commandStarted', (e) => {
    if (!tracing || e.commandName === 'hello') return;
    // Async stacks: keep only streamline frames so the call site is readable.
    const sites = (new Error().stack ?? '')
      .split('\n')
      .filter((l) => l.includes('/dist/') || l.includes('\\dist\\'))
      .slice(0, 4)
      .map((l) => l.trim().replace(/^at /, '').replace(/\(.*dist[\\/]/, '(').replace(/\)$/, ')'));
    const filter = e.command.filter ?? e.command.query ?? e.command.updates?.[0]?.q ?? {};
    started.set(e.requestId, { cmd: e.commandName, filter: JSON.stringify(filter).slice(0, 70), sites });
  });
  client.on('commandSucceeded', (e) => {
    const s = started.get(e.requestId);
    if (s) log.push({ ...s, reply: BSON.calculateObjectSize(e.reply) });
  });

  const step = async () => ({ blob: 'x'.repeat(1024) });
  const wf = createWorkflow('trace', {
    steps: { s1: step, s2: step, s3: step, s4: step, s5: step },
    container: createContainer(),
    autoExecute: false,
  });
  const run = await wf.start({});
  tracing = true;
  await wf.execute(run._id);
  tracing = false;
  wf.shutdown();

  for (const l of log) {
    console.log(`${l.cmd.padEnd(14)} ${String(l.reply).padStart(6)} B  ${l.filter}`);
    for (const s of l.sites) console.log(`      ${s}`);
  }
  const reads = log.filter((l) => l.cmd === 'find' || l.cmd === 'aggregate');
  console.log(
    `\n${log.length} commands · ${reads.length} reads (${reads.reduce((a, l) => a + l.reply, 0)} B back)`,
  );
} finally {
  await mongoose.disconnect();
  await server.stop();
}
