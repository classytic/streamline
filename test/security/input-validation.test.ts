/**
 * Security: Input Validation & Injection Prevention
 *
 * Tests that the workflow engine rejects malicious inputs
 * and prevents NoSQL injection, prototype pollution, and
 * other common attack vectors.
 */

import { describe, expect, it } from 'vitest';
import { createHook, createWorkflow, resumeHook, type StepContext } from '../../src/index.js';
import { useStreamlineEnv } from '../helpers/index.js';

const env = useStreamlineEnv();

// ============================================================================
// Workflow/Step ID Validation
// ============================================================================

describe('ID validation — reject malicious identifiers', () => {
  it('should reject workflow IDs with NoSQL operators', () => {
    expect(() => createWorkflow('$gt', { steps: { a: async () => 1 } })).toThrow(
      'invalid characters',
    );

    expect(() => createWorkflow('{"$ne":""}', { steps: { a: async () => 1 } })).toThrow(
      'invalid characters',
    );
  });

  it('should reject workflow IDs with path traversal', () => {
    expect(() => createWorkflow('../etc/passwd', { steps: { a: async () => 1 } })).toThrow(
      'invalid characters',
    );

    expect(() => createWorkflow('..%2f..%2f', { steps: { a: async () => 1 } })).toThrow(
      'invalid characters',
    );
  });

  it('should reject workflow IDs with script injection', () => {
    expect(() =>
      createWorkflow('<script>alert(1)</script>', { steps: { a: async () => 1 } }),
    ).toThrow('invalid characters');
  });

  it('should reject empty or whitespace-only IDs', () => {
    expect(() => createWorkflow('', { steps: { a: async () => 1 } })).toThrow();

    expect(() => createWorkflow('   ', { steps: { a: async () => 1 } })).toThrow(
      'invalid characters',
    );
  });

  it('should reject extremely long IDs (DoS vector)', () => {
    const longId = 'a'.repeat(200);
    expect(() => createWorkflow(longId, { steps: { a: async () => 1 } })).toThrow('too long');
  });

  it('should reject IDs with null bytes', () => {
    expect(() => createWorkflow('valid\x00evil', { steps: { a: async () => 1 } })).toThrow(
      'invalid characters',
    );
  });

  it('should accept valid IDs with hyphens and underscores', () => {
    // The exact id matters here, so createWorkflow — bound to the env's container.
    const wf = createWorkflow('my-valid_id-123', {
      steps: { a: async () => 1 },
      autoExecute: false,
      container: env.container,
    });
    expect(wf.definition.id).toBe('my-valid_id-123');
    wf.shutdown();
  });

  it('should reject invalid step IDs with unsafe characters', () => {
    expect(() =>
      createWorkflow('valid-workflow', {
        steps: {
          'bad.step': async () => 1,
        },
        autoExecute: false,
      }),
    ).toThrow('step ID "bad.step" contains invalid characters');
  });
});

describe('Step configuration validation', () => {
  it('should reject invalid per-step retry and timeout config', () => {
    expect(() =>
      createWorkflow('invalid-step-retries', {
        steps: {
          bad: {
            handler: async () => 1,
            retries: -1,
          },
        },
        autoExecute: false,
      }),
    ).toThrow('retries must be a non-negative integer');

    expect(() =>
      createWorkflow('invalid-step-timeout', {
        steps: {
          bad: {
            handler: async () => 1,
            timeout: 0,
          },
        },
        autoExecute: false,
      }),
    ).toThrow('timeout must be a positive integer');
  });

  it('should reject invalid per-step retryDelay and retryBackoff config', () => {
    expect(() =>
      createWorkflow('invalid-step-retry-delay', {
        steps: {
          bad: {
            handler: async () => 1,
            retryDelay: -10,
          },
        },
        autoExecute: false,
      }),
    ).toThrow('retryDelay must be a non-negative integer');

    expect(() =>
      createWorkflow('invalid-step-backoff', {
        steps: {
          bad: {
            handler: async () => 1,
            retryBackoff: 0,
          },
        },
        autoExecute: false,
      }),
    ).toThrow("retryBackoff must be 'exponential', 'linear', 'fixed', or a positive number");
  });
});

// ============================================================================
// Context Injection Prevention
// ============================================================================

