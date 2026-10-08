import { describe, expect, it } from 'vitest';
import { useStreamlineEnv } from '../../helpers/index.js';

const env = useStreamlineEnv();

interface ParallelContext {
  urls: string[];
  results?: Array<{ url: string; data: string; duration: number }>;
  fastest?: { url: string; data: string };
}

type ParallelInput = { urls: string[] };

describe('Parallel Workflow', () => {
  it('should execute steps in parallel (all mode)', async () => {
    const workflow = env.workflow<ParallelContext, ParallelInput>('parallel-all-test', {
      steps: {
        fetchAll: async (ctx) => {
          const urls = ctx.context.urls;
          const startTime = Date.now();

          const results = await Promise.all(
            urls.map(async (url) => {
              const delay = Math.random() * 100;
              await new Promise((resolve) => setTimeout(resolve, delay));
              return {
                url,
                data: `Data from ${url}`,
                duration: delay,
              };
            }),
          );

          const totalDuration = Date.now() - startTime;
          await ctx.set('results', results);

          ctx.log('All URLs fetched', {
            count: results.length,
            totalDuration,
          });

          return { count: results.length, totalDuration };
        },
        process: async (ctx) => {
          const results = ctx.context.results;
          if (!results) throw new Error('fetchAll results missing');
          ctx.log('Processing results', { count: results.length });
          return { processed: results.length };
        },
      },
      context: (input) => ({ urls: input.urls }),
    });

    const run = await workflow.start({
      urls: ['http://api1.example.com', 'http://api2.example.com', 'http://api3.example.com'],
    });

    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.results).toHaveLength(3);
    expect(result.context.results?.[0]).toHaveProperty('url');
    expect(result.context.results?.[0]).toHaveProperty('data');
  });

  it('should execute with race mode (fastest wins)', async () => {
    const workflow = env.workflow<ParallelContext, ParallelInput>('parallel-race-test', {
      steps: {
        fetchFastest: async (ctx) => {
          const urls = ctx.context.urls;

          const fastest = await Promise.race(
            urls.map(async (url, index) => {
              const delay = index * 50; // First URL will be fastest
              await new Promise((resolve) => setTimeout(resolve, delay));
              return {
                url,
                data: `Data from ${url}`,
              };
            }),
          );

          await ctx.set('fastest', fastest);
          ctx.log('Fastest URL fetched', { url: fastest.url });

          return fastest;
        },
      },
      context: (input) => ({ urls: input.urls }),
    });

    const run = await workflow.start({
      urls: ['http://fast.example.com', 'http://slow.example.com', 'http://slower.example.com'],
    });

    const result = await workflow.execute(run._id);

    expect(result.status).toBe('done');
    expect(result.context.fastest).toBeDefined();
    expect(result.context.fastest?.url).toBe('http://fast.example.com');
  });

  it('should handle parallel execution errors gracefully', async () => {
    const workflow = env.workflow<ParallelContext, ParallelInput>('parallel-error-test', {
      steps: {
        fetchWithError: async (ctx) => {
          const urls = ctx.context.urls;

          await Promise.all(
            urls.map(async (url) => {
              if (url.includes('error')) {
                throw new Error(`Failed to fetch ${url}`);
              }
              return { url, data: `Data from ${url}` };
            }),
          );
        },
      },
      context: (input) => ({ urls: input.urls }),
      defaults: { retries: 0 },
    });

    const run = await workflow.start({
      urls: ['http://good.example.com', 'http://error.example.com'],
    });

    const result = await workflow.execute(run._id);

    expect(result.status).toBe('failed');
    expect(result.steps[0].status).toBe('failed');
  });
});
