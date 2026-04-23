/**
 * Mock factories — pure factory functions for external-service mocks.
 *
 * Rule: consume these from inside a hoisted `vi.mock(...)` factory using the
 * async dynamic import pattern (see testing-infrastructure.md §5):
 *
 * ```ts
 * vi.mock('@external/some-sdk', async () =>
 *   (await import('../helpers/mocks.js')).mockSomeSdk(),
 * );
 * ```
 *
 * Do NOT do `import { mockSomeSdk } from '../helpers/mocks.js'` then use it
 * in `vi.mock(...)` — vitest hoists the mock above the import, so the helper
 * is undefined at mock-resolution time.
 */

import { vi } from 'vitest';

/**
 * Generic async callable mock that resolves with the given value.
 * Handy for stubbing provider calls in durable-workflow scenarios.
 */
export function mockResolved<T>(value: T) {
  return vi.fn().mockResolvedValue(value);
}

/**
 * Async callable that rejects the first `failCount` invocations then succeeds.
 * Useful for retry/recovery tests.
 */
export function mockFlaky<T>(failCount: number, successValue: T, error: Error = new Error('flaky')) {
  let calls = 0;
  return vi.fn().mockImplementation(async () => {
    calls += 1;
    if (calls <= failCount) throw error;
    return successValue;
  });
}

/**
 * A mock logger transport matching the LogTransport shape — capturing calls
 * for later assertions.
 */
export function mockLoggerTransport() {
  return {
    logs: [] as Array<{ level: string; message: string; meta?: unknown }>,
    transport: vi.fn((level: string, message: string, meta?: unknown) => {
      // captured on the parent object so tests can read .logs
    }),
  };
}
