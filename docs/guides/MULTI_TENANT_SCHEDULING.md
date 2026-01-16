# Multi-Tenant Workflow Scheduling Guide

## Overview

This guide shows you how to build a **multi-tenant SaaS application** with timezone-aware workflow scheduling using Streamline. We'll build a CRM that schedules social media posts for multiple clients across different timezones.

**What you'll learn:**
- Multi-tenant workflow isolation using tenant filter plugin
- Timezone-aware scheduling with DST handling
- Efficient pagination for large-scale scheduling
- Best practices for production deployments

---

## Use Case: Social Media Scheduling CRM

**Scenario**: Build a SaaS CRM where agencies manage social media posts for multiple clients.

**Requirements**:
- Each agency (tenant) has multiple clients
- Each client can schedule posts in their local timezone
- Posts scheduled for "9 AM Pacific" should execute at 9 AM Pacific, not 9 AM UTC
- Handle DST transitions gracefully (spring forward, fall back)
- Scale to 10,000+ scheduled posts per agency
- Prevent data leaks between agencies (strict tenant isolation)

---

## Step 1: Install Dependencies

```bash
npm install @classytic/streamline luxon
npm install --save-dev @types/luxon
```

---

## Step 2: Define the Workflow

```typescript
// workflows/social-media-post.workflow.ts

import { createWorkflow } from '@classytic/streamline';
import type { StepContext } from '@classytic/streamline';

export interface SocialMediaContext {
  tenantId: string; // Agency ID (for multi-tenant isolation)
  clientId: string; // Client ID within the agency
  platform: 'twitter' | 'facebook' | 'instagram' | 'linkedin';
  content: string;
  imageUrl?: string;
  scheduledFor: Date; // Local time in client's timezone
  timezone: string; // Client's timezone (IANA format)
}

export interface SocialMediaInput {
  tenantId: string;
  clientId: string;
  platform: 'twitter' | 'facebook' | 'instagram' | 'linkedin';
  content: string;
  imageUrl?: string;
  scheduledFor: Date;
  timezone: string;
}

export const socialMediaWorkflow = createWorkflow<SocialMediaContext, SocialMediaInput>(
  'social-media-post',
  {
    steps: {
      validate: async (ctx: StepContext<SocialMediaContext>) => {
        const { content, platform } = ctx.context;
        const maxLength = { twitter: 280, facebook: 63206, instagram: 2200, linkedin: 3000 }[platform];
        if (content.length > maxLength) {
          throw new Error(`Content exceeds ${platform} limit of ${maxLength} characters`);
        }
        return { valid: true, contentLength: content.length };
      },

      'upload-media': async (ctx: StepContext<SocialMediaContext>) => {
        const { imageUrl, platform } = ctx.context;
        if (!imageUrl) return { mediaId: null, skipped: true };
        const mediaId = await uploadToPlatform(platform, imageUrl);
        return { mediaId, uploaded: true };
      },

      publish: async (ctx: StepContext<SocialMediaContext>) => {
        const { platform, content, clientId, tenantId } = ctx.context;
        const uploadResult = ctx.getOutput<{ mediaId: string }>('upload-media');
        const credentials = await getClientCredentials(tenantId, clientId, platform);
        const postId = await publishPost({ platform, content, mediaId: uploadResult?.mediaId, credentials });
        return { postId, publishedAt: new Date() };
      },

      notify: async (ctx: StepContext<SocialMediaContext>) => {
        const { clientId, tenantId, platform } = ctx.context;
        const publishResult = ctx.getOutput<{ postId: string }>('publish');
        await sendNotification(tenantId, clientId, { type: 'post-published', postId: publishResult?.postId, platform });
        return { notified: true };
      },
    },
    context: (input) => ({
      tenantId: input.tenantId,
      clientId: input.clientId,
      platform: input.platform,
      content: input.content,
      imageUrl: input.imageUrl,
      scheduledFor: input.scheduledFor,
      timezone: input.timezone,
    }),
    version: '1.0.0',
    defaults: { retries: 3, timeout: 30000 },
  }
);
```

// Helper functions (implement these in your application)
async function uploadToPlatform(platform: string, imageUrl: string): Promise<string> {
  // Implementation depends on platform API
  return 'media-id-123';
}

async function getClientCredentials(
  tenantId: string,
  clientId: string,
  platform: string
): Promise<unknown> {
  // Fetch from your database (scoped by tenantId)
  return {};
}

async function publishPost(options: unknown): Promise<string> {
  // Call platform API
  return 'post-id-456';
}

