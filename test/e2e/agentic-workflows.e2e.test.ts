/**
 * Agentic Workflow Scenarios
 *
 * Tests real-world AI/agent patterns:
 * - AI pipeline with quality gates
 * - Human-in-the-loop approval flows
 * - Multi-step content moderation
 * - Claude Code CLI-style tool orchestration
 * - Retry on transient LLM failures
 * - Checkpoint-based batch processing
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDB, teardownTestDB, cleanupTestDB, waitFor } from '../utils/setup.js';
import {
  createWorkflow,
  createEventSink,
  WorkflowRunModel,
} from '../../src/index.js';

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

// ============================================================================
// AI Content Pipeline — Quality Gate Pattern
// ============================================================================

describe('AI content pipeline with quality gates', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should auto-approve high-quality content', async () => {
    interface PipelineCtx {
      prompt: string;
      content: string;
      qualityScore: number;
      approved: boolean;
    }

    const wf = createWorkflow<PipelineCtx>('ai-pipeline-auto', {
      steps: {
        generate: async (ctx) => {
          // Simulate LLM generation
          await ctx.set('content', `Generated from: ${ctx.context.prompt}`);
          return { generated: true };
        },
        score: async (ctx) => {
          // Simulate quality scoring
          const score = ctx.context.prompt.length > 10 ? 0.95 : 0.3;
          await ctx.set('qualityScore', score);
          ctx.log('Quality score computed', { score });
          return { score };
        },
        gate: {
          handler: async (ctx) => {
            if (ctx.context.qualityScore >= 0.8) {
              await ctx.set('approved', true);
              return { autoApproved: true };
            }
            // Would wait for human review in production
            return ctx.wait('Low quality — needs human review');
          },
          retries: 1,
        },
        publish: {
          handler: async (ctx) => {
            ctx.log('Publishing content', { approved: ctx.context.approved });
            return { published: true, content: ctx.context.content };
          },
          skipIf: (ctx) => !ctx.approved,
        },
      },
      context: (input: { prompt: string }) => ({
        prompt: input.prompt,
        content: '',
        qualityScore: 0,
        approved: false,
      }),
      autoExecute: false,
    });

    const run = await wf.start({ prompt: 'Write a detailed article about TypeScript generics' });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.qualityScore).toBeGreaterThanOrEqual(0.8);
    expect(result.context.approved).toBe(true);

    // Check logs were persisted
    await waitFor(200);
    const doc = await WorkflowRunModel.findById(run._id).lean();
    expect(doc!.stepLogs!.some((l: any) => l.message.includes('Quality score'))).toBe(true);

    wf.shutdown();
  });

  it('should pause for human review on low-quality content', async () => {
    interface PipelineCtx {
      prompt: string;
      qualityScore: number;
    }

    const wf = createWorkflow<PipelineCtx>('ai-pipeline-review', {
      steps: {
        generate: async () => ({ generated: true }),
        score: async (ctx) => {
          await ctx.set('qualityScore', 0.3); // Low score
          return { score: 0.3 };
        },
        gate: async (ctx) => {
          if (ctx.context.qualityScore < 0.8) {
            return ctx.wait('Needs human review', { reason: 'low-score' });
          }
          return { autoApproved: true };
        },
      },
      context: (input: { prompt: string }) => ({
        prompt: input.prompt,
        qualityScore: 0,
      }),
      autoExecute: false,
    });

    const run = await wf.start({ prompt: 'Hi' });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('waiting');
    const waitStep = result.steps.find((s) => s.status === 'waiting');
    expect(waitStep?.waitingFor?.reason).toContain('human review');

    wf.shutdown();
  });
});

// ============================================================================
// Claude Code CLI-Style Tool Orchestration
// ============================================================================

describe('Agentic tool orchestration (CLI-style)', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should orchestrate multi-tool agent workflow with scatter', async () => {
    interface AgentCtx {
      query: string;
      searchResults: string[];
      analysis: string;
    }

    const wf = createWorkflow<AgentCtx>('agent-tools', {
      steps: {
        plan: async (ctx) => {
          ctx.log('Planning agent actions', { query: ctx.context.query });
          return { tools: ['search', 'read', 'analyze'] };
        },
        execute_tools: async (ctx) => {
          // Scatter: run multiple tool calls in parallel with crash recovery
          const results = await ctx.scatter({
            search: async () => {
              return ['result-1', 'result-2', 'result-3'];
            },
            read: async () => {
              return 'File content: hello world';
            },
            analyze: async () => {
              return 'Analysis: everything looks good';
            },
          });

          await ctx.set('searchResults', results.search as string[]);
          await ctx.set('analysis', results.analyze as string);
          return results;
        },
        synthesize: async (ctx) => {
          ctx.log('Synthesizing results', {
            resultCount: ctx.context.searchResults.length,
          });
          return {
            answer: `Found ${ctx.context.searchResults.length} results. ${ctx.context.analysis}`,
          };
        },
      },
      context: (input: { query: string }) => ({
        query: input.query,
        searchResults: [],
        analysis: '',
      }),
      autoExecute: false,
    });

    const run = await wf.start({ query: 'How does streamline compare to Temporal?' });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.searchResults).toHaveLength(3);
    expect(result.context.analysis).toContain('looks good');

    wf.shutdown();
  });

  it('should handle agent step failure with retries and backoff config', async () => {
    let apiCalls = 0;

    const wf = createWorkflow('agent-retry', {
      steps: {
        call_llm: {
          handler: async (ctx) => {
            apiCalls++;
            ctx.log(`LLM call attempt ${apiCalls}`);
            if (apiCalls < 3) {
              const err = new Error('Rate limited');
              (err as any).code = 'RATE_LIMITED';
              throw err;
            }
            return { response: `Success on attempt ${apiCalls}` };
          },
          retries: 3,
          retryDelay: 50, // Short delay = inline retry
          retryBackoff: 'exponential',
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    // Short retryDelay = all retries happen inline within execute()
    const result = await wf.execute(run._id);
    expect(result.status).toBe('done');
    expect(apiCalls).toBe(3); // 2 failures + 1 success

    // Verify step completed
    const step = result.steps.find((s) => s.stepId === 'call_llm');
    expect(step!.status).toBe('done');

    wf.shutdown();
  });
});

// ============================================================================
// Human-in-the-Loop Approval Flows
// ============================================================================

describe('Human-in-the-loop approval workflows', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should support multi-stage approval with resume', async () => {
    interface ApprovalCtx {
      document: string;
      managerApproved: boolean;
    }

    const wf = createWorkflow<ApprovalCtx>('multi-approval', {
      steps: {
        submit: async (ctx) => {
          ctx.log('Document submitted for review');
          return { submitted: true };
        },
        manager_review: async (ctx) => {
          return ctx.wait('Awaiting manager approval', { level: 'manager' });
        },
        director_review: async (ctx) => {
          const managerResult = ctx.getOutput<{ approved: boolean }>('manager_review');
          if (!managerResult?.approved) {
            return { skipped: true, reason: 'Manager rejected' };
          }
          await ctx.set('managerApproved', true);
          return ctx.wait('Awaiting director approval', { level: 'director' });
        },
        finalize: async (ctx) => {
          return { managerApproved: ctx.context.managerApproved };
        },
      },
      context: (input: { document: string }) => ({
        document: input.document,
        managerApproved: false,
      }),
      autoExecute: false,
    });

    // Start workflow
    const run = await wf.start({ document: 'Q1 Budget Proposal' });
    let result = await wf.execute(run._id);

    // Should be waiting for manager
    expect(result.status).toBe('waiting');
    expect(result.steps.find((s) => s.stepId === 'manager_review')?.status).toBe('waiting');

    // Manager approves
    result = await wf.resume(run._id, { approved: true });

    // Should be waiting for director now
    expect(result.status).toBe('waiting');
    expect(result.steps.find((s) => s.stepId === 'director_review')?.status).toBe('waiting');

    // Director approves
    result = await wf.resume(run._id, { approved: true });

    // Should be done
    expect(result.status).toBe('done');
    expect(result.context.managerApproved).toBe(true);

    wf.shutdown();
  });

  it('should handle rejection at any approval stage', async () => {
    const wf = createWorkflow('rejection-flow', {
      steps: {
        review: async (ctx) => {
          return ctx.wait('Awaiting review');
        },
        process: async (ctx) => {
          const decision = ctx.getOutput<{ approved: boolean }>('review');
          if (!decision?.approved) {
            ctx.log('Rejected — skipping processing');
            return { rejected: true };
          }
          return { processed: true };
        },
      },
      autoExecute: false,
    });

    const run = await wf.start({});
    await wf.execute(run._id);

    // Reject
    const result = await wf.resume(run._id, { approved: false });

    // Should continue to process step
    expect(result.status).toBe('done') ;
    const processStep = result.steps.find((s) => s.stepId === 'process');
    expect(processStep?.output).toEqual({ rejected: true });

    wf.shutdown();
  });
});

// ============================================================================
// Batch Processing with Checkpoints
// ============================================================================

describe('Checkpoint-based batch processing (crash-safe)', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should process items in batches and checkpoint progress', async () => {
    const processedItems: string[] = [];

    const wf = createWorkflow<{ items: string[] }>('batch-checkpoint', {
      steps: {
        process: async (ctx) => {
          const checkpoint = ctx.getCheckpoint<{ lastIndex: number }>() ?? { lastIndex: -1 };
          const items = ctx.context.items;

          for (let i = checkpoint.lastIndex + 1; i < items.length; i++) {
            processedItems.push(items[i]);
            await ctx.checkpoint<{ lastIndex: number }>({ lastIndex: i });
            await ctx.heartbeat();
          }

          return { total: items.length };
        },
      },
      context: (input: { items: string[] }) => ({ items: input.items }),
      autoExecute: false,
    });

    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const run = await wf.start({ items });
    const result = await wf.execute(run._id);

    expect(result.status).toBe('done');
    expect(processedItems).toHaveLength(20);
    expect(result.output).toEqual({ total: 20 });

    wf.shutdown();
  });
});

// ============================================================================
// Event-Driven Agent Monitoring
// ============================================================================

describe('Event-driven agent monitoring', () => {
  afterEach(async () => {
    await cleanupTestDB();
  });

  it('should emit events for each step transition — trackable externally', async () => {
    const timeline: Array<{ event: string; stepId?: string; ts: number }> = [];
    const start = Date.now();

    const wf = createWorkflow('monitored-agent', {
      steps: {
        plan: async (ctx) => {
          ctx.log('Planning');
          return { plan: 'search+analyze' };
        },
        search: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { results: 3 };
        },
        respond: async () => {
          return { answer: 'Done' };
        },
      },
      autoExecute: false,
    });

    const unsub = createEventSink(
      wf.container.eventBus,
      {
        events: [
          'step:started',
          'step:completed',
          'workflow:started',
          'workflow:completed',
        ],
      },
      (event, payload: any) => {
        timeline.push({
          event,
          stepId: payload.stepId,
          ts: Date.now() - start,
        });
      },
    );

    const run = await wf.start({});
    await wf.execute(run._id);

    // Verify complete timeline
    const events = timeline.map((t) => t.event);
    expect(events).toContain('workflow:started');
    expect(events).toContain('step:started');
    expect(events).toContain('step:completed');
    expect(events).toContain('workflow:completed');

    // Step events should have stepIds
    const stepEvents = timeline.filter((t) => t.stepId);
    const stepIds = [...new Set(stepEvents.map((t) => t.stepId))];
    expect(stepIds).toContain('plan');
    expect(stepIds).toContain('search');
    expect(stepIds).toContain('respond');

    // Timeline should be monotonically increasing
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].ts).toBeGreaterThanOrEqual(timeline[i - 1].ts);
    }

    unsub();
    wf.shutdown();
  });
});
