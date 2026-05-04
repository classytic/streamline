/**
 * Tenant Filter Plugin for MongoKit
 *
 * Automatically injects tenant filters into all queries for multi-tenant isolation.
 * Prevents accidental cross-tenant data leaks by enforcing tenant scope at the repository level.
 *
 * ## Why streamline ships this instead of using mongokit's `multiTenantPlugin`
 *
 * mongokit 3.13's `multiTenantPlugin` exposes `tenantField`, `required`,
 * `skipWhen`, `resolveContext`, `allowDataInjection` (default flipped to
 * `false` in 3.13), `bypassTenant` (per-call), and `fieldType`. Streamline
 * still ships its own plugin because of three streamline-specific
 * requirements — re-verified against mongokit 3.13 on 2026-05-04:
 *
 * 1. **Nested-field tenant injection on `create` / `createMany`.** Streamline's
 *    `WorkflowRun` stores tenant scope at `context.tenantId` (a nested path).
 *    mongokit's plugin sets `data[tenantField]` literally — given
 *    `tenantField: 'context.tenantId'` it would write a flat key with a dot,
 *    not a nested object. Streamline's plugin walks the dotted path and
 *    builds the nested structure. (Reads work either way — MongoDB queries
 *    accept dotted keys natively.)
 *
 * 2. **`bypassTenant` plugin-construction flag for admin repositories.**
 *    Streamline's scheduler runs cross-tenant background jobs (claim races,
 *    retry sweeps) on a separately-constructed admin repo with
 *    `bypassTenant: true` baked in. mongokit's per-call `bypassTenant` /
 *    `skipWhen` could express this, but the construction-time form is part
 *    of streamline's documented contract for `getReadyToResume`,
 *    `getReadyForRetry`, etc. — switching shape is a breaking API change.
 *
 * 3. **`staticTenantId` for single-tenant deployments.** Apps that start
 *    single-tenant and may grow multi-tenant set `staticTenantId` once at
 *    plugin construction and forget about per-call tenant args. mongokit's
 *    `resolveContext: () => staticTenantId` would express this, but the
 *    config shape is more discoverable as a named option here.
 *
 * **Concrete exit criterion** — migrate when ALL THREE land in mongokit:
 *   (a) `multiTenantPlugin` accepts a `tenantPath` option (or
 *       `tenantField` with dotted-path support that builds nested
 *       objects on writes, not flat dotted keys) — dissolves (1).
 *   (b) Plugin-construction-time `bypassTenant: true` flag is documented
 *       and stable (or `skipWhen: () => true` is the canonical pattern
 *       for cross-tenant admin repos) — dissolves (2).
 *   (c) `staticTenantId` is a first-class option (or the `resolveContext`
 *       wrapper pattern is documented in the mongokit README) —
 *       dissolves (3).
 *
 * On the trigger: replace this file with a thin wrapper that passes
 * `staticTenantId` / `bypassTenant` / nested-path semantics through to
 * mongokit and delete the rest. Tracked as streamline tech debt; not
 * blocked on any consumer.
 *
 * Design Philosophy:
 * - Zero-trust: All queries must explicitly include tenantId (or disable via bypassTenant flag)
 * - Fail-fast: Throws error if tenantId is missing and not bypassed
 * - Flexible: Supports custom tenant field names (context.tenantId, meta.orgId, etc.)
 * - Composable: Works with other MongoKit plugins (cache, soft-delete, etc.)
 *
 * @example Basic Usage (Multi-Tenant Mode)
 * ```typescript
 * import { workflowRunRepository } from './storage/run.repository';
 * import { tenantFilterPlugin } from './plugins/tenant-filter.plugin';
 *
 * // Create multi-tenant repository
 * const repo = new Repository(WorkflowRunModel, [
 *   tenantFilterPlugin({ tenantField: 'context.tenantId', strict: true })
 * ]);
 *
 * // All queries automatically filtered by tenantId
 * const runs = await repo.getAll({
 *   filters: { status: 'running' },
 *   tenantId: 'tenant-123' // Required in strict mode
 * });
 * // Actual query: { status: 'running', 'context.tenantId': 'tenant-123' }
 *
 * // Bypass for admin operations (if strict: false)
 * const allRuns = await repo.getAll({
 *   filters: { status: 'done' },
 *   bypassTenant: true
 * });
 * ```
 *
 * @example Single-Tenant Mode (Static Tenant)
 * ```typescript
 * // For apps that want single-tenant behavior but may need multi-tenant later
 * const repo = new Repository(WorkflowRunModel, [
 *   tenantFilterPlugin({
 *     tenantField: 'context.tenantId',
 *     staticTenantId: 'default-org' // All queries use this tenant
 *   })
 * ]);
 *
 * // No need to pass tenantId - automatically uses 'default-org'
 * const runs = await repo.getAll({ filters: { status: 'running' } });
 * // Actual query: { status: 'running', 'context.tenantId': 'default-org' }
 * ```
 *
 * ## Why per-method `repo.on('before:*', …)` and not `repo.useMiddleware()`
 *
 * mongokit 3.13+ ships `useMiddleware()` (Prisma `$extends.query` style).
 * Tempting to collapse the 13 enumerated hooks below into one middleware
 * closure — but mongokit's own `CLAUDE.md` rules this out for security
 * plugins:
 *
 * > Don't use middleware for security policy (tenant scope, soft-delete
 * > filtering, audit). The execution order is `_buildContext +
 * > before:<op>` → middleware chain → driver call. Policy hooks fire
 * > BEFORE middleware sees the op, so middleware can never wrap a policy
 * > failure. That's by design. Use `before:*` hooks for policy,
 * > `useMiddleware()` for ergonomics.
 *
 * Tenant scope IS security policy — mutating `context.query` from
 * middleware-pre would race with mongokit's actions that capture the
 * filter inside `_runOp` (e.g. `findAll` snapshots `resolvedFilters`
 * before middleware can touch it). Per-method `before:*` hooks fire at
 * the right lifecycle point and run in priority order with other
 * security plugins (multi-tenant, soft-delete, audit) — that ordering
 * guarantee is the load-bearing reason this plugin uses hooks.
 *
 * The 13 enumerations below ARE intentional. New hook names get added
 * here as mongokit grows new ops; the silent-gap class is the trade-off
 * we accept for correct ordering.
 */

