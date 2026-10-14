/**
 * An aborted attempt releases its caller — even when the handler ignores
 * `ctx.signal`. JS cannot stop such a handler; the engine just stops waiting
 * for it. Before, `execute()` after `cancel()` blocked until the handler
 * returned on its own (a 5 s step meant a 5 s wait for an already-cancelled run).
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** A step that never looks at `ctx.signal` and takes `ms` to finish. */
const deaf = (ms: number, entered: () => void) => async () => {
  entered();
  await new Promise((r) => setTimeout(r, ms));
  return 'finished anyway';
};

describe('aborted attempts release the caller', () => {
  it('cancel(): execute() returns at once, the run stays cancelled', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const wf = env.workflow('deaf-cancel', {
      steps: { slow: deaf(3_000, enter), next: async () => 'x' },
    });
    const run = await wf.start({});

    const executing = wf.execute(run._id);
    await entered;
    const cancelledAt = Date.now();
    await wf.cancel(run._id);

    const result = await executing;
    expect(Date.now() - cancelledAt).toBeLessThan(1_000); // not the 3 s the handler takes
    expect(result.status).toBe('cancelled');

    // The handler finishing later changes nothing.
    await new Promise((r) => setTimeout(r, 3_200));
    const stored = await env.runs.get(run._id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.steps.find((s) => s.stepId === 'next')?.status).toBe('pending');
  }, 10_000);

  it('a step timeout releases the caller even if the handler ignores it', async () => {
    const wf = env.workflow('deaf-timeout', {
      steps: { slow: { handler: deaf(3_000, () => {}), timeout: 100, retries: 1 } },
    });
    const run = await wf.start({});

    const startedAt = Date.now();
    const result = await wf.execute(run._id);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.message).toMatch(/timeout after 100ms/);
  }, 10_000);
});
