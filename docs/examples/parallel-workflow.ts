import { createWorkflow } from '@classytic/streamline';

interface ParallelContext {
  urls: string[];
  results?: Array<{ url: string; data: any; duration: number; success: boolean }>;
  summary?: { total: number; successful: number; failed: number };
}

export const parallelWorkflow = createWorkflow<ParallelContext>('parallel-fetcher', {
  steps: {
    setup: async (ctx) => {
      ctx.log('Starting parallel fetch', { count: ctx.context.urls.length });
      return { ready: true };
    },
    fetch: async (ctx) => {
      const fetchPromises = ctx.context.urls.map(async (url) => {
        const start = Date.now();
        try {
          const response = await fetch(url);
          const data = await response.json();
          const duration = Date.now() - start;
          return { url, data, duration, success: true };
        } catch (error: any) {
          const duration = Date.now() - start;
          return { url, error: error.message, duration, success: false };
        }
      });

      const results = await Promise.all(fetchPromises);
      await ctx.set('results', results);
      return results;
    },
    process: async (ctx) => {
      const results = ctx.context.results || [];
      const processed = results.map((r) => ({
        url: r.url,
        success: r.success,
        duration: r.duration,
      }));

      ctx.log('Processed all results', { count: processed.length });
      return processed;
    },
    summarize: async (ctx) => {
      const results = ctx.context.results || [];
      const summary = {
        total: results.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        avgDuration: results.reduce((sum, r) => sum + r.duration, 0) / results.length,
      };

      await ctx.set('summary', summary);
      ctx.log('Summary generated', summary);
      return summary;
    },
  },
  context: (input: any) => ({ urls: input.urls }),
});
