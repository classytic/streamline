/**
 * Global Vitest setup — runs once before all test files in each worker.
 *
 *  - Suppresses MongoKit keyset pagination index-hint warnings. Heuristic DX
 *    hints, not errors — just noisy in tests.
 *  - Registers a worker-level teardown so mongodb-memory-server shuts down
 *    cleanly when the test worker exits (individual test files should not
 *    call `teardownTestDB` in their own afterAll — inconsistent cleanup
 *    across files caused "different connection strings" races).
 */
import { afterAll } from 'vitest';
import { configureLogger } from '@classytic/mongokit';
import { teardownTestDB } from './utils/setup.js';

configureLogger(false);

afterAll(async () => {
  await teardownTestDB();
});
