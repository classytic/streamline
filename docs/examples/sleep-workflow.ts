import { createWorkflow } from '@classytic/streamline';

interface SleepContext {
  message: string;
  startTime?: Date;
  endTime?: Date;
}

export const sleepWorkflow = createWorkflow<SleepContext>('sleep-demo', {
  steps: {
    start: async (ctx) => {
      const startTime = new Date();
      await ctx.set('startTime', startTime);
      ctx.log('Starting', { startTime });
      return startTime;
    },
    sleep: async (ctx) => {
      ctx.log('Sleeping for 2 seconds...');
      await ctx.sleep(2000);
      ctx.log('Woke up!');
      return { slept: true };
    },
    end: async (ctx) => {
      const endTime = new Date();
      await ctx.set('endTime', endTime);
      const duration = endTime.getTime() - ctx.context.startTime!.getTime();
      ctx.log('Completed', { endTime, duration });
      return { duration };
    },
  },
  context: (input: any) => ({ message: input.message }),
  autoExecute: false,
});
