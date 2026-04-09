# @classytic/streamline

> MongoDB-native durable workflow engine. Idempotency, concurrency control, event triggers, human-in-the-loop — zero infrastructure beyond MongoDB.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Application                          │
│         createWorkflow() / WorkflowEngine                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Execution Layer                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  StepExecutor   │  │ SmartScheduler  │  │  EventBus   │  │
│  │  • Retry logic  │  │ • Adaptive poll │  │ • Lifecycle │  │
│  │  • Timeouts     │  │ • Circuit break │  │   events    │  │
│  │  • Atomic claim │  │ • Stale recovery│  │             │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Storage Layer                              │
│  ┌─────────────────────────────┐  ┌───────────────────────┐ │
│  │  MongoDB (via Mongoose)     │  │  LRU Cache (10K max)  │ │
│  │  • WorkflowRun persistence  │  │  • Active workflows   │ │
│  │  • Atomic updates           │  │  • O(1) operations    │ │
│  │  • Multi-tenant support     │  │  • Auto-eviction      │ │
│  └─────────────────────────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**State Machine:**
```
draft → running → waiting ↔ running → done
                     ↓           ↓
                  failed     cancelled
```

## Installation

```bash
npm install @classytic/streamline @classytic/mongokit mongoose
```

## Quick Start

```typescript
import mongoose from 'mongoose';
import { createWorkflow } from '@classytic/streamline';

// IMPORTANT: Connect to MongoDB first (reuses your existing connection)
await mongoose.connect('mongodb://localhost/myapp');

// Define workflow with inline handlers
const scraper = createWorkflow('web-scraper', {
  steps: {
    fetch: async (ctx) => {
      const html = await fetch(ctx.context.url).then(r => r.text());
      return { html };
    },
    parse: async (ctx) => {
      const data = parseHTML(ctx.getOutput('fetch').html);
      return { data };
    },
    save: async (ctx) => {
      await db.save(ctx.getOutput('parse').data);
      return { saved: true };
    }
  },
  context: (input: any) => ({ url: input.url }),
  version: '1.0.0',
});

// Execute
const run = await scraper.start({ url: 'https://example.com' });
```

## Distributed Primitives (v2.1)

### Idempotent Starts

```typescript
// Only one active run per key. Reusable after completion/failure.
const run = await workflow.start(input, { idempotencyKey: `order:${orderId}` });
const dup = await workflow.start(input, { idempotencyKey: `order:${orderId}` });
// dup._id === run._id (returns existing non-terminal run)
```

### Concurrency Control

```typescript
const payments = createWorkflow('charge', {
  steps: { ... },
  // Max 5 concurrent runs per userId. Excess queued as draft, auto-promoted when slots free.
  concurrency: { limit: 5, key: (input) => input.userId },
});
```

### Event Triggers

```typescript
const onboarding = createWorkflow('onboard', {
  steps: { ... },
  trigger: { event: 'user.created' }, // Auto-starts when event fires
});
```

### Reactive Cancellation

```typescript
const order = createWorkflow('process-order', {
  steps: { ... },
  cancelOn: [{ event: 'order.cancelled' }], // Auto-cancels on event
});
```

### Priority

```typescript
// Higher priority = picked up first by scheduler
await workflow.start(input, { priority: 10 });
```

### Non-Retriable Errors

```typescript
import { NonRetriableError } from '@classytic/streamline';

async (ctx) => {
  if (!valid(ctx.input)) throw new NonRetriableError('Bad input — no retry');
};
```

### Centralized Logger

```typescript
import { configureStreamlineLogger } from '@classytic/streamline';

configureStreamlineLogger({ enabled: false });          // Silence all
configureStreamlineLogger({ level: 'debug' });          // Verbose
configureStreamlineLogger({ transport: pinoAdapter });   // Custom transport
```

## Core Features

### 1. Wait for Human Input

```typescript
const approval = createWorkflow('approval-flow', {
  steps: {
    submit: async (ctx) => ({ submitted: true }),
    wait: async (ctx) => {
      await ctx.wait('Please approve', { request: ctx.context.data });
      // Execution pauses here
    },
    execute: async (ctx) => {
      const approval = ctx.getOutput('wait');
      return { done: true, approved: approval };
    }
  },
  context: (input: any) => ({ data: input })
});

// Later, resume
await approval.resume(runId, { approved: true, by: 'admin' });
```

### 2. Sleep/Timers

```typescript
const workflow = createWorkflow('delayed-task', {
  steps: {
    start: async (ctx) => ({ ready: true }),
    wait: async (ctx) => {
      await ctx.sleep(3600000); // Sleep 1 hour
    },
    complete: async (ctx) => ({ done: true })
  },
  context: () => ({})
});
```

