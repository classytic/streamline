import { createWorkflow } from '@classytic/streamline';

interface NewsletterContext {
  topic: string;
  audience: 'developers' | 'marketers' | 'executives';
  subscribers?: string[];
  content?: {
    subject: string;
    body: string;
    html: string;
  };
  sent?: {
    total: number;
    successful: number;
    failed: number;
  };
}

export const newsletterWorkflow = createWorkflow<NewsletterContext>('newsletter-automation', {
  steps: {
    fetchSubscribers: async (ctx) => {
      ctx.log('Fetching subscribers for audience', { audience: ctx.context.audience });

      const mockSubscribers = Array.from({ length: 100 }, (_, i) => `user${i}@example.com`);
      await ctx.set('subscribers', mockSubscribers);

      return { count: mockSubscribers.length };
    },
    generateContent: async (ctx) => {
      ctx.log('Generating AI content', { topic: ctx.context.topic });

      // Simulate AI processing time (use regular delay, not ctx.sleep for inline processing)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const content = {
        subject: `Weekly ${ctx.context.topic} Update`,
        body: `Here's your weekly update on ${ctx.context.topic}...`,
        html: `<h1>Weekly ${ctx.context.topic} Update</h1><p>Content here...</p>`,
      };

      await ctx.set('content', content);
      return content;
    },
    review: async (ctx) => {
      ctx.log('Waiting for human review');

      await ctx.wait('Please review the newsletter content', {
        topic: ctx.context.topic,
        subject: ctx.context.content?.subject,
        preview: ctx.context.content?.body.substring(0, 100),
      });
    },
    sendBatch: async (ctx) => {
      const subscribers = ctx.context.subscribers || [];
      const batchSize = 50;
      let successful = 0;
      let failed = 0;

      ctx.log('Sending newsletter', { total: subscribers.length });

      for (let i = 0; i < subscribers.length; i += batchSize) {
        const batch = subscribers.slice(i, i + batchSize);

        try {
          await Promise.all(
            batch.map(async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              const success = Math.random() > 0.05;
              if (success) successful++;
              else failed++;
            })
          );

          ctx.log(`Batch ${Math.floor(i / batchSize) + 1} sent`);
        } catch {
          ctx.log('Batch failed', { batch: Math.floor(i / batchSize) + 1 });
          failed += batch.length;
        }
      }

      const sent = { total: subscribers.length, successful, failed };
      await ctx.set('sent', sent);

      return sent;
    },
    trackResults: async (ctx) => {
      const sent = ctx.context.sent!;
      const successRate = (sent.successful / sent.total) * 100;

      ctx.log('Campaign results', {
        sent: sent.total,
        successRate: `${successRate.toFixed(2)}%`,
      });

      return {
        sent: sent.total,
        successRate,
        timestamp: new Date(),
      };
    },
  },
  context: (input: any) => ({
    topic: input.topic,
    audience: input.audience,
  }),
  defaults: { retries: 3, timeout: 60000 },
});