async function sendNotification(
  tenantId: string,
  clientId: string,
  payload: unknown
): Promise<void> {
  // Send webhook/email/push notification
}
```

---

## Step 4: Configure Multi-Tenant Repository

```typescript
// server.ts

import { createWorkflowRunRepository } from '@classytic/streamline/storage';

// Create repository with strict multi-tenant isolation
export const workflowRepository = createWorkflowRunRepository({
  multiTenant: {
    tenantField: 'context.tenantId', // Where tenant ID is stored
    strict: true, // Throw error if tenantId missing
    allowBypass: false, // No admin bypasses (maximum security)
  },
});
```

---

## Step 5: Create Scheduling Service

```typescript
// services/scheduling.service.ts

import { SchedulingService } from '@classytic/streamline/scheduling';
import { socialMediaWorkflow, socialMediaHandlers } from '../workflows';

// Create scheduling service with multi-tenant support
export const schedulingService = new SchedulingService(
  socialMediaWorkflow,
  socialMediaHandlers,
  {
    multiTenant: {
      tenantField: 'context.tenantId',
      strict: true,
      allowBypass: false,
    },
    autoExecute: true, // Scheduler will auto-execute when ready
  }
);
```

---

## Step 6: API Endpoints

```typescript
// routes/posts.routes.ts

import { Request, Response } from 'express';
import { schedulingService } from '../services/scheduling.service';

/**
 * Schedule a social media post
 * POST /api/posts/schedule
 */
export async function schedulePost(req: Request, res: Response) {
  try {
    const {
      clientId,
      platform,
      content,
      imageUrl,
      scheduledFor, // ISO string: "2024-12-25T09:00:00"
      timezone, // IANA timezone: "America/Los_Angeles"
    } = req.body;

    // Get tenant ID from authenticated user (e.g., JWT token)
    const tenantId = req.user.tenantId;

    // Schedule workflow
    const run = await schedulingService.schedule({
      scheduledFor: new Date(scheduledFor),
      timezone,
      input: {
        tenantId,
        clientId,
        platform,
        content,
        imageUrl,
      },
      tenantId, // Required for multi-tenant isolation
      userId: req.user.id,
      tags: [platform, clientId],
    });

    // Check for DST warnings
    if (run.scheduling?.isDSTTransition) {
      console.warn(
        `DST transition detected for post ${run._id}:`,
        run.scheduling.dstNote
      );
    }

    res.json({
      success: true,
      postId: run._id,
      executionTime: run.scheduling?.executionTime, // UTC time when it will actually execute
      localTimeDisplay: run.scheduling?.localTimeDisplay, // e.g., "2024-12-25 09:00:00 PST"
      dstWarning: run.scheduling?.dstNote,
    });
  } catch (error) {
    console.error('Failed to schedule post:', error);
    res.status(500).json({ error: 'Failed to schedule post' });
  }
}

/**
 * List scheduled posts for a client
 * GET /api/posts/scheduled?clientId=123&page=1&limit=50
 */
export async function listScheduledPosts(req: Request, res: Response) {
  try {
    const { clientId, page = 1, limit = 50 } = req.query;
    const tenantId = req.user.tenantId;

    const result = await schedulingService.getScheduled({
      tenantId, // Automatic tenant filtering
      page: Number(page),
      limit: Number(limit),
    });

    // Filter by clientId (app-level filtering within tenant)
    const clientPosts = result.data.filter(
      (run: any) => run.context.clientId === clientId
    );

    res.json({
      data: clientPosts,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        hasNextPage: result.hasNextPage,
      },
    });
  } catch (error) {
    console.error('Failed to list posts:', error);
    res.status(500).json({ error: 'Failed to list posts' });
  }
}

/**
 * Reschedule a post to different time
 * PATCH /api/posts/:postId/reschedule
 */
export async function reschedulePost(req: Request, res: Response) {
  try {
    const { postId } = req.params;
    const { scheduledFor, timezone } = req.body;

    const run = await schedulingService.reschedule(
      postId,
      new Date(scheduledFor),
      timezone
    );

    res.json({
      success: true,
      executionTime: run.scheduling?.executionTime,
      localTimeDisplay: run.scheduling?.localTimeDisplay,
      dstWarning: run.scheduling?.dstNote,
    });
  } catch (error) {
    console.error('Failed to reschedule post:', error);
    res.status(500).json({ error: 'Failed to reschedule post' });
  }
}

/**
 * Cancel a scheduled post
 * DELETE /api/posts/:postId
 */