### 3. Parallel Execution

Use the `parallel` helper from the features module:

```typescript
import { createWorkflow, executeParallel } from '@classytic/streamline';

const workflow = createWorkflow('parallel-fetch', {
  steps: {
    fetchAll: async (ctx) => {
      // Execute multiple tasks in parallel
      const results = await executeParallel([
        () => fetch('https://api1.example.com'),
        () => fetch('https://api2.example.com'),
        () => fetch('https://api3.example.com')
      ], { mode: 'all' }); // or 'race', 'any'
      
      return { results };
    }
  },
  context: () => ({})
});
```

### 4. Per-Step Timeout, Retries & Conditions

Mix plain handlers with `StepConfig` objects for fine-grained control. `TContext` infers everywhere — zero annotations needed:

```typescript
import { createWorkflow } from '@classytic/streamline';

const pipeline = createWorkflow<{ shouldDeploy: boolean }>('ci-pipeline', {
  steps: {
    // Plain handler — zero ceremony
    clone: async (ctx) => {
      return { repo: 'cloned' };
    },

    // StepConfig — per-step timeout and retries
    build: {
      handler: async (ctx) => {
        return { artifact: 'build.tar.gz' };
      },
      timeout: 120_000,   // 2 min timeout (this step only)
      retries: 5,         // 5 attempts (this step only)
    },

    // StepConfig — conditional execution
    deploy: {
      handler: async (ctx) => {
        return { deployed: true };
      },
      timeout: 300_000,
      skipIf: (ctx) => !ctx.shouldDeploy, // ctx is typed as your TContext
    },
  },
  context: (input: any) => ({ shouldDeploy: input.deploy }),
  defaults: { retries: 3, timeout: 30_000 }, // Fallback for plain handlers
});
```

### 5. Wait for Completion

Use `waitFor` to synchronously wait for a workflow to finish:

```typescript
const workflow = createWorkflow('data-pipeline', {
  steps: {
    fetch: async (ctx) => fetchData(ctx.input.url),
    process: async (ctx) => processData(ctx.getOutput('fetch')),
    save: async (ctx) => saveResults(ctx.getOutput('process')),
  },
  context: () => ({})
});

// Start and wait for completion
const run = await workflow.start({ url: 'https://api.example.com/data' });
const completed = await workflow.waitFor(run._id, {
  timeout: 60000,      // Optional: fail after 60s
  pollInterval: 500    // Optional: check every 500ms (default: 1000ms)
});

console.log(completed.status);  // 'done' | 'failed' | 'cancelled'
console.log(completed.output);  // Final step output
```

### 6. Long-Running Steps (Heartbeat)

For steps that run longer than 5 minutes, use `ctx.heartbeat()` to prevent stale detection:

```typescript
const workflow = createWorkflow('large-dataset', {
  steps: {
    process: async (ctx) => {
      const batches = splitIntoBatches(ctx.input.data, 1000);

      for (const batch of batches) {
        await processBatch(batch);
        await ctx.heartbeat();  // Signal we're still alive
      }

      return { processed: batches.length };
    }
  },
  context: () => ({})
});
```

> Note: Heartbeats are sent automatically every 30s during step execution. Use `ctx.heartbeat()` for extra control in very long-running loops.

## Multi-Tenant & Indexing

### Add Custom Indexes

```typescript
import { WorkflowRunModel } from '@classytic/streamline';

// On app startup
await WorkflowRunModel.collection.createIndex({
  'context.tenantId': 1,
  status: 1
});

await WorkflowRunModel.collection.createIndex({
  'context.url': 1,
  workflowId: 1
});

// TTL index for auto-cleanup (expire after 30 days)
await WorkflowRunModel.collection.createIndex(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);
```

### Query Workflows

```typescript
// Get all scraper runs
const runs = await WorkflowRunModel.find({
  workflowId: 'web-scraper',
  status: { $in: ['running', 'waiting'] }
}).sort({ createdAt: -1 }).exec();

// Get runs for specific URL
const urlRuns = await WorkflowRunModel.find({
  workflowId: 'web-scraper',
  'context.url': 'https://example.com'
}).exec();

// Tenant-scoped queries
const tenantRuns = await WorkflowRunModel.find({
  'context.tenantId': 'tenant-123',
  status: 'running'
}).exec();
```

## Tracking Workflow Runs (UI Integration)

### Example: Track Multiple Scraper Runs