import {
  HOOK_PRIORITY,
  type Plugin,
  type RepositoryContext,
  type RepositoryInstance,
} from '@classytic/mongokit';

/**
 * Tenant filter plugin options
 */
export interface TenantFilterOptions {
  /**
   * Field path for tenant ID in documents
   * Supports nested fields using dot notation
   *
   * @example 'context.tenantId' → filters { 'context.tenantId': 'tenant-123' }
   * @example 'meta.orgId' → filters { 'meta.orgId': 'org-456' }
   * @default 'context.tenantId'
   */
  tenantField?: string;

  /**
   * Static tenant ID for single-tenant deployments
   * If set, all queries use this tenant ID (no need to pass tenantId param)
   *
   * @default undefined (multi-tenant mode - tenantId required per query)
   */
  staticTenantId?: string;

  /**
   * Strict mode - throws error if tenantId is missing and not bypassed
   * If false, missing tenantId is silently ignored (not recommended for production)
   *
   * @default true
   */
  strict?: boolean;

  /**
   * Enable bypass capability - allows queries to bypass tenant filter
   * If false, ALL queries must include tenant filter (maximum security)
   *
   * @default true (allows bypassTenant: true for admin operations)
   */
  allowBypass?: boolean;
}

/**
 * Extended context with tenant-specific fields
 */
interface TenantRepositoryContext extends RepositoryContext {
  /** Tenant ID to filter by */
  tenantId?: string;
  /** Bypass tenant filter (for admin operations) */
  bypassTenant?: boolean;
}

/**
 * Tenant filter plugin factory
 *
 * Creates a plugin that automatically injects tenant filters into all queries.
 * Prevents cross-tenant data leaks by enforcing tenant isolation at repository level.
 *
 * @param options - Plugin configuration options
 * @returns MongoKit plugin instance
 *
 * @example Multi-Tenant with Strict Mode
 * ```typescript
 * const plugin = tenantFilterPlugin({
 *   tenantField: 'context.tenantId',
 *   strict: true,
 *   allowBypass: false // No bypasses allowed
 * });
 * ```
 *
 * @example Single-Tenant with Static ID
 * ```typescript
 * const plugin = tenantFilterPlugin({
 *   tenantField: 'context.tenantId',
 *   staticTenantId: process.env.ORGANIZATION_ID
 * });
 * ```
 */
