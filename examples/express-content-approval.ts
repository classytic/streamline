/**
 * Express Content Approval Example
 *
 * Real-world content moderation workflow with:
 * - AI moderation check
 * - Human review for flagged content
 * - Multi-step approval chain
 * - Scheduled publishing
 * - Analytics tracking
 */

import express from 'express';
import mongoose from 'mongoose';
import { createWorkflow, WorkflowRunModel } from '../src/index.js';
import type { StepContext } from '../src/index.js';

// ============ Domain Types ============

interface ContentContext {
  contentId: string;
  authorId: string;
  title: string;
  body: string;
  aiScore?: number;
  flagged?: boolean;
  reviewed?: boolean;
  publishedAt?: Date;
}

interface ContentInput {
  contentId: string;
  authorId: string;
  title: string;
  body: string;
}

// ============ Workflow Definition ============

const contentWorkflow = createWorkflow<ContentContext, ContentInput>('content-approval', {
  steps: {
    'ai-check': async (ctx: StepContext<ContentContext>) => {
      ctx.log(`Running AI moderation for ${ctx.context.contentId}...`);

      // Simulate AI moderation API
      // In real app: await openai.moderations.create(...)
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Random score for demo (0-1, lower is better)
      const aiScore = Math.random();
      await ctx.set('aiScore', aiScore);

      const flagged = aiScore > 0.7; // Flag if score > 0.7
      await ctx.set('flagged', flagged);

      ctx.log(`AI Score: ${aiScore.toFixed(2)} ${flagged ? 'FLAGGED' : 'CLEAN'}`);

      return { aiScore, flagged, categories: flagged ? ['violence', 'hate'] : [] };
    },

    'human-review': async (ctx: StepContext<ContentContext>) => {
      // Only run if flagged
      if (ctx.context.flagged) {
        ctx.log(`Flagged content - waiting for human review...`);

        await ctx.wait('Content flagged for moderation', {
          contentId: ctx.context.contentId,
          title: ctx.context.title,
          aiScore: ctx.context.aiScore,
          author: ctx.context.authorId,
        });

        // Pauses here until moderator approves/rejects
      }

      return { reviewed: true };
    },

    schedule: async (ctx: StepContext<ContentContext>) => {
      ctx.log(`Scheduling publication...`);

      // Schedule for 10 seconds from now (demo)
      const publishAt = new Date(Date.now() + 10000);

      ctx.log(`Publishing at: ${publishAt.toISOString()}`);

      // Sleep until publish time
      await ctx.sleep(10000);

      return { publishAt };
    },

    publish: async (ctx: StepContext<ContentContext>) => {
      ctx.log(`Publishing content...`);

      const publishedAt = new Date();
      await ctx.set('publishedAt', publishedAt);

      // Simulate database update
      // In real app: await Content.updateOne({ _id }, { status: 'published', publishedAt })
      await new Promise((resolve) => setTimeout(resolve, 500));

      return {
        published: true,
        publishedAt,
        url: `https://example.com/posts/${ctx.context.contentId}`,
      };
    },

    notify: async (ctx: StepContext<ContentContext>) => {
      ctx.log(`Notifying author...`);

      const publishData = ctx.getOutput<{ url: string }>('publish');

      // Simulate email/notification
      // In real app: await sendEmail(author, 'Your post is live!', publishData.url)
      await new Promise((resolve) => setTimeout(resolve, 300));

      return {
        notified: true,
        url: publishData?.url,
      };
    },
  },
  context: (input) => ({
    contentId: input.contentId,
    authorId: input.authorId,
    title: input.title,
    body: input.body,
  }),
  version: '1.0.0',
  defaults: { retries: 2 },
});

// ============ Express Server ============

async function main() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/content');

  // Create Express app
  const app = express();
  app.use(express.json());

  // Request logging
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  // ============ Routes ============

  // Submit content for approval
  app.post('/content', async (req, res) => {
    const { authorId, title, body } = req.body;

    if (!authorId || !title || !body) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const contentId = `POST-${Date.now()}`;

      const run = await contentWorkflow.start({
        contentId,
        authorId,
        title,
        body,
      });

      res.json({
        contentId,
        workflowRunId: run._id,
        status: run.status,
        message: 'Content submitted for moderation',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Get content status
  app.get('/content/:runId', async (req, res) => {
    const { runId } = req.params;

    try {
      const run = await contentWorkflow.get(runId);

      if (!run) {
        return res.status(404).json({ error: 'Content not found' });
      }

      res.json({
        contentId: run.context.contentId,
        title: run.context.title,
        status: run.status,
        currentStep: run.currentStepId,
        aiScore: run.context.aiScore,
        flagged: run.context.flagged,
        publishedAt: run.context.publishedAt,
        steps: run.steps.map((s) => ({
          step: s.stepId,
          status: s.status,
          output: s.output,
        })),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Approve flagged content
  app.post('/content/:runId/approve', async (req, res) => {
    const { runId } = req.params;
    const { moderatorId, approved, reason } = req.body;

    try {
      if (approved) {
        // Approve and continue
        await contentWorkflow.resume(runId, {
          approved: true,
          moderatorId,
          moderatedAt: new Date(),
        });

        res.json({ message: 'Content approved' });
      } else {
        // Reject and cancel workflow
        await contentWorkflow.cancel(runId);

        res.json({ message: 'Content rejected', reason });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Get pending reviews (for moderator dashboard)
  app.get('/moderation/queue', async (_req, res) => {
    try {
      const pendingReviews = await WorkflowRunModel.find({
        workflowId: 'content-approval',
        status: 'waiting',
        currentStepId: 'human-review',
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      res.json({
        count: pendingReviews.length,
        reviews: pendingReviews.map((r) => ({
          runId: r._id,
          contentId: (r.context as ContentContext).contentId,
          title: (r.context as ContentContext).title,
          author: (r.context as ContentContext).authorId,
          aiScore: (r.context as ContentContext).aiScore,
          submittedAt: r.createdAt,
        })),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Health & stats
  app.get('/health', (_req, res) => {
    const stats = contentWorkflow.engine.getSchedulerStats();

    res.json({
      status: 'healthy',
      scheduler: {
        isPolling: stats.isPolling,
        interval: stats.pollInterval,
        activeWorkflows: stats.activeWorkflows,
        totalPolls: stats.totalPolls,
        healthy: contentWorkflow.engine.isSchedulerHealthy(),
      },
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    });
  });

  // Scheduler metrics
  app.get('/metrics', (_req, res) => {
    res.json(contentWorkflow.engine.getSchedulerStats());
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000', 10);

  app.listen(port, () => {
    console.log(`\nServer running on http://localhost:${port}`);
    console.log(`\nExample requests:`);
    console.log(`  POST http://localhost:${port}/content`);
    console.log(`       Body: {"authorId": "user123", "title": "My Post", "body": "Content..."}`);
    console.log(`  GET  http://localhost:${port}/content/:runId`);
    console.log(`  POST http://localhost:${port}/content/:runId/approve`);
    console.log(`       Body: {"moderatorId": "mod123", "approved": true}`);
    console.log(`  GET  http://localhost:${port}/moderation/queue`);
    console.log(`  GET  http://localhost:${port}/health`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    contentWorkflow.shutdown();
    await mongoose.connection.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export { contentWorkflow };
