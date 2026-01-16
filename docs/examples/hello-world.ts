import { createWorkflow } from '@classytic/streamline';

interface HelloContext {
  name: string;
  greeting?: string;
  timestamp?: Date;
}

export const helloWorld = createWorkflow<HelloContext>('hello-world', {
  steps: {
    greet: async (ctx) => {
      ctx.log('Generating greeting');
      const greeting = `Hello, ${ctx.context.name}!`;
      await ctx.set('greeting', greeting);
      return greeting;
    },
    timestamp: async (ctx) => {
      ctx.log('Adding timestamp');
      const timestamp = new Date();
      await ctx.set('timestamp', timestamp);
      return timestamp;
    },
    log: async (ctx) => {
      const greeting = ctx.context.greeting;
      const timestamp = ctx.context.timestamp;
      ctx.log('Final result', { greeting, timestamp });
      return { greeting, timestamp };
    },
  },
  context: (input: any) => ({ name: input.name }),
  defaults: { retries: 2, timeout: 5000 },
});

// Example usage:
// const run = await helloWorld.start({ name: 'World' });
// console.log('Workflow started:', run._id);
