/**
 * UI Pagination Examples
 *
 * Shows how to query workflow runs for UI dashboards using mongokit pagination patterns.
 * The workflowRunRepository is exported and uses mongokit's Repository class.
 */

import { workflowRunRepository } from '@classytic/streamline';

// ============ Offset Pagination (Page-based UI) ============

/**
 * Get workflows for page-based navigation (e.g., "Page 1 of 10")
 * Best for: Admin dashboards, data tables with page numbers
 */
async function getWorkflowsForPage(page: number = 1, limit: number = 20) {
  const result = await workflowRunRepository.getAll({
    page,
    limit,
    filters: { status: 'done' },
    sort: '-createdAt', // Newest first
  });

  return {
    workflows: result.docs,
    currentPage: result.page,
    totalPages: result.pages,
    total: result.total,
    hasNext: result.hasNext,
    hasPrev: result.hasPrev,
  };
}

// Usage:
// const page1 = await getWorkflowsForPage(1, 20);
// const page2 = await getWorkflowsForPage(2, 20);

// ============ Keyset Pagination (Infinite Scroll) ============

/**
 * Get workflows for infinite scroll UI
 * Best for: Mobile apps, activity feeds, real-time dashboards
 */
async function getWorkflowsForInfiniteScroll(cursor?: string, limit: number = 50) {
  const result = await workflowRunRepository.getAll({
    sort: '-createdAt', // Sort required for keyset pagination
    cursor, // Optional cursor from previous page
    limit,
    filters: { userId: 'user123' },
  });

  return {
    workflows: result.docs,
    nextCursor: result.next, // Use this for next page
    hasMore: result.hasMore,
  };
}

// Usage:
// const page1 = await getWorkflowsForInfiniteScroll(undefined, 50);
// const page2 = await getWorkflowsForInfiniteScroll(page1.nextCursor, 50);

// ============ Filtered Queries ============

/**
 * Get workflows filtered by status and user
 */
async function getUserWorkflows(userId: string, status?: string) {
  const filters: Record<string, unknown> = { userId };
  if (status) filters.status = status;

  const result = await workflowRunRepository.getAll({
    filters,
    sort: '-updatedAt',
    page: 1,
    limit: 100,
  });

  return result.docs;
}

// ============ Real-time Dashboard ============

/**
 * Get active workflows for real-time dashboard
 */
async function getActiveDashboard() {
  // Get all running/waiting workflows
  const active = await workflowRunRepository.getAll({
    filters: { status: { $in: ['running', 'waiting'] } },
    sort: '-updatedAt',
    limit: 100,
  });

  // Get recent completed workflows
  const recent = await workflowRunRepository.getAll({
    filters: { status: 'done' },
    sort: '-endedAt',
    limit: 20,
  });

  // Get recent failures
  const failed = await workflowRunRepository.getAll({
    filters: { status: 'failed' },
    sort: '-endedAt',
    limit: 10,
  });

  return {
    active: active.docs,
    recentCompleted: recent.docs,
    recentFailed: failed.docs,
  };
}

// ============ Search ============

/**
 * Search workflows by workflow ID or tags (requires text index)
 */
async function searchWorkflows(query: string) {
  // First create text index (once):
  // WorkflowRunModel.collection.createIndex({ workflowId: 'text', tags: 'text' });

  const result = await workflowRunRepository.getAll({
    search: query, // Uses MongoDB $text search
    sort: '-createdAt',
    limit: 50,
  });

  return result.docs;
}

// ============ Multi-Tenant Queries ============

/**
 * Get workflows for a specific tenant (using meta field)
 */
async function getTenantWorkflows(tenantId: string, page: number = 1) {
  const result = await workflowRunRepository.getAll({
    filters: { 'meta.tenantId': tenantId },
    sort: '-createdAt',
    page,
    limit: 20,
  });

  return {
    workflows: result.docs,
    total: result.total,
    page: result.page,
    pages: result.pages,
  };
}

// For better performance, add custom index:
// WorkflowRunModel.collection.createIndex({ 'meta.tenantId': 1, status: 1 });

// ============ Aggregations ============

/**
 * Get workflow statistics (counts by status)
 */
async function getWorkflowStats(userId?: string) {
  const matchStage: Record<string, unknown> = {};
  if (userId) matchStage.userId = userId;

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgDuration: {
          $avg: {
            $subtract: [
              { $ifNull: ['$endedAt', new Date()] },
              '$createdAt',
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const stats = await workflowRunRepository.aggregate(pipeline);

  return stats.map((s) => ({
    status: s._id,
    count: s.count,
    avgDurationMs: s.avgDuration,
  }));
}

// ============ Export for Frontend ============

/**
 * API endpoint example for Next.js/Express
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const status = url.searchParams.get('status') || undefined;
  const userId = url.searchParams.get('userId') || undefined;

  const filters: Record<string, unknown> = {};
  if (status) filters.status = status;
  if (userId) filters.userId = userId;

  const result = await workflowRunRepository.getAll({
    filters,
    sort: '-createdAt',
    page,
    limit,
  });

  return Response.json({
    data: result.docs,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      pages: result.pages,
      hasNext: result.hasNext,
      hasPrev: result.hasPrev,
    },
  });
}

// ============ Performance Tips ============

/**
 * For large datasets (10,000+ workflows):
 *
 * 1. Use keyset pagination (cursor) instead of offset for deep pages
 * 2. Add indexes for common filters:
 *    WorkflowRunModel.collection.createIndex({ userId: 1, status: 1, createdAt: -1 });
 * 3. Use select to return only needed fields:
 *    workflowRunRepository.getAll({ filters, select: '_id workflowId status createdAt' });
 * 4. Use lean: true for faster queries (enabled by default)
 * 5. Limit max page size (e.g., 100) to prevent memory issues
 */

export {
  getWorkflowsForPage,
  getWorkflowsForInfiniteScroll,
  getUserWorkflows,
  getActiveDashboard,
  searchWorkflows,
  getTenantWorkflows,
  getWorkflowStats,
};
