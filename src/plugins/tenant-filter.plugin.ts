/**
 * Tenant Filter Plugin for MongoKit
 *
 * Automatically injects tenant filters into all queries for multi-tenant isolation.
 * Prevents accidental cross-tenant data leaks by enforcing tenant scope at the repository level.
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
 */

import type { Plugin, RepositoryContext, RepositoryInstance } from '@classytic/mongokit';

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

        // Inject filter based on operation type
        if (context.operation === 'getAll') {
          // For getAll: merge with existing filters
          const existingFilters = (context as Record<string, unknown>).filters as
            | Record<string, unknown>
            | undefined;
          (context as Record<string, unknown>).filters = {
            ...existingFilters,
            ...tenantFilter,
          };
        } else if (
          context.operation === 'getById' ||
          context.operation === 'getByQuery' ||
          context.operation === 'update' ||
          context.operation === 'delete'
        ) {
          // For getById, getByQuery, update, delete: merge with query
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

      // Register hooks for all read operations
      repo.on('before:getAll', injectTenantFilter);
      repo.on('before:getById', injectTenantFilter);
      repo.on('before:getByQuery', injectTenantFilter);
      repo.on('before:update', injectTenantFilter);
      repo.on('before:delete', injectTenantFilter);
      repo.on('before:aggregatePaginate', injectTenantFilter);

      // For create operations: auto-inject tenantId into document data
      repo.on('before:create', (context: TenantRepositoryContext) => {
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
      });

      // For createMany operations: auto-inject tenantId into all documents
      repo.on('before:createMany', (context: TenantRepositoryContext) => {
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
      });
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