```typescript
// scraper-service.ts
export class ScraperService {
  private engine: WorkflowEngine;

  async scrapeWebsite(url: string, userId: string) {
    // Start workflow with metadata
    const run = await this.engine.start(
      { url },
      { userId, startedBy: 'user' }  // meta for tracking
    );

    return {
      runId: run._id,
      status: run.status,
      url
    };
  }

  // Get all scraper runs for UI
  async getAllScraperRuns(filters?: {
    status?: string;
    userId?: string;
    limit?: number;
  }) {
    const query: any = { workflowId: 'web-scraper' };

    if (filters?.status) query.status = filters.status;
    if (filters?.userId) query['meta.userId'] = filters.userId;

    return await WorkflowRunModel.find(query)
      .sort({ createdAt: -1 })
      .limit(filters?.limit || 50)
      .select('_id status context.url currentStepId createdAt updatedAt steps')
      .lean()
      .exec();
  }

  // Get single run with full details
  async getRunDetails(runId: string) {
    const run = await WorkflowRunModel.findById(runId).lean().exec();

    return {
      id: run._id,
      status: run.status,
      url: run.context.url,
      currentStep: run.currentStepId,
      steps: run.steps.map(s => ({
        id: s.stepId,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        error: s.error
      })),
      createdAt: run.createdAt,
      duration: run.endedAt ? run.endedAt - run.createdAt : Date.now() - run.createdAt
    };
  }
}
```

### UI Example (React)

```typescript
// ScraperDashboard.tsx
function ScraperDashboard() {
  const [runs, setRuns] = useState([]);

  useEffect(() => {
    const loadRuns = async () => {
      const response = await fetch('/api/scraper/runs');
      setRuns(await response.json());
    };

    loadRuns();
    const interval = setInterval(loadRuns, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h1>Scraper Runs</h1>
      {runs.map(run => (
        <div key={run.id} className={`run-${run.status}`}>
          <span>{run.url}</span>
          <span>{run.status}</span>
          <span>Step: {run.currentStep}</span>
          <ProgressBar steps={run.steps} />
        </div>
      ))}
    </div>
  );
}
```

## Cleanup Strategies

### Option 1: TTL Index (Auto-Cleanup)

```typescript
// app.ts - On startup
import { WorkflowRunModel } from '@classytic/streamline';

export async function setupAutoCleanup(days = 30) {
  // Auto-delete workflows older than X days
  await WorkflowRunModel.collection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: days * 24 * 60 * 60 }
  );
}

// Only auto-delete completed/failed workflows
await WorkflowRunModel.collection.createIndex(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 7 * 24 * 60 * 60,  // 7 days
    partialFilterExpression: {
      status: { $in: ['done', 'failed', 'cancelled'] }
    }
  }
);
```

### Option 2: Manual Cleanup

```typescript
// cleanup-service.ts
export class CleanupService {
  // Delete old completed workflows
  async cleanupOldWorkflows(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await WorkflowRunModel.deleteMany({
      status: { $in: ['done', 'failed', 'cancelled'] },
      updatedAt: { $lt: cutoff }
    }).exec();

    console.log(`Cleaned up ${result.deletedCount} workflows`);
    return result.deletedCount;
  }

  // Archive old workflows (move to archive collection)
  async archiveOldWorkflows(days = 90) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const oldRuns = await WorkflowRunModel.find({
      status: { $in: ['done', 'failed'] },
      updatedAt: { $lt: cutoff }
    }).lean().exec();

    // Move to archive
    if (oldRuns.length > 0) {
      await ArchiveModel.insertMany(oldRuns);
      await WorkflowRunModel.deleteMany({
        _id: { $in: oldRuns.map(r => r._id) }
      });
    }

    return oldRuns.length;
  }

  // Cleanup by tenant
  async cleanupTenantWorkflows(tenantId: string) {
    const result = await WorkflowRunModel.deleteMany({
      'context.tenantId': tenantId,
      status: { $in: ['done', 'failed', 'cancelled'] }
    }).exec();

    return result.deletedCount;
  }
}

// Schedule cleanup (cron job)
import cron from 'node-cron';

cron.schedule('0 2 * * *', async () => {  // 2 AM daily
  await cleanupService.cleanupOldWorkflows(30);
});
```

### Option 3: Workflow-Specific Expiry

```typescript
// Store expiry in context
const run = await engine.start({
  url: 'https://example.com',
  expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)  // 7 days
});

// Index on expireAt
await WorkflowRunModel.collection.createIndex({ 'context.expireAt': 1 });

// Cleanup expired
async function cleanupExpired() {
  const result = await WorkflowRunModel.deleteMany({
    'context.expireAt': { $lt: new Date() },
    status: { $in: ['done', 'failed', 'cancelled'] }
  }).exec();

  return result.deletedCount;
}
```

