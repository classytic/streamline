/**
 * Lifecycle helpers — composed beforeAll/afterAll/afterEach hooks.
 *
 * Prefer these over calling setupTestDB / cleanupTestDB inline in every file.
 * Keeps the hook order consistent across every integration & e2e test.
 */

import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanupTestDB, setupTestDB, teardownTestDB } from '../utils/setup.js';

/**
 * Register lifecycle hooks for a test file that needs MongoDB.
 *
 * - Starts mongodb-memory-server once per worker (idempotent).
 * - Clears all collections after each test (fresh state).
 * - Tears down at end of run.
 *
 * @example
 * ```ts
 * import { useTestDb } from '../helpers/lifecycle.js';
 *
 * describe('my feature', () => {
 *   useTestDb();
 *   it('does the thing', async () => { ... });
 * });
 * ```
 */
export function useTestDb(): void {
  beforeAll(setupTestDB);
  afterEach(cleanupTestDB);
  afterAll(teardownTestDB);
}

/**
 * Same as useTestDb but keeps data between tests (for scenario tests that
 * build on prior state). Use sparingly — parallelisation will expose coupling.
 */
export function useTestDbPersistent(): void {
  beforeAll(setupTestDB);
  afterAll(teardownTestDB);
}
