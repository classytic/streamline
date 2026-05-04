import { defineConfig } from 'vitest/config';

/**
 * Tiered test config — aligns with docs/testing-infrastructure.md.
 *
 * Tiers:
 *   unit         — pure functions, no DB, <10s
 *   integration  — mongo-memory-server, no network, <30s
 *   e2e          — full scenarios, mongo-memory-server, <120s
 *
 * `pnpm test` runs unit + integration only (fast CI path).
 * `pnpm test:e2e` runs the slow tier on demand / nightly.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/vitest-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'dist/**', 'test/**', '*.config.*', 'docs/**'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
          // Pure functions — parallel-safe. Group 0 runs first.
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'test/integration/**/*.test.ts',
            'test/plugins/**/*.test.ts',
            'test/scheduling/**/*.test.ts',
            'test/security/**/*.test.ts',
            'test/telemetry/**/*.test.ts',
          ],
          testTimeout: 30_000,
          hookTimeout: 60_000, // mongodb-memory-server first-download tax
          // mongoose + mongodb-memory-server share a connection — fork once.
          // Vitest 4 — `poolOptions.forks.singleFork: true` migrated to
          // `maxWorkers: 1` (single worker) + `isolate: false` (no fresh
          // module state between files). mongoose + mongodb-memory-server
          // share a connection; running them in one worker avoids races.
          // Different `maxWorkers` than `unit` requires unique groupOrder.
          maxWorkers: 1,
          isolate: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: [
            'test/e2e/**/*.test.ts',
            'test/regression/**/*.test.ts',
            'test/pagination/**/*.test.ts',
            'test/core/**/*.test.ts',
            'test/review/**/*.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 60_000,
          // See `integration` — same single-worker rationale.
          maxWorkers: 1,
          isolate: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
