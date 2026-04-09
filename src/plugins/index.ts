/**
 * Plugins Module
 *
 * MongoKit plugins for extending repository functionality.
 *
 * @example Multi-Tenant Setup
 * ```typescript
 * import { tenantFilterPlugin } from '@classytic/streamline/plugins';
 * import { Repository } from '@classytic/mongokit';
 *
 * const repo = new Repository(WorkflowRunModel, [
 *   tenantFilterPlugin({
 *     tenantField: 'context.tenantId',
 *     strict: true
 *   })
 * ]);
 *
 * // All queries automatically filtered by tenant
 * const runs = await repo.getAll({
 *   filters: { status: 'running' },
 *   tenantId: 'tenant-123'
 * });
 * ```
 *
 * @example Single-Tenant Setup
 * ```typescript
 * import { singleTenantPlugin } from '@classytic/streamline/plugins';
 *
 * const repo = new Repository(WorkflowRunModel, [
 *   singleTenantPlugin('my-organization-id')
 * ]);
 * ```
 */

// Tenant isolation plugin
export {
  singleTenantPlugin,
  type TenantFilterOptions,
  tenantFilterPlugin,
} from './tenant-filter.plugin.js';
