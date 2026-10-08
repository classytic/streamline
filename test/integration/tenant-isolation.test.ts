/**
 * Multi-tenant isolation on the public workflow control API (review round 4).
 *
 * F1 — possession of a foreign tenant's `runId` must NOT allow reading or
 *      controlling that run: the control methods scope the initial lookup to
 *      the caller's tenant (a foreign runId reads as not-found), and the
 *      run cache is tenant-validated so a cached cross-tenant hit isn't leaked.
 * F2 — an ordinary idempotency key is unique PER TENANT, not globally: two
 *      tenants may use the same key concurrently without a cross-tenant E11000.
 */

import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv({
  container: { repository: { tenant: { tenantField: 'context.tenantId', required: true } } },
});

function tenantWorkflow(name: string) {
  // autoExecute: false (the env default) — the run stays 'running'
  // (non-terminal), so it is cancellable + idempotency-active.
  return env.workflow<{ tenantId: string }, { tenantId: string }>(name, {
    steps: { work: async () => 'done' },
    context: (input) => ({ tenantId: input.tenantId }),
  });
}

describe('Multi-tenant isolation — control API', () => {
  it('F1: a foreign tenant cannot get or cancel another tenant’s run', async () => {
    const wf = tenantWorkflow('iso-control');
    const run = await wf.start({ tenantId: 'org-A' }, { tenantId: 'org-A' });

    // READ — cross-tenant is invisible (validated even on the cache hit).
    expect(await wf.get(run._id, { tenantId: 'org-B' })).toBeNull();
    expect((await wf.get(run._id, { tenantId: 'org-A' }))?._id).toBe(run._id);
    expect((await wf.get(run._id, { bypassTenant: true }))?._id).toBe(run._id); // admin

    // MUTATE — a foreign tenant is denied (reads as not-found) and the run is untouched.
    await expect(wf.cancel(run._id, { tenantId: 'org-B' })).rejects.toThrow();
    await expect(wf.pause(run._id, { tenantId: 'org-B' })).rejects.toThrow();
    const stillActive = await wf.get(run._id, { bypassTenant: true });
    expect(stillActive?.status).not.toBe('cancelled');

    // Same tenant → allowed.
    const cancelled = await wf.cancel(run._id, { tenantId: 'org-A', reason: 'test' });
    expect(cancelled.status).toBe('cancelled');
  });

  it('F2: the same idempotency key is unique PER TENANT (no cross-tenant collision)', async () => {
    const wf = tenantWorkflow('iso-idempotency');
    await env.runModel.syncIndexes(); // ensure the compound unique index is built

    const key = 'order-42';
    const a = await wf.start({ tenantId: 'org-A' }, { tenantId: 'org-A', idempotencyKey: key });
    // Different tenant, SAME key → must NOT collide.
    const b = await wf.start({ tenantId: 'org-B' }, { tenantId: 'org-B', idempotencyKey: key });
    expect(b._id).not.toBe(a._id);

    // Same tenant + same key → idempotent (returns the existing run).
    const aAgain = await wf.start(
      { tenantId: 'org-A' },
      { tenantId: 'org-A', idempotencyKey: key },
    );
    expect(aAgain._id).toBe(a._id);
  });
});
