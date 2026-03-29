/**
 * Global Vitest setup — runs once before all test files.
 *
 * Suppresses MongoKit keyset pagination index hint warnings.
 * These are heuristic DX hints that fire on every keyset query with filters+sort,
 * regardless of whether the indexes exist. Not errors — just noisy in tests.
 */
import { configureLogger } from '@classytic/mongokit';

configureLogger(false);