export async function cancelPost(req: Request, res: Response) {
  try {
    const { postId } = req.params;

    await schedulingService.cancelScheduled(postId);

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to cancel post:', error);
    res.status(500).json({ error: 'Failed to cancel post' });
  }
}
```

---

## Step 7: Database Indexes (CRITICAL for Performance)

```typescript
// database/indexes.ts

import { WorkflowRunModel } from '@classytic/streamline/storage';

/**
 * Create composite indexes for multi-tenant scheduled workflow queries
 * IMPORTANT: tenantId MUST be first in the index for efficient querying
 */
export async function createIndexes() {
  const collection = WorkflowRunModel.collection;

  // Index 1: Multi-tenant scheduled workflow polling
  // Query: tenantId + status='draft' + executionTime <= now + paused=false
  await collection.createIndex(
    {
      'context.tenantId': 1,
      status: 1,
      'scheduling.executionTime': 1,
      paused: 1,
    },
    { name: 'mt_scheduled_workflow_poll' }
  );

  // Index 2: List workflows by tenant and client
  // Query: tenantId + clientId + sort by createdAt
  await collection.createIndex(
    {
      'context.tenantId': 1,
      'context.clientId': 1,
      createdAt: -1,
    },
    { name: 'mt_workflow_list' }
  );

  // Index 3: Multi-tenant workflow by ID (for updates)
  // Ensures updates are scoped to tenant
  await collection.createIndex(
    {
      'context.tenantId': 1,
      _id: 1,
    },
    { name: 'mt_workflow_by_id' }
  );

  console.log('✓ Multi-tenant indexes created');
}
```

---

## Step 8: Start Scheduler

```typescript
// server.ts

import express from 'express';
import mongoose from 'mongoose';
import { SmartScheduler } from '@classytic/streamline/execution';
import { workflowRepository } from './services/scheduling.service';
import { createIndexes } from './database/indexes';

async function startServer() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI!);

  // Create indexes (run once on startup)
  await createIndexes();

  // Start SmartScheduler
  const scheduler = new SmartScheduler(
    workflowRepository,
    async (runId) => {
      // Resume callback
      await schedulingService.executeNow(runId);
    },
    {
      basePollInterval: 60000, // 1 minute
      maxWorkflowsPerPoll: 1000, // Process up to 1000 scheduled posts per poll
      adaptivePolling: true, // Adjust interval based on load
    }
  );

  // Set retry callback (for failed steps)
  scheduler.setRetryCallback(async (runId) => {
    await schedulingService.executeNow(runId);
  });

  // Start scheduler (lazy start - only polls if workflows exist)
  await scheduler.startIfNeeded();

  // Start Express server
  const app = express();
  app.use(express.json());

  // Routes
  app.post('/api/posts/schedule', schedulePost);
  app.get('/api/posts/scheduled', listScheduledPosts);
  app.patch('/api/posts/:postId/reschedule', reschedulePost);
  app.delete('/api/posts/:postId', cancelPost);

  app.listen(3000, () => {
    console.log('✓ Server running on port 3000');
    console.log('✓ Scheduler active:', scheduler.isHealthy());
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    scheduler.stop();
    await mongoose.disconnect();
    process.exit(0);
  });
}

startServer().catch(console.error);
```

---

## Step 9: Testing Multi-Tenant Isolation

```typescript
// tests/multi-tenant.test.ts

import { schedulingService } from '../services/scheduling.service';

describe('Multi-Tenant Isolation', () => {
  it('should prevent cross-tenant data access', async () => {
    // Schedule post for tenant A
    const tenantA = await schedulingService.schedule({
      scheduledFor: new Date('2024-12-25T09:00:00'),
      timezone: 'America/New_York',
      input: { tenantId: 'tenant-a', clientId: 'client-1', content: 'Post A' },
      tenantId: 'tenant-a',
    });

    // Schedule post for tenant B
    const tenantB = await schedulingService.schedule({
      scheduledFor: new Date('2024-12-25T09:00:00'),
      timezone: 'America/Los_Angeles',
      input: { tenantId: 'tenant-b', clientId: 'client-2', content: 'Post B' },
      tenantId: 'tenant-b',
    });

    // Tenant A should only see their posts
    const tenantAList = await schedulingService.getScheduled({
      tenantId: 'tenant-a',
    });
    expect(tenantAList.data).toHaveLength(1);
    expect(tenantAList.data[0]._id).toBe(tenantA._id);

    // Tenant B should only see their posts
    const tenantBList = await schedulingService.getScheduled({
      tenantId: 'tenant-b',
    });
    expect(tenantBList.data).toHaveLength(1);
    expect(tenantBList.data[0]._id).toBe(tenantB._id);

    // Tenant filtering via getAll - tenant A cannot see tenant B's posts
    const crossTenantQuery = await workflowRepository.getAll({
      filters: { _id: tenantB._id },
      tenantId: 'tenant-a', // Wrong tenant - won't find the document
    });
    expect(crossTenantQuery.docs).toHaveLength(0);
  });

  it('should handle DST transitions correctly', async () => {
    // Schedule during spring forward (2:30 AM doesn't exist)
    const run = await schedulingService.schedule({
      scheduledFor: new Date('2024-03-10T02:30:00'),
      timezone: 'America/New_York',
      input: { tenantId: 'test', clientId: 'test', content: 'Test' },
      tenantId: 'test',
    });

    // Should adjust to 3:30 AM
    expect(run.scheduling?.isDSTTransition).toBe(true);
    expect(run.scheduling?.dstNote).toContain('spring forward');
  });
});
```

---

## Best Practices

### 1. **Always Use Composite Indexes with tenantId First**

```typescript
// ✅ GOOD - tenantId first
await collection.createIndex({
  'context.tenantId': 1,
  status: 1,
  'scheduling.executionTime': 1,
});