describe('Context safety — prevent prototype pollution', () => {
  it('should safely handle __proto__ in context keys', async () => {
    const wf = env.workflow<Record<string, unknown>>('proto-test', {
      steps: {
        check: async (ctx) => {
          // Attempt to set __proto__ via context — should not pollute Object prototype
          await ctx.set('__proto__', { polluted: true });
          return { safe: true };
        },
      },
      context: () => ({}),
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // Object prototype should NOT be polluted
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });

  it('should safely handle constructor/prototype in input', async () => {
    const wf = env.workflow('constructor-test', {
      steps: {
        echo: async (ctx) => {
          return { received: typeof ctx.input };
        },
      },
    });

    const run = await wf.start({
      constructor: { prototype: { isAdmin: true } },
      __proto__: { isAdmin: true },
    });

    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');
    expect(Reflect.get({}, 'isAdmin')).toBeUndefined();
  });
});

// ============================================================================
// Hook Token Security
// ============================================================================

describe('Hook token security', () => {
  it('should generate cryptographically random tokens', () => {
    // createHook reads only runId/stepId from the context
    const mockCtx = { runId: 'run-1', stepId: 'step-1' } as unknown as StepContext;
    const hook1 = createHook(mockCtx, 'test');
    const hook2 = createHook(mockCtx, 'test');

    // Tokens should be unique even for the same run/step
    expect(hook1.token).not.toBe(hook2.token);
    // Token should contain random component
    expect(hook1.token.length).toBeGreaterThan(20);
  });

  it('should reject resume with empty token', async () => {
    await expect(resumeHook('', { data: 1 }, { container: env.container })).rejects.toThrow();
  });

  it('should reject resume with fabricated token for non-existent run', async () => {
    await expect(
      resumeHook('fake-run-id:fake-step:deadbeef', { data: 1 }, { container: env.container }),
    ).rejects.toThrow();
  });

  it('should reject resume with mismatched hook token', async () => {
    const wf = env.workflow('hook-security-test', {
      steps: {
        wait_step: async (ctx) => {
          const hook = createHook(ctx, 'approval');
          return ctx.wait(hook.token, { hookToken: hook.token });
        },
      },
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // Verify it's waiting with a stored hookToken
    const waiting = await wf.get(run._id);
    expect(waiting?.status).toBe('waiting');
    const waitData = waiting?.steps[0]?.waitingFor?.data as { hookToken?: string } | undefined;
    expect(waitData?.hookToken).toBeDefined();

    // The correct token would be `runId:stepId:randomHex`
    // Fabricate a token with the correct runId but wrong random part
    const fakeToken = `${run._id}:wait_step:0000000000000000deadbeef00000000`;
    await expect(
      resumeHook(fakeToken, { approved: true }, { container: env.container }),
    ).rejects.toThrow('Invalid hook token');
  });
});

// ============================================================================
// State Transition Integrity
// ============================================================================

describe('State transition integrity', () => {
  it('should prevent updating a cancelled workflow', async () => {
    const wf = env.workflow('cancel-guard-test', {
      steps: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return 'should-not-reach';
        },
      },
    });

    const run = await wf.start({});
    // Start execution in background
    const execPromise = wf.execute(run._id).catch(() => {});
    // Wait until the slow step is actually executing
    await env.until(run._id, (r) => r.steps[0]?.status === 'running');

    // Cancel
    const cancelled = await wf.cancel(run._id);
    expect(cancelled.status).toBe('cancelled');

    await execPromise;

    // Direct DB check: should still be cancelled
    const doc = await env.runs.get(run._id);
    expect(doc?.status).toBe('cancelled');
  });

  it('should prevent resuming a non-waiting workflow', async () => {
    const wf = env.workflow('resume-guard-test', {
      steps: {
        fast: async () => 'done',
      },
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // Workflow is done, not waiting — resume should fail
    await expect(wf.resume(run._id)).rejects.toThrow();
  });
});

// ============================================================================
// Multi-Tenant Isolation
// ============================================================================

describe('Multi-tenant data isolation', () => {
  it('should scope workflows by tenant via context', async () => {
    interface TenantCtx {
      tenantId: string;
      data: string;
    }

    const wf = env.workflow<TenantCtx, { tenantId: string; data: string }>('tenant-scope-test', {
      steps: {
        process: async (ctx) => {
          return { tenantId: ctx.context.tenantId, processed: true };
        },
      },
      context: (input) => ({
        tenantId: input.tenantId,
        data: input.data,
      }),
    });

    // Create runs for two tenants
    const tenant1Run = await wf.start({ tenantId: 'tenant-A', data: 'secret-A' });
    const tenant2Run = await wf.start({ tenantId: 'tenant-B', data: 'secret-B' });

    await wf.execute(tenant1Run._id);
    await wf.execute(tenant2Run._id);

    // Read from DB to verify data isolation
    const ctx1 = (await env.runs.get(tenant1Run._id))?.context as TenantCtx | undefined;
    const ctx2 = (await env.runs.get(tenant2Run._id))?.context as TenantCtx | undefined;

    expect(ctx1?.tenantId).toBe('tenant-A');
    expect(ctx1?.data).toBe('secret-A');
    expect(ctx2?.tenantId).toBe('tenant-B');
    expect(ctx2?.data).toBe('secret-B');

    // Cross-check: tenant A can't see tenant B's data
    expect(ctx1?.data).not.toBe('secret-B');
  });
});
