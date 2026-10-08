/**
 * Vitest wiring for `@classytic/streamline/testkit` — how streamline's own
 * suite uses the harness it ships (dogfooding: the engine's tests exercise the
 * same testkit hosts use).
 *
 *   const env = useStreamlineEnv();
 *
 *   it('…', async () => {
 *     const wf = env.workflow('approval', { steps: { … } });
 *     …
 *     await env.until(run._id, 'done');
 *   });
 *
 * One env per file (`beforeAll`), emptied after each test, closed after the
 * file. Every env is its own database on the run's shared server
 * (test/global-setup.ts), so files never see each other's runs.
 */

import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  createStreamlineTestEnv,
  type StreamlineTestEnv,
  type StreamlineTestEnvOptions,
} from '../../src/testkit/index.js';

export function useStreamlineEnv(options: StreamlineTestEnvOptions = {}): StreamlineTestEnv {
  let current: StreamlineTestEnv | undefined;

  beforeAll(async () => {
    current = await createStreamlineTestEnv({
      ...(process.env.STREAMLINE_TEST_MONGODB_URI && {
        uri: process.env.STREAMLINE_TEST_MONGODB_URI,
      }),
      ...options,
    });
  });
  afterEach(async () => {
    await current?.clear();
  });
  afterAll(async () => {
    await current?.close();
  });

  // The env exists only after `beforeAll`; hand back a forwarder so a file can
  // hold `env` at module scope and use it inside tests. No binding: the env's
  // methods are closures, and some members are functions that must stay
  // themselves (`runModel` is a mongoose Model).
  return new Proxy({} as StreamlineTestEnv, {
    get(_, prop) {
      if (!current) {
        throw new Error(
          `useStreamlineEnv(): env.${String(prop)} used outside a test — the env boots in beforeAll`,
        );
      }
      return current[prop as keyof StreamlineTestEnv];
    },
  });
}