export function tenantFilterPlugin(options: TenantFilterOptions = {}): Plugin {
  const tenantField = options.tenantField || 'context.tenantId';
  const staticTenantId = options.staticTenantId;
  const strict = options.strict !== false; // Default: true
  const allowBypass = options.allowBypass !== false; // Default: true

  return {
    name: 'tenantFilter',

    apply(repo: RepositoryInstance): void {
      /**
       * Inject tenant filter into context
       * Validates tenantId presence and builds filter object
       */
      const injectTenantFilter = (context: TenantRepositoryContext): void => {
        // Check if bypass is requested
        if (context.bypassTenant) {
          if (!allowBypass) {
            throw new Error('[tenantFilterPlugin] Tenant bypass not allowed (allowBypass: false)');
          }
          // Bypass - no filter injected
          return;
        }

        // Determine tenant ID (from context or static config)
        const tenantId = context.tenantId || staticTenantId;

        // Validate tenant ID presence in strict mode
        if (!tenantId && strict) {
          throw new Error(
            `[tenantFilterPlugin] Missing tenantId in ${context.operation} operation. ` +
              `Pass 'tenantId' in query options or set 'staticTenantId' in plugin config.`,
          );
        }

        // Skip if no tenantId (only in non-strict mode)
        if (!tenantId) {
          return;
        }

        // Build tenant filter
        const tenantFilter = { [tenantField]: tenantId };

        // Inject filter based on operation type. Every op registered as a
        // before-hook below MUST have a matching branch here — registering
        // a hook without a corresponding inject branch silently leaves the
        // op unscoped (the worst kind of tenant-isolation failure: the
        // call still succeeds, the data still leaks).
        //
        // The op→target mapping mirrors mongokit's `OP_REGISTRY` policyKey:
        //   'filters' bag (paginated reads): getAll, aggregatePaginate
        //   'query' record (everything else with a filter):
        //     getById, getByQuery, getOne, findAll, count, exists,
        //     update, delete, updateMany, deleteMany, findOneAndUpdate
        const filtersBagOps = new Set(['getAll']);
        const queryRecordOps = new Set([
          'getById',
          'getByQuery',
          'getOne',
          'findAll',
          'count',
          'exists',
          'update',
          'delete',
          'updateMany',
          'deleteMany',
          'findOneAndUpdate',
        ]);

        if (filtersBagOps.has(context.operation)) {
          const existingFilters = (context as Record<string, unknown>).filters as
            | Record<string, unknown>
            | undefined;
          (context as Record<string, unknown>).filters = {
            ...existingFilters,
            ...tenantFilter,
          };
        } else if (queryRecordOps.has(context.operation)) {
          context.query = {
            ...(context.query || {}),
            ...tenantFilter,
          };
        } else if (context.operation === 'aggregatePaginate') {
          // For aggregation: inject $match stage at the beginning
          const pipeline = (context as Record<string, unknown>).pipeline as Array<
            Record<string, unknown>
          >;
          if (Array.isArray(pipeline)) {
            // Prepend $match with tenant filter
            pipeline.unshift({ $match: tenantFilter });
          } else {
            // Initialize pipeline with tenant filter
            (context as Record<string, unknown>).pipeline = [{ $match: tenantFilter }];
          }
        }
      };

      // Register hooks for all read/write operations. `updateMany` and
      // `deleteMany` are class primitives as of mongokit 3.11 — they MUST
      // be hooked here or bulk ops bypass tenant scope entirely.
      //
      // Priority: POLICY (100) — must run BEFORE cache (200) /
      // observability (300) / default (500) so tenant scope is applied
      // before anything reads or records the filter. Matches mongokit's
      // own `multiTenantPlugin` priority tier.
      const policy = { priority: HOOK_PRIORITY.POLICY };
      repo.on('before:getAll', injectTenantFilter, policy);
      repo.on('before:getById', injectTenantFilter, policy);
      repo.on('before:getByQuery', injectTenantFilter, policy);
      repo.on('before:getOne', injectTenantFilter, policy);
      repo.on('before:findAll', injectTenantFilter, policy);
      repo.on('before:count', injectTenantFilter, policy);
      repo.on('before:exists', injectTenantFilter, policy);
      repo.on('before:update', injectTenantFilter, policy);
      repo.on('before:delete', injectTenantFilter, policy);
      repo.on('before:updateMany', injectTenantFilter, policy);
      repo.on('before:deleteMany', injectTenantFilter, policy);
      repo.on('before:aggregatePaginate', injectTenantFilter, policy);
      // Atomic claim path: streamline's `repository.updateOne` and
      // `bumpDebounceDraft` both delegate to `super.findOneAndUpdate`.
      // Defense in depth — keep manual `applyTenantFilter` in `updateOne`,
      // also hook the plugin so writes from any future helper are scoped.
      repo.on('before:findOneAndUpdate', injectTenantFilter, policy);
      // mongokit 3.13+ ships `Repository.claim()` as a class primitive.
      // Streamline's scheduler/recovery paths use it for compound-filter
      // CAS state transitions. `claim` registers with `policyKey: 'query'`
      // in `OP_REGISTRY` and fires its own `before:claim` event — hook
      // it here so tenant scope auto-injects when callers don't pass
      // `bypassTenant: true` (current scheduler callers do, but any
      // future per-tenant claim by a domain caller will be covered).
      repo.on('before:claim', injectTenantFilter, policy);

      // For create operations: auto-inject tenantId into document data.
      // Same POLICY priority as the read/write hooks above.
      repo.on(
        'before:create',
        (context: TenantRepositoryContext) => {
          if (context.bypassTenant && allowBypass) {
            return;
          }

          const tenantId = context.tenantId || staticTenantId;

          if (!tenantId && strict) {
            throw new Error(
              `[tenantFilterPlugin] Missing tenantId in create operation. ` +
                `Pass 'tenantId' in options or set 'staticTenantId' in plugin config.`,
            );
          }

          if (tenantId) {
            // Inject tenant ID into document data
            const data = (context as Record<string, unknown>).data as Record<string, unknown>;
            if (data) {
              // Handle nested fields (e.g., 'context.tenantId')
              const fieldParts = tenantField.split('.');
              if (fieldParts.length === 1) {
                // Simple field
                data[tenantField] = tenantId;
              } else {
                // Nested field - create nested object structure
                let current = data;
                for (let i = 0; i < fieldParts.length - 1; i++) {
                  const part = fieldParts[i];
                  if (!current[part] || typeof current[part] !== 'object') {
                    current[part] = {};
                  }
                  current = current[part] as Record<string, unknown>;
                }
                current[fieldParts[fieldParts.length - 1]] = tenantId;
              }
            }
          }
        },
        policy,
      );

      // For createMany operations: auto-inject tenantId into all documents
      repo.on(
        'before:createMany',
        (context: TenantRepositoryContext) => {
          if (context.bypassTenant && allowBypass) {
            return;
          }

          const tenantId = context.tenantId || staticTenantId;

          if (!tenantId && strict) {
            throw new Error(
              `[tenantFilterPlugin] Missing tenantId in createMany operation. ` +
                `Pass 'tenantId' in options or set 'staticTenantId' in plugin config.`,
            );
          }

          if (tenantId) {
            const dataArray = (context as Record<string, unknown>).dataArray as Array<
              Record<string, unknown>
            >;
            if (Array.isArray(dataArray)) {
              dataArray.forEach((data) => {
                // Handle nested fields
                const fieldParts = tenantField.split('.');
                if (fieldParts.length === 1) {
                  data[tenantField] = tenantId;
                } else {
                  let current = data;
                  for (let i = 0; i < fieldParts.length - 1; i++) {
                    const part = fieldParts[i];
                    if (!current[part] || typeof current[part] !== 'object') {
                      current[part] = {};
                    }
                    current = current[part] as Record<string, unknown>;
                  }
                  current[fieldParts[fieldParts.length - 1]] = tenantId;
                }
              });
            }
          }
        },
        policy,
      );
    },
  };
}

/**
 * Helper to create single-tenant repository (syntactic sugar)
 *
 * @param tenantId - Static tenant ID for all operations
 * @param tenantField - Field path for tenant ID (default: 'context.tenantId')
 * @returns Plugin configuration for single-tenant mode
 *
 * @example
 * ```typescript
 * import { singleTenantPlugin } from './plugins/tenant-filter.plugin';
 *
 * const repo = new Repository(Model, [
 *   singleTenantPlugin('my-organization-id')
 * ]);
 * ```
 */
export function singleTenantPlugin(
  tenantId: string,
  tenantField: string = 'context.tenantId',
): Plugin {
  return tenantFilterPlugin({
    tenantField,
    staticTenantId: tenantId,
    strict: true,
    allowBypass: false, // Single-tenant mode should not allow bypasses
  });
}
