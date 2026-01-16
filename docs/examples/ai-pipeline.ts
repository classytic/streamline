import { createWorkflow } from '@classytic/streamline';

interface AIPipelineContext {
  prompt: string;
  model: string;
  maxTokens: number;
  response?: {
    text: string;
    tokens: number;
    cost: number;
  };
  quality?: {
    score: number;
    issues: string[];
  };
  approved?: boolean;
}

export const aiPipelineWorkflow = createWorkflow<AIPipelineContext>('ai-content-pipeline', {
  steps: {
    validateInput: async (ctx) => {
      if (!ctx.context.prompt || ctx.context.prompt.length < 10) {
        throw new Error('Prompt must be at least 10 characters');
      }

      if (ctx.context.maxTokens < 100 || ctx.context.maxTokens > 4000) {
        throw new Error('maxTokens must be between 100 and 4000');
      }

      ctx.log('Input validated');
      return { valid: true };
    },
    generate: async (ctx) => {
      ctx.log('Generating AI response', {
        model: ctx.context.model,
        maxTokens: ctx.context.maxTokens,
      });

      // Simulate AI processing time (use regular delay, not ctx.sleep for inline processing)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const mockResponse = {
        text: `Generated response for: ${ctx.context.prompt.substring(0, 50)}...`,
        tokens: Math.floor(Math.random() * ctx.context.maxTokens),
        cost: 0.002,
      };

      await ctx.set('response', mockResponse);
      ctx.log('AI response generated', { tokens: mockResponse.tokens });

      return mockResponse;
    },
    qualityCheck: async (ctx) => {
      const response = ctx.context.response!;
      const issues: string[] = [];

      if (response.text.length < 50) {
        issues.push('Response too short');
      }

      if (response.tokens > ctx.context.maxTokens * 0.9) {
        issues.push('Approaching token limit');
      }

      const score = Math.max(0, 100 - issues.length * 20);
      const quality = { score, issues };

      await ctx.set('quality', quality);
      ctx.log('Quality check completed', quality);

      return quality;
    },
    review: async (ctx) => {
      const quality = ctx.context.quality!;

      if (quality.score < 60) {
        ctx.log('Quality score low, requiring human review');
        await ctx.wait('Please review the AI-generated content', {
          response: ctx.context.response,
          quality: ctx.context.quality,
        });
      } else {
        ctx.log('Quality score acceptable, auto-approving');
        await ctx.set('approved', true);
        return { approved: true, automatic: true };
      }
    },
    finalize: async (ctx) => {
      const approval = ctx.getOutput<any>('review');
      const isApproved = approval?.approved || ctx.context.approved;

      if (!isApproved) {
        throw new Error('Content not approved');
      }

      ctx.log('Content finalized and stored');
      return {
        status: 'published',
        response: ctx.context.response,
        quality: ctx.context.quality,
        timestamp: new Date(),
      };
    },
  },
  context: (input: any) => ({
    prompt: input.prompt,
    model: input.model || 'gpt-4',
    maxTokens: input.maxTokens || 1000,
  }),
  defaults: { retries: 0, timeout: 60000 },
  autoExecute: false,
});
