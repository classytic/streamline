/**
 * Durable signals — `signal(runId, name, data)` is never lost to timing.
 *
 * A bus event (`eventBus.emit`) only reaches a run whose listener is live in
 * this process at that instant. `signal()` stores into the run's inbox and is
 * consumed by the matching `ctx.waitFor(name)`, whichever comes first, in the
 * same atomic write that completes the wait.
 */

import { describe, expect, it } from 'vitest';
import { InvalidStateError, type WorkflowConfig } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

/** prep → gate (waits for `approved`) → after. */
const approvalSteps: WorkflowConfig<Record<string, unknown>>['steps'] = {
  prep: async () => 'prepped',
  gate: async (ctx) => ctx.waitFor('approved'),
  after: async (ctx) => ({ got: ctx.getOutput('gate') }),
};
const approvalFlow = () => env.workflow('approval', { steps: approvalSteps });

describe('durable signals', () => {
  it('a signal sent BEFORE the run reaches waitFor is queued, then consumed', async () => {
    const wf = approvalFlow();
    const run = await wf.start({});

    const sent = await wf.signal(run._id, 'approved', { by: 'ops' });
    expect(sent.status).toBe('queued');

    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');
    expect(result.output).toEqual({ got: { by: 'ops' } });
    expect((await env.runs.get(run._id))?.signals ?? []).toEqual([]);
  });

  it('a signal to a run already waiting is delivered immediately', async () => {
    const wf = approvalFlow();
    const run = await wf.start({});
    expect((await wf.execute(run._id)).status).toBe('waiting');

    const sent = await wf.signal(run._id, 'approved', 42);
    expect(sent.status).toBe('delivered');
    expect(sent.run.status).toBe('done');
    expect(sent.run.output).toEqual({ got: 42 });
  });

  it('reaches a waiting run after a restart, where a bus event is lost', async () => {
    const first = approvalFlow();
    const run = await first.start({});
    await first.execute(run._id);
    first.shutdown(); // the process holding the listener is gone

    // A fresh process: same workflow id, no listener for this run.
    const second = env.redefine(first, { steps: approvalSteps });
    second.container.eventBus.emit('approved', { runId: run._id, data: 'via-bus' });
    await expect(env.until(run._id, 'done', { timeout: 100 })).rejects.toThrow(
      /last status "waiting"/,
    );

    const sent = await second.signal(run._id, 'approved', 'via-signal');
    expect(sent.status).toBe('delivered');
    expect(sent.run.output).toEqual({ got: 'via-signal' });
  });

  it('a pending signalId is idempotent; a terminal run refuses', async () => {
    const wf = approvalFlow();
    const run = await wf.start({});

    expect((await wf.signal(run._id, 'approved', 1, { signalId: 'req-1' })).status).toBe('queued');
    expect((await wf.signal(run._id, 'approved', 2, { signalId: 'req-1' })).status).toBe(
      'duplicate',
    );
    expect((await env.runs.get(run._id))?.signals).toHaveLength(1);

    const done = await wf.execute(run._id);
    expect(done.output).toEqual({ got: 1 });
    await expect(wf.signal(run._id, 'approved', 3)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('the scheduler sweep delivers a signal stranded by a crash after the push', async () => {
    const wf = approvalFlow();
    // Crash window: the run is waiting, the signal was pushed, never delivered.
    const run = await env.runs.waitingFor(wf, 'approved', { step: 'gate' });
    await env.container.repository.pushSignal(
      run._id,
      { id: 's1', name: 'approved', data: 'late', at: new Date() },
      100,
      { dedupe: false },
    );
    // A signal for a LATER wait is not "ready" — the sweep must skip it.
    const other = await env.runs.waitingFor(wf, 'approved', { step: 'gate' });
    await env.container.repository.pushSignal(
      other._id,
      { id: 's2', name: 'something-else', at: new Date() },
      100,
      { dedupe: false },
    );

    const ready = await env.container.repository.getSignalReadyRuns(10, {
      bypassTenant: true,
      workflowId: wf.engine.definition.id,
    });
    expect(ready.map((r) => r._id)).toEqual([run._id]);

    await env.tick(wf);
    expect((await env.until(run._id, 'done')).output).toEqual({ got: 'late' });
    expect((await env.runs.get(other._id))?.status).toBe('waiting');
  });

  it('the sweep query tolerates waiting runs that never had a signal', async () => {
    // `$in` throws on a missing array; an unguarded `$expr` failed every poll.
    const wf = approvalFlow();
    const run = await env.runs.waitingFor(wf, 'approved', { step: 'gate' });
    expect((await env.runs.get(run._id))?.signals).toBeUndefined();

    const repo = env.container.repository;
    await expect(
      repo.getSignalReadyRuns(10, { bypassTenant: true, workflowId: wf.engine.definition.id }),
    ).resolves.toEqual([]);
    await expect(repo.getSignalReadyRuns(10, { bypassTenant: true })).resolves.toEqual([]);
  });

  it('two concurrent signals to one wait: one is delivered, the other stays queued', async () => {
    const wf = approvalFlow();
    const run = await wf.start({});
    await wf.execute(run._id);

    const results = await Promise.all([
      wf.signal(run._id, 'approved', 'A'),
      wf.signal(run._id, 'approved', 'B'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['delivered', 'queued']);

    const stored = await env.runs.get(run._id);
    expect(stored?.status).toBe('done');
    const output = stored?.output as { got: string };
    const got = output.got;
    expect(stored?.signals?.map((s) => s.data)).toEqual([got === 'A' ? 'B' : 'A']);
  });

  it('a paused run keeps the signal; operator resume delivers it, not undefined', async () => {
    const wf = approvalFlow();
    const run = await wf.start({});
    await wf.execute(run._id);
    await wf.pause(run._id);

    expect((await wf.signal(run._id, 'approved', 'kept')).status).toBe('queued');
    expect((await env.runs.get(run._id))?.status).toBe('waiting');

    const resumed = await wf.resumeOperator(run._id);
    expect(resumed.status).toBe('done');
    expect(resumed.output).toEqual({ got: 'kept' });
  });
});
