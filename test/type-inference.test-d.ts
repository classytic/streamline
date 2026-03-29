/**
 * Type-level tests — verified by `tsc --noEmit`, not vitest.
 *
 * These ensure consumers get proper inference without manual annotations.
 * If any line here has a red squiggle in the IDE, we broke DX.
 */

import {
  createWorkflow,
  type Workflow,
  type WorkflowConfig,
  type StepConfig,
  type WaitForOptions,
  type WorkflowRun,
} from '../src/index.js';

// ============================================================================
// 1. Workflow type is directly exportable (no TS4023)
// ============================================================================

interface OrderCtx {
  orderId: string;
  email: string;
  total: number;
  shipped: boolean;
}

// This is the exact pattern that failed with TS4023 before the fix.
// If Workflow is not exported, this line errors.
export const orderWorkflow: Workflow<OrderCtx, { id: string; email: string }> =
  createWorkflow('order', {
    steps: {
      validate: async (ctx) => {
        // ctx.context should be OrderCtx — no annotation needed
        const _email: string = ctx.context.email;
        return { valid: true };
      },
    },
    context: (input) => ({ orderId: input.id, email: input.email, total: 0, shipped: false }),
  });

// ============================================================================
// 2. TContext infers in StepConfig.handler, skipIf, runIf, condition
// ============================================================================

const _inferenceTest = createWorkflow<OrderCtx>('inference-test', {
  steps: {
    // Plain handler: ctx.context is OrderCtx
    plain: async (ctx) => {
      const _id: string = ctx.context.orderId;
    },

    // StepConfig handler: ctx.context is still OrderCtx
    configured: {
      handler: async (ctx) => {
        const _total: number = ctx.context.total;
      },
      timeout: 30_000,
      retries: 5,

      // skipIf: ctx is OrderCtx — no annotation needed
      skipIf: (ctx) => ctx.shipped,

      // runIf: ctx is OrderCtx
      runIf: (ctx) => ctx.total > 0,

      // condition: ctx is OrderCtx, run is WorkflowRun
      condition: (ctx, _run) => ctx.email.includes('@'),
    },
  },
  context: () => ({ orderId: '', email: '', total: 0, shipped: false }),
  autoExecute: false,
});

// ============================================================================
// 3. WorkflowConfig is independently typeable
// ============================================================================

const _config: WorkflowConfig<OrderCtx> = {
  steps: {
    step1: async (ctx) => {
      const _x: string = ctx.context.orderId;
    },
    step2: {
      handler: async (ctx) => {
        const _y: boolean = ctx.context.shipped;
      },
      skipIf: (ctx) => ctx.shipped,
    },
  },
  context: () => ({ orderId: '', email: '', total: 0, shipped: false }),
};

// ============================================================================
// 4. WaitForOptions is importable
// ============================================================================

const _opts: WaitForOptions = { pollInterval: 500, timeout: 10_000 };

// ============================================================================
// 5. WorkflowRun generic flows through
// ============================================================================

async function checkRun(wf: Workflow<OrderCtx>) {
  const run: WorkflowRun<OrderCtx> | null = await wf.get('some-id');
  if (run) {
    const _email: string = run.context.email;
  }
}
