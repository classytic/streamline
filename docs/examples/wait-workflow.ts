import { createWorkflow } from '@classytic/streamline';

interface ApprovalContext {
  request: string;
  requestedBy: string;
  approval?: {
    approved: boolean;
    approvedBy: string;
    reason?: string;
  };
}

export const approvalWorkflow = createWorkflow<ApprovalContext>('approval-flow', {
  steps: {
    submit: async (ctx) => {
      ctx.log('Request submitted', {
        request: ctx.context.request,
        by: ctx.context.requestedBy,
      });
      return { submitted: true, at: new Date() };
    },
    wait: async (ctx) => {
      ctx.log('Waiting for approval');
      await ctx.wait('Please approve or reject this request', {
        request: ctx.context.request,
        requestedBy: ctx.context.requestedBy,
      });
    },
    process: async (ctx) => {
      const approval = ctx.getOutput<any>('wait');
      await ctx.set('approval', approval);

      if (approval.approved) {
        ctx.log('Request approved!', approval);
        return { status: 'approved', ...approval };
      } else {
        ctx.log('Request rejected', approval);
        return { status: 'rejected', ...approval };
      }
    },
  },
  context: (input: any) => ({
    request: input.request,
    requestedBy: input.requestedBy,
  }),
});
