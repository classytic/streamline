/**
 * Regression for Finding #3 — emit-before-persist of `workflow:completed`.
 *
 * THE BUG: `executor.moveToNextStep` emitted `workflow:completed` BEFORE the
 * atomic `{ status:'done', output, endedAt }` write. Listeners (the strict-
 * concurrency slot-release listener, any caller resolving on completion) fired
 * while the run was still `status:'running'` with no `output` persisted. A
 * crash in that window left recovery to re-run completion → a 2nd emit + a 2nd
 * slot release, while observers had already acted on a non-durable signal.
 *
 * THE FIX: persist the terminal write FIRST, emit only AFTER it acknowledges.
 *
 * THE TEST (deterministic — no timing race): instrument the engine's event bus
 * and repository to record an ordered trace of (a) the terminal `status:'done'`
 * write and (b) the `workflow:completed` emit. Assert the durable write is
 * recorded BEFORE the emit. Pre-fix the emit comes first.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

describe('workflow:completed is emitted only AFTER the durable terminal write (Finding #3)', () => {
  it('the status:done write is recorded before the workflow:completed emit', async () => {
    const wf = env.workflow('emit-after-persist', {
      steps: {
        only: async () => ({ answer: 42 }),
      },
    });

    const trace: string[] = [];

    // Wrap the terminal write. The completion write is uniquely identifiable:
    // it is the ONLY write that sets a run-level `output` ALONG WITH
    // `status:'done'` — plain-field shape (moveToNextStep) or `$set` shape (the
    // final step's combined result+completion write). We record the moment
    // THAT write acknowledges. (Call ORDER relative to the emit is the subject,
    // so this stays an instrumented wrapper rather than `env.trace`.)
    const repo = wf.engine.container.repository;
    const origUpdateOne = repo.updateOne;
    const boundUpdateOne = origUpdateOne.bind(repo);
    (repo as unknown as { updateOne: typeof origUpdateOne }).updateOne = (async (
      filter: unknown,
      update: unknown,
      options?: unknown,
    ) => {
      const raw = update as Record<string, unknown> | undefined;
      const u = (raw?.$set as Record<string, unknown> | undefined) ?? raw;
      const isCompletionWrite = u?.status === 'done' && 'output' in (u ?? {});
      const result = await boundUpdateOne(filter as never, update as never, options as never);
      if (isCompletionWrite) trace.push('persist:output');
      return result;
    }) as typeof origUpdateOne;

    // Wrap emit: record the workflow:completed emission.
    const bus = wf.engine.container.eventBus;
    const origEmit = bus.emit;
    const boundEmit = origEmit.bind(bus);
    (bus as unknown as { emit: typeof origEmit }).emit = ((event: string, payload: unknown) => {
      if (event === 'workflow:completed') trace.push('emit:completed');
      return boundEmit(event, payload);
    }) as typeof origEmit;

    try {
      const run = await wf.start({});
      const final = await wf.execute(run._id);
      expect(final.status).toBe('done');

      // Both events occurred, and the durable completion write came FIRST.
      expect(trace).toContain('persist:output');
      expect(trace).toContain('emit:completed');
      expect(trace.indexOf('persist:output')).toBeLessThan(trace.indexOf('emit:completed'));
    } finally {
      // The env's container outlives this test — put the originals back.
      (repo as unknown as { updateOne: typeof origUpdateOne }).updateOne = origUpdateOne;
      (bus as unknown as { emit: typeof origEmit }).emit = origEmit;
    }
  });
});
