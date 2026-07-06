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

// ============================================================================
// 6. Typed step outputs (v2.6 TOutputs) — output types flow into later steps
// ============================================================================

import { expectTypeOf } from 'vitest';

interface ScrapeOutputs {
  fetch: { html: string };
  parse: { items: number };
}

const _typedOutputs = createWorkflow<{ url: string }, { url: string }, ScrapeOutputs>('scrape-t', {
  steps: {
    fetch: async () => ({ html: '' }),
    parse: async (ctx) => {
      // Sibling step output type flows into ctx.outputs (undefined until done).
      expectTypeOf(ctx.outputs.fetch).toEqualTypeOf<{ html: string } | undefined>();
      expectTypeOf(ctx.outputs.fetch?.html).toEqualTypeOf<string | undefined>();

      // Own declared output type is visible too.
      expectTypeOf(ctx.outputs.parse).toEqualTypeOf<{ items: number } | undefined>();

      // @ts-expect-error — typo'd step id is a compile error, not `unknown`.
      ctx.outputs.fetsh;

      // @ts-expect-error — output properties keep their declared types.
      const _wrong: number | undefined = ctx.outputs.fetch?.html;

      return { items: ctx.outputs.fetch?.html.length ?? 0 };
    },
  },
  context: (input) => ({ url: input.url }),
  autoExecute: false,
});

// With a declared TOutputs the steps map is checked both ways:
createWorkflow<{ url: string }, { url: string }, ScrapeOutputs>('scrape-t-bad', {
  steps: {
    fetch: async () => ({ html: '' }),
    // @ts-expect-error — handler return type must match the declared output.
    parse: async () => ({ items: 'not-a-number' }),
  },
  context: (input) => ({ url: input.url }),
  autoExecute: false,
});

// Without the generic, behavior is 2.5-compatible: ctx.outputs.x is unknown.
createWorkflow<{ url: string }>('scrape-untyped', {
  steps: {
    only: async (ctx) => {
      expectTypeOf(ctx.outputs.anything).toEqualTypeOf<unknown>();
      return 1;
    },
  },
  context: () => ({ url: '' }),
  autoExecute: false,
});
