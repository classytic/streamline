# Streamline Quick Start

Get started with @classytic/streamline in 5 minutes.

## Installation

```bash
npm install @classytic/streamline mongoose
```

## 1. Basic Workflow

```typescript
import mongoose from 'mongoose';
import { createWorkflow } from '@classytic/streamline';

// Connect
await mongoose.connect('mongodb://localhost/myapp');

// Define workflow with inline handlers
const workflow = createWorkflow<{ name: string }>('hello-world', {
  steps: {
    greet: async (ctx) => {
      console.log(`Hello, ${ctx.context.name}!`);
      return { greeted: true };
    },
  },
  context: (input) => ({ name: input.name }),
});

// Execute
const run = await workflow.start({ name: 'World' });
```

## 2. Wait for Human Input

```typescript
import { createWorkflow, resumeHook, createHook } from '@classytic/streamline';

const approval = createWorkflow<{ data: unknown }>('approval', {
  steps: {
    submit: async (ctx) => {
      console.log('Submitted:', ctx.context.data);
      return { submitted: true };
    },
    wait: async (ctx) => {
      const hook = createHook(ctx, 'awaiting-approval');
      console.log('Resume URL:', hook.path);
      return ctx.wait('Please approve', { data: ctx.context.data });
    },
    process: async (ctx) => {
      const approval = ctx.getOutput('wait');
      console.log('Processing with approval:', approval);
      return { processed: true };
    },
  },
  context: (input) => ({ data: input.data }),
});

// Start workflow - executes until wait
const run = await approval.start({ data: { amount: 100 } });
console.log('Status:', run.status); // 'waiting'

// Later, from API endpoint - resume the workflow
// The token is in format: runId:stepId:timestamp
const { run: resumed } = await resumeHook(token, { approved: true, approver: 'admin' });
```

## 3. Sleep/Timer

```typescript
import { createWorkflow } from '@classytic/streamline';

const scheduled = createWorkflow<{ taskId: string }>('scheduled', {
  steps: {
    start: async (ctx) => {
      console.log('Starting at', new Date());
      return { started: Date.now() };
    },
    sleep: async (ctx) => {
      await ctx.sleep(3600000);
    },
    continue: async (ctx) => {
      console.log('Continuing at', new Date());
      return { continued: Date.now() };
    },
  },
  context: (input) => ({ taskId: input.taskId }),
});

const run = await scheduled.start({ taskId: 'task-123' });
```

## 4. Context Management

```typescript
import { createWorkflow } from '@classytic/streamline';

interface OrderContext {
  orderId: string;
  amount: number;
  status: string;
  paid?: boolean;
}

const order = createWorkflow<OrderContext>('order', {
  steps: {
    validate: async (ctx) => {
      // Access context
      console.log('Order:', ctx.context.orderId);
      // Update context (persisted to DB)
      await ctx.set('status', 'validated');
      return { valid: true };
    },
    process: async (ctx) => {
      // Get previous step output
      const validation = ctx.getOutput<{ valid: boolean }>('validate');
      if (!validation?.valid) throw new Error('Not validated');

      await ctx.set('paid', true);
      await ctx.set('status', 'paid');
      return { transactionId: 'txn_123' };
    },
  },
  context: (input) => ({
    orderId: input.orderId,
    amount: input.amount,
    status: 'pending',
  }),
});
```

## 5. Parallel Execution

```typescript
import { createWorkflow, executeParallel } from '@classytic/streamline';

const parallel = createWorkflow<{ urls: string[] }>('parallel-fetch', {
  steps: {
    fetchAll: async (ctx) => {
      const results = await executeParallel(
        ctx.context.urls.map(url => () => fetch(url).then(r => r.json())),
        { mode: 'all' } // 'all' | 'race' | 'allSettled'
      );
      return { results };
    },
    fetchSimple: async (ctx) => {
      const results = await Promise.all(
        ctx.context.urls.map(url => fetch(url))
      );
      return { results };
    },
  },
  context: (input) => ({ urls: input.urls }),
});
```

## 6. Conditional Steps

```typescript
import { createWorkflow, conditions } from '@classytic/streamline';

interface ShippingContext { priority: 'express' | 'standard'; orderId: string }

const shipping = createWorkflow<ShippingContext>('shipping', {
  steps: {
    express: {
      handler: async (ctx) => {
        console.log('Express shipping for', ctx.context.orderId);
        return { method: 'express', eta: '1 day' };
      },
      condition: conditions.equals('priority', 'express'),
    },
    standard: {
      handler: async (ctx) => {
        console.log('Standard shipping for', ctx.context.orderId);
        return { method: 'standard', eta: '5 days' };
      },
      condition: conditions.equals('priority', 'standard'),
    },
  },
  context: (input) => ({ priority: input.priority, orderId: input.orderId }),
});

// Only one step executes based on priority
const run = await shipping.start({ priority: 'express', orderId: 'ord-123' });
```

## 7. Error Handling & Retry

```typescript
import { createWorkflow } from '@classytic/streamline';

const apiWorkflow = createWorkflow<{ endpoint: string }>('api-workflow', {
  steps: {
    callApi: {
      handler: async (ctx) => {
        const response = await fetch(ctx.context.endpoint, { signal: ctx.signal });
        if (!response.ok) throw new Error('API call failed'); // Will retry
        return await response.json();
      },
      retries: 3,    // Retry up to 3 times (exponential backoff)
      timeout: 30000, // 30 second timeout per attempt
    },
  },
  context: (input) => ({ endpoint: input.endpoint }),
  defaults: {
    retries: 2,     // Default for all steps
    timeout: 60000, // Default timeout
  },
});
```

## Next Steps

1. **Explore Features**: See [STEP_FEATURES.md](./STEP_FEATURES.md)
2. **Read Examples**: Check [examples/](./examples)
3. **Run Tests**: See [TESTING.md](../TESTING.md)
4. **Read Full Docs**: See [README.md](../README.md)
