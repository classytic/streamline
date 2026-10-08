/**
 * Vitest global setup — ONE in-memory MongoDB for the whole run.
 *
 * Every `useStreamlineEnv()` (test/helpers/env.ts) connects to it with its own
 * database, so files stay isolated without paying a server boot per file.
 * Published as `STREAMLINE_TEST_MONGODB_URI` — deliberately not `MONGODB_URI`,
 * which older tests read as a fallback for the global mongoose connection.
 * A real cluster can be supplied by setting the variable before the run.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

let server: MongoMemoryServer | undefined;

export async function setup(): Promise<void> {
  if (process.env.STREAMLINE_TEST_MONGODB_URI) return;
  server = await MongoMemoryServer.create({ binary: { version: '7.0.0' } });
  process.env.STREAMLINE_TEST_MONGODB_URI = server.getUri();
}

export async function teardown(): Promise<void> {
  await server?.stop();
}
