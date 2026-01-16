import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { createWorkflow } from '../src/index.js';
import { aiPipelineWorkflow } from '../docs/examples/ai-pipeline.js';

describe('AI Pipeline', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect('mongodb://localhost:27017/streamline-test');
    }
  });

  it('should validate input and reject invalid prompts', async () => {
    const run = await aiPipelineWorkflow.start({
      prompt: 'short',
      model: 'gpt-4',
      maxTokens: 500,
    });

    const result = await aiPipelineWorkflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error?.message).toContain('at least 10 characters');

    aiPipelineWorkflow.shutdown();
  });

  it('should execute AI pipeline with quality check', async () => {
    const run = await aiPipelineWorkflow.start({
      prompt: 'Write a comprehensive guide about TypeScript generics and their practical applications',
      model: 'gpt-4',
      maxTokens: 1000,
    });

    const result = await aiPipelineWorkflow.execute(run._id);

    // Should reach review step
    expect(result.context.response).toBeDefined();
    expect(result.context.response?.text).toBeDefined();
    expect(result.context.response?.tokens).toBeGreaterThan(0);
    expect(result.context.quality).toBeDefined();
    expect(result.context.quality?.score).toBeGreaterThanOrEqual(0);
    expect(result.context.quality?.score).toBeLessThanOrEqual(100);

    // Check if it needs human review or auto-approved
    if (result.context.quality!.score >= 60) {
      expect(result.status).toBe('done');
      expect(result.context.approved).toBe(true);
    } else {
      expect(result.status).toBe('waiting');
      const reviewStep = result.steps.find((s) => s.stepId === 'review');
      expect(reviewStep?.status).toBe('waiting');
    }

    aiPipelineWorkflow.shutdown();
  });

  it('should require human review for low quality scores', async () => {
    // Create custom workflow with forced low quality response
    const customWorkflow = createWorkflow('ai-pipeline-test', {
      steps: {
        validateInput: async (ctx) => {
          if (!ctx.context.prompt || ctx.context.prompt.length < 10) {
            throw new Error('Prompt must be at least 10 characters');
          }
          return { valid: true };
        },
        generate: async (ctx) => {
          const mockResponse = {
            text: 'Short response', // Will trigger "Response too short" issue
            tokens: 950,
            cost: 0.002,
          };
          await ctx.set('response', mockResponse);
          return mockResponse;
        },
        qualityCheck: async (ctx) => {
          const response = ctx.context.response!;
          const issues: string[] = [];
          if (response.text.length < 50) issues.push('Response too short');
          // With 1 issue, score = 100 - 50 = 50 (< 60, triggers review)
          const score = Math.max(0, 100 - issues.length * 50);
          const quality = { score, issues };
          await ctx.set('quality', quality);
          return quality;
        },
        review: async (ctx) => {
          if (ctx.context.quality!.score < 60) {
            await ctx.wait('Please review the AI-generated content');
          } else {
            await ctx.set('approved', true);
            return { approved: true };
          }
        },
        finalize: async (ctx) => {
          if (!ctx.context.approved) throw new Error('Content not approved');
          return { status: 'published' };
        },
      },
      context: (input: any) => ({
        prompt: input.prompt,
        model: input.model || 'gpt-4',
        maxTokens: input.maxTokens || 1000,
        response: undefined as any,
        quality: undefined as any,
        approved: false,
      }),
      autoExecute: false,
    });

    const run = await customWorkflow.start({
      prompt: 'Write about TypeScript best practices in detail',
      model: 'gpt-4',
      maxTokens: 1000,
    });

    const result = await customWorkflow.execute(run._id);

    expect(result.status).toBe('waiting');
    expect(result.context.quality!.score).toBeLessThan(60);
    expect(result.context.quality!.issues).toContain('Response too short');

    const reviewStep = result.steps.find((s) => s.stepId === 'review');
    expect(reviewStep?.status).toBe('waiting');
    expect(reviewStep?.waitingFor?.type).toBe('human');

    customWorkflow.shutdown();
  });

  it('should finalize after approval', async () => {
    const run = await aiPipelineWorkflow.start({
      prompt: 'Explain the benefits of functional programming in JavaScript',
      model: 'gpt-4',
      maxTokens: 800,
    });

    const waitingRun = await aiPipelineWorkflow.execute(run._id);

    if (waitingRun.status === 'waiting') {
      const finalRun = await aiPipelineWorkflow.resume(run._id, { approved: true, reviewer: 'editor' });

      expect(finalRun.status).toBe('done');

      const finalizeStep = finalRun.steps.find((s) => s.stepId === 'finalize');
      expect(finalizeStep?.status).toBe('done');
      expect(finalizeStep?.output).toHaveProperty('status', 'published');
    }

    aiPipelineWorkflow.shutdown();
  });

  it('should validate maxTokens range', async () => {
    const run = await aiPipelineWorkflow.start({
      prompt: 'Write about Docker containerization',
      model: 'gpt-4',
      maxTokens: 50, // Below minimum
    });

    const result = await aiPipelineWorkflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].error?.message).toContain('maxTokens must be between 100 and 4000');

    aiPipelineWorkflow.shutdown();
  });
});