// ❌ BAD - tenantId not first (MongoDB can't use index efficiently)
await collection.createIndex({
  status: 1,
  'context.tenantId': 1,
  'scheduling.executionTime': 1,
});
```

### 2. **Use Strict Mode for Multi-Tenant**

```typescript
// ✅ GOOD - strict mode prevents accidental data leaks
const repo = createWorkflowRunRepository({
  multiTenant: {
    tenantField: 'context.tenantId',
    strict: true, // Throws error if tenantId missing
    allowBypass: false, // No admin bypasses
  },
});
```

### 3. **Always Pass tenantId in Queries**

```typescript
// ✅ GOOD
const runs = await repo.getAll({
  filters: { status: 'running' },
  tenantId: req.user.tenantId,
});

// ❌ BAD - will throw error in strict mode
const runs = await repo.getAll({
  filters: { status: 'running' },
});
```

### 4. **Use Keyset Pagination for Large Datasets**

```typescript
// For agencies with 10,000+ scheduled posts
const result = await schedulingService.getScheduled({
  cursor: null, // First page
  limit: 1000,
  tenantId: 'tenant-123',
});

// Next page
const nextResult = await schedulingService.getScheduled({
  cursor: result.nextCursor,
  limit: 1000,
  tenantId: 'tenant-123',
});
```

### 5. **Handle DST Edge Cases**

```typescript
const run = await schedulingService.schedule({
  scheduledFor: new Date('2024-03-10T02:30:00'),
  timezone: 'America/New_York',
  input: { /* ... */ },
  tenantId: 'tenant-123',
});

// Always check and warn users
if (run.scheduling?.isDSTTransition) {
  await notifyUser({
    type: 'dst-warning',
    message: run.scheduling.dstNote,
  });
}
```

---

## Performance Characteristics

| Scenario | Performance | Notes |
|----------|-------------|-------|
| Schedule 1 post | < 50ms | In-memory + MongoDB write |
| Query 100 scheduled posts (tenant) | < 20ms | Uses composite index |
| Scheduler poll (1000 posts) | < 500ms | Keyset pagination |
| Reschedule 1 post | < 30ms | Update + timezone recalc |
| Multi-tenant isolation overhead | ~5ms | Plugin filter injection |

---

## Monitoring

```typescript
import { SmartScheduler } from '@classytic/streamline/execution';

const scheduler = new SmartScheduler(/* ... */);

// Get scheduler stats
setInterval(() => {
  const stats = scheduler.getStats();
  console.log({
    isHealthy: scheduler.isHealthy(),
    pollInterval: scheduler.getCurrentInterval(),
    totalPolls: stats.totalPolls,
    successfulPolls: stats.successfulPolls,
    avgPollDuration: stats.avgPollDuration,
    totalWorkflowsProcessed: stats.totalWorkflowsProcessed,
  });
}, 60000); // Every minute
```

---

## Conclusion

You now have a production-ready multi-tenant workflow scheduling system with:

✅ **Strict Tenant Isolation** - No cross-tenant data leaks
✅ **Timezone-Aware Scheduling** - Handles DST transitions
✅ **Efficient Pagination** - Scales to millions of workflows
✅ **Resource Optimized** - Keyset pagination for O(1) performance
✅ **Production Ready** - Proper indexes, error handling, monitoring

**Next Steps**:
- Add webhooks for post completion notifications
- Implement recurring posts (daily/weekly schedules)
- Add analytics dashboard for post performance
- Integrate more social media platforms

Happy scheduling! 🚀