## Helper: Index Setup Function

```typescript
// db-setup.ts
import { WorkflowRunModel } from '@classytic/streamline';

export async function setupWorkflowIndexes(config: {
  tenantField?: string;
  userField?: string;
  autoCleanupDays?: number;
  contextFields?: string[];
}) {
  const indexes = [];

  // Basic indexes
  indexes.push(
    { workflowId: 1, status: 1 },
    { status: 1, updatedAt: -1 },
    { currentStepId: 1 }
  );

  // Tenant index
  if (config.tenantField) {
    indexes.push({ [`context.${config.tenantField}`]: 1, status: 1 });
  }

  // User index
  if (config.userField) {
    indexes.push({ [`context.${config.userField}`]: 1, createdAt: -1 });
  }

  // Custom context fields
  config.contextFields?.forEach(field => {
    indexes.push({ [`context.${field}`]: 1 });
  });

  // Create indexes
  for (const index of indexes) {
    await WorkflowRunModel.collection.createIndex(index);
  }

  // TTL index for auto-cleanup
  if (config.autoCleanupDays) {
    await WorkflowRunModel.collection.createIndex(
      { updatedAt: 1 },
      {
        expireAfterSeconds: config.autoCleanupDays * 24 * 60 * 60,
        partialFilterExpression: {
          status: { $in: ['done', 'failed', 'cancelled'] }
        }
      }
    );
  }

  console.log('Workflow indexes created');
}

// Usage
await setupWorkflowIndexes({
  tenantField: 'tenantId',
  userField: 'userId',
  autoCleanupDays: 30,
  contextFields: ['url', 'orderId', 'email']
});
```

## Webhooks & External Resume

Use `resumeHook` to resume workflows from API endpoints:

```typescript
import { createHook, resumeHook } from '@classytic/streamline';

// In workflow step - create a hook and wait
const approval = createWorkflow('approval', {
  steps: {
    request: async (ctx) => {
      const hook = createHook(ctx, 'awaiting-approval');
      console.log('Resume URL:', hook.path); // /hooks/runId:stepId:timestamp
      return ctx.wait('Waiting for approval');
    },
    process: async (ctx) => {
      const { approved } = ctx.getOutput('request');
      return { approved };
    }
  },
  context: () => ({})
});

// In API route - resume the workflow
app.post('/hooks/:token', async (req, res) => {
  const { runId, run } = await resumeHook(req.params.token, req.body);
  res.json({ success: true, runId, status: run.status });
});
```

## Monitoring & Observability

```typescript
import { globalEventBus } from '@classytic/streamline';

// Hook into events
globalEventBus.on('workflow:started', ({ runId }) => {
  metrics.increment('workflow.started');
  logger.info('Workflow started', { runId });
});

globalEventBus.on('workflow:completed', ({ runId }) => {
  metrics.increment('workflow.completed');
});

globalEventBus.on('workflow:failed', ({ runId, data }) => {
  metrics.increment('workflow.failed');
  alerting.notify('Workflow failed', { runId, error: data.error });
});

// Engine errors (execution failures, scheduler issues)
globalEventBus.on('engine:error', ({ runId, error, context }) => {
  logger.error('Engine error', { runId, error, context });
});

globalEventBus.on('scheduler:error', ({ error, context }) => {
  logger.error('Scheduler error', { error, context });
});

globalEventBus.on('step:started', ({ runId, stepId }) => {
  metrics.timing('step.duration.start', { runId, stepId });
});
```

## API Reference

### Workflow (from createWorkflow)

- `start(input, meta?)` - Start new workflow
- `execute(runId)` - Execute steps
- `resume(runId, payload?)` - Resume from wait
- `get(runId)` - Get workflow state
- `cancel(runId)` - Cancel workflow
- `pause(runId)` - Pause workflow (scheduler skips)
- `rewindTo(runId, stepId)` - Rewind to step
- `waitFor(runId, options?)` - Wait for completion
- `shutdown()` - Graceful shutdown

### StepContext (in handlers)

- `ctx.set(key, value)` - Update context
- `ctx.getOutput(stepId)` - Get previous step output
- `ctx.wait(reason, data?)` - Wait for human input
- `ctx.waitFor(eventName)` - Wait for event
- `ctx.sleep(ms)` - Sleep for duration
- `ctx.heartbeat()` - Send heartbeat (long-running steps)
- `ctx.emit(event, data)` - Emit custom event
- `ctx.log(message, data?)` - Log message
- `ctx.signal` - AbortSignal for cancellation

### Error Handling

All errors include standardized codes for programmatic handling:

