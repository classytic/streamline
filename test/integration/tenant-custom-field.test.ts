/**
 * Custom multi-tenant field wiring (review round 4 blocker).
 *
 * A host that configures `tenant.tenantField: 'context.organizationId'`
 * must get a model whose COMPOUND idempotency index is built for THAT field —
 * otherwise two orgs collide on the same idempotency key. The repository now
 * accepts a `model` bound with the matching field, and refuses a custom field
 * WITHOUT one (no silent wrong-index).
 *
 * The manual-model test binds on a database of its own (`useDb`) so the
 * custom-field model doesn't clash with the default `context.tenantId` model
 * the env's container binds on its connection.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createContainer,
  createWorkflow,
  createWorkflowRepository,
  defineStreamlineModels,
} from '../../src/index.js';
import { createStreamlineTestEnv } from '../../src/testkit/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

const orgTenant = { tenantField: 'context.organizationId', required: true } as const;

describe('custom tenant.tenantField', () => {
  it('WARNS on a custom tenantField without a matching model (idempotency not isolated)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Constructs fine (filtering/stamping still work) but warns that
      // idempotency keys won't be tenant-isolated without a matching model.
      createWorkflowRepository({ tenant: orgTenant });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/idempotency keys will not be tenant-isolated/i),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('per-tenant idempotency holds on a CUSTOM field (context.organizationId)', async () => {
    // A fresh model registry on the env's server: nothing bound here yet.
    const conn = env.connection.useDb(`${env.connection.name}-custom-field`, { useCache: false });
    // Build a model whose compound idempotency index tracks context.organizationId.
    const models = defineStreamlineModels({ tenantField: orgTenant.tenantField }).bind(conn);
    await models.WorkflowRun.syncIndexes();

    const container = createContainer({
      repository: { tenant: orgTenant, model: models.WorkflowRun },
    });
    const wf = createWorkflow<{ organizationId: string }, { organizationId: string }>(
      'iso-custom-field',
      {
        steps: { work: async () => 'done' },
        context: (input) => ({ organizationId: input.organizationId }),
        autoExecute: false,
        container,
      },
    );

    try {
      const key = 'invoice-7';
      const a = await wf.start(
        { organizationId: 'org-A' },
        { tenantId: 'org-A', idempotencyKey: key },
      );
      // Different org, SAME key → no cross-tenant E11000 (compound index on organizationId).
      const b = await wf.start(
        { organizationId: 'org-B' },
        { tenantId: 'org-B', idempotencyKey: key },
      );
      expect(b._id).not.toBe(a._id);

      // Same org + same key → idempotent.
      const aAgain = await wf.start(
        { organizationId: 'org-A' },
        { tenantId: 'org-A', idempotencyKey: key },
      );
      expect(aAgain._id).toBe(a._id);

      // Cross-tenant control is still denied under the custom field.
      expect(await wf.get(a._id, { tenantId: 'org-B' })).toBeNull();
      expect((await wf.get(a._id, { tenantId: 'org-A' }))?._id).toBe(a._id);
    } finally {
      wf.shutdown();
      container.dispose();
      await conn.dropDatabase();
    }
  });

  it('createContainer({ connection }) auto-binds the field — no manual model, no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Just a connection + tenantField — the env builds its container as
    // `createContainer({ connection, repository: { tenant } })` and the
    // container binds the correctly indexed model set itself (run + counter),
    // no `repository.model` needed. It also runs `syncRetentionIndexes()`.
    const orgEnv = await createStreamlineTestEnv({
      uri: env.uri,
      container: { repository: { tenant: orgTenant } },
    });
    try {
      await orgEnv.container.repository.runModel.syncIndexes();

      const wf = orgEnv.workflow<{ organizationId: string }, { organizationId: string }>(
        'iso-auto-conn',
        {
          steps: { work: async () => 'done' },
          context: (input) => ({ organizationId: input.organizationId }),
        },
      );

      const key = 'shipment-9';
      const a = await wf.start(
        { organizationId: 'org-A' },
        { tenantId: 'org-A', idempotencyKey: key },
      );
      const b = await wf.start(
        { organizationId: 'org-B' },
        { tenantId: 'org-B', idempotencyKey: key },
      );
      expect(b._id).not.toBe(a._id); // per-tenant idempotency, automatic

      // No "idempotency not isolated" warning — the model was auto-bound correctly.
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(/idempotency keys will not be tenant-isolated/i),
      );
    } finally {
      warn.mockRestore();
      await orgEnv.close();
    }
  });
});
