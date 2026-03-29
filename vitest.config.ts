import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/vitest-setup.ts'],
    // Run test files sequentially to prevent MongoDB conflicts
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'test/**',
        '*.config.*',
        'docs/**',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 60000, // Increased for MongoDB memory server download
  },
});