```typescript
import { ErrorCode, WorkflowNotFoundError } from '@classytic/streamline';

try {
  await workflow.resume(runId, payload);
} catch (err) {
  switch (err.code) {
    case ErrorCode.WORKFLOW_NOT_FOUND:
      return res.status(404).json({ error: 'Workflow not found' });
    case ErrorCode.INVALID_STATE:
      return res.status(400).json({ error: 'Cannot resume - workflow not waiting' });
    case ErrorCode.STEP_TIMEOUT:
      return res.status(408).json({ error: 'Step timed out' });
    default:
      throw err;
  }
}
```

**Available error codes:**

| Code | Description |
|------|-------------|
| `WORKFLOW_NOT_FOUND` | Workflow run doesn't exist |
| `WORKFLOW_CANCELLED` | Workflow was cancelled |
| `STEP_NOT_FOUND` | Step ID not in workflow definition |
| `STEP_TIMEOUT` | Step exceeded timeout |
| `INVALID_STATE` | Invalid state transition |
| `DATA_CORRUPTION` | Internal data inconsistency |
| `MAX_RETRIES_EXCEEDED` | Step failed after all retries |

### WorkflowRunModel (Mongoose)

Direct Mongoose model for queries:

```typescript
import { WorkflowRunModel } from '@classytic/streamline';

await WorkflowRunModel.find({ status: 'running' }).exec();
await WorkflowRunModel.updateOne({ _id: runId }, { status: 'cancelled' });
await WorkflowRunModel.deleteMany({ status: 'done' });
```

## Examples

See [docs/examples/](./docs/examples) for complete examples:

- [Hello World](./docs/examples/hello-world.ts)
- [Wait & Resume](./docs/examples/wait-workflow.ts)
- [Sleep Timer](./docs/examples/sleep-workflow.ts)
- [Parallel Execution](./docs/examples/parallel-workflow.ts)
- [Conditional Steps](./docs/examples/conditional-workflow.ts)
- [Newsletter Automation](./docs/examples/newsletter-automation.ts)
- [AI Pipeline](./docs/examples/ai-pipeline.ts)

## Testing

```bash
npm test                 # Run all tests
npm test -- --coverage   # With coverage
npm run test:watch       # Watch mode
```

See [TESTING.md](./TESTING.md) for testing guide.

## Architecture Details

- **Core**: ~7,000 lines of TypeScript (34 modules)
- **Storage**: MongoDB via MongoKit Repository
- **Cache**: LRU cache for active workflows (10K max, O(1) operations)
- **Events**: Typed EventEmitter-based pub/sub
- **Scheduler**: Adaptive polling (10s-5min based on load)
- **Concurrency**: Atomic claiming prevents duplicate execution
- **Memory**: Auto garbage collection via WeakRef

## Advanced: Scheduler Concurrency Limit

Prevent overwhelming API rate limits or memory when each step runs a long-running agent:

```typescript
const workflow = createWorkflow('agent-pipeline', {
  steps: { ... },
});

// Limit to 10 workflows executing simultaneously
workflow.engine.configure({
  scheduler: { maxConcurrentExecutions: 10 },
});
```

When all slots are full, the scheduler skips the poll cycle — workflows wait in `running` queue until a slot frees up. Default is `Infinity` (no limit).

## Advanced: Type Exports

All public types are exported — no `ReturnType<>` workarounds needed:

```typescript
import {
  createWorkflow,
  type Workflow,        // The workflow instance type
  type WorkflowConfig,  // The config object type
  type StepConfig,       // Per-step config type
  type WaitForOptions,   // waitFor() options
  type WorkflowRun,      // The run document type
} from '@classytic/streamline';

// Export your workflows without TS4023
export const myWorkflow: Workflow<MyCtx, MyInput> = createWorkflow('my', { ... });

// Type config objects separately
const config: WorkflowConfig<MyCtx> = { steps: { ... } };
```

## Advanced: Dependency Injection

For testing or running multiple isolated engines, use the container directly:

```typescript
import { WorkflowEngine, createContainer } from '@classytic/streamline';

// Each container has isolated eventBus and cache
const container1 = createContainer();
const container2 = createContainer();

// Create isolated engines
const engine1 = new WorkflowEngine(definition, handlers, container1);
const engine2 = new WorkflowEngine(definition, handlers, container2);

// Events on engine1 don't affect engine2
container1.eventBus.on('workflow:completed', () => { /* only engine1 */ });
```

> Note: `createWorkflow()` automatically creates a container, so you don't need this for normal use.

## License

MIT

## Contributing

Issues and PRs welcome at [github.com/classytic/streamline](https://github.com/classytic/streamline)
