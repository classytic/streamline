# Multi-Worker Deployment Guide

## Overview

Streamline is designed for **horizontal scaling** with multiple workers. All coordination happens through MongoDB atomic operations - no external message broker or distributed lock service required.

This guide covers how to deploy Streamline in production with multiple workers safely.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MongoDB                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  WorkflowRuns Collection                                 │   │
│  │  - Atomic claiming via findOneAndUpdate                 │   │
│  │  - Heartbeat timestamps for stale detection             │   │
│  │  - Status guards for cancellation safety                │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
          ┌───────────────────┼───────────────────┐
          │                   │                   │
     ┌────┴────┐        ┌────┴────┐        ┌────┴────┐
     │ Worker 1│        │ Worker 2│        │ Worker 3│
     │ (Pod A) │        │ (Pod B) │        │ (Pod C) │
     └─────────┘        └─────────┘        └─────────┘
```

---

## How Multi-Worker Safety Works

### 1. Atomic Claiming

When a worker starts executing a workflow, it atomically claims it:

```typescript
// Internal: SmartScheduler.claimWorkflow()
const claimed = await WorkflowRun.findOneAndUpdate(
  {
    _id: runId,
    status: { $in: ['draft', 'waiting'] },
    $or: [
      { executingWorkerId: null },
      { heartbeatAt: { $lt: staleThreshold } }
    ]
  },
  {
    $set: {
      status: 'running',
      executingWorkerId: this.workerId,
      heartbeatAt: new Date()
    }
  },
  { new: true }
);
```

Only one worker can claim a workflow - MongoDB guarantees this atomically.

### 2. Heartbeat & Stale Detection

Workers update heartbeat timestamps during execution:

```typescript
// Internal: StepExecutor updates heartbeat during execution
await WorkflowRun.updateOne(
  { _id: runId, status: { $ne: 'cancelled' } },
  { $set: { heartbeatAt: new Date() } }
);
```

If a worker crashes, its workflows become **stale** and can be reclaimed:

```typescript
// Default stale threshold: 5 minutes
const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
```

### 3. Cancellation Guards

All database updates include a cancellation guard:

```typescript
const CANCELLED_GUARD = { status: { $ne: 'cancelled' } };

// Every update respects cancellation
const result = await WorkflowRun.updateOne(
  { _id: runId, ...CANCELLED_GUARD },
  { $set: { 'steps.0.status': 'done' } }
);

if (result.modifiedCount === 0) {
  // Workflow was cancelled - stop execution
}
```

---

## Deployment Patterns

### Pattern 1: Kubernetes Deployment

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: streamline-workers
spec:
  replicas: 3  # Multiple workers
  selector:
    matchLabels:
      app: streamline-worker
  template:
    metadata:
      labels:
        app: streamline-worker
    spec:
      containers:
      - name: worker
        image: your-app:latest
        env:
        - name: MONGODB_URI
          valueFrom:
            secretKeyRef:
              name: mongodb-secrets
              key: uri
        - name: WORKER_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name  # Unique per pod
        resources:
          requests:
            memory: "256Mi"
            cpu: "200m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
```

### Pattern 2: Docker Compose (Development/Staging)

```yaml
# docker-compose.yml
version: '3.8'
services:
  worker-1:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/streamline
      - WORKER_ID=worker-1
    depends_on:
      - mongo

  worker-2:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/streamline
      - WORKER_ID=worker-2
    depends_on:
      - mongo

  worker-3:
    build: .
    environment:
      - MONGODB_URI=mongodb://mongo:27017/streamline
      - WORKER_ID=worker-3
    depends_on:
      - mongo

  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

### Pattern 3: PM2 Cluster Mode

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'streamline-worker',
    script: './dist/server.js',
    instances: 'max', // Use all CPU cores
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      MONGODB_URI: process.env.MONGODB_URI,
    },
    // Each instance gets unique WORKER_ID
    instance_var: 'INSTANCE_ID',
  }]
};
```

---

## Application Setup

### Worker Initialization

```typescript
// server.ts
import { createWorkflow } from '@classytic/streamline';
import { SmartScheduler } from '@classytic/streamline/execution';

// Unique worker ID (from environment or generated)
const workerId = process.env.WORKER_ID || `worker-${process.pid}`;

// Create workflow
const workflow = createWorkflow('my-workflow', {
  steps: {
    step1: async (ctx) => { /* ... */ },
    step2: async (ctx) => { /* ... */ },
  },
  context: (input) => input,
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    workerId,
    uptime: process.uptime(),
  });
});

// Ready check - ensure MongoDB connected
app.get('/ready', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');

  // Stop accepting new work
  workflow.shutdown();

  // Wait for in-flight work to complete (max 30s)
  await new Promise(resolve => setTimeout(resolve, 30000));

  // Close MongoDB connection
  await mongoose.disconnect();

  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

---

## Critical Requirements

### 1. Idempotent Handlers

**This is the most important requirement.** All step handlers must be idempotent.

See: [Idempotent Handler Best Practices](./IDEMPOTENT_HANDLERS.md)

### 2. Proper Database Indexes

```typescript
// Create indexes on startup
async function ensureIndexes() {
  const collection = mongoose.connection.collection('workflow_runs');

  // Index for scheduled workflow polling
  await collection.createIndex({
    status: 1,
    'scheduling.executionTime': 1,
    paused: 1,
  });

  // Index for stale workflow detection
  await collection.createIndex({
    status: 1,
    executingWorkerId: 1,
    heartbeatAt: 1,
  });

  // Index for retry scheduling
  await collection.createIndex({
    status: 1,
    'steps.status': 1,
    'steps.nextRetryAt': 1,
  });
}
```

### 3. Graceful Shutdown

Workers must handle shutdown signals to avoid leaving workflows in inconsistent states:

```typescript
// Allow in-flight handlers to complete
workflow.shutdown(); // Stops scheduler, waits for current execution

// Or force abort after timeout
setTimeout(() => process.exit(1), 30000);
```

### 4. Health Monitoring

Monitor scheduler health across workers:

```typescript
import { SmartScheduler } from '@classytic/streamline/execution';

// Expose metrics
app.get('/metrics', (req, res) => {
  const stats = scheduler.getStats();
  res.json({
    workerId,
    scheduler: {
      isHealthy: scheduler.isHealthy(),
      pollInterval: scheduler.getCurrentInterval(),
      totalPolls: stats.totalPolls,
      successfulPolls: stats.successfulPolls,
      failedPolls: stats.failedPolls,
      avgPollDuration: stats.avgPollDuration,
      totalWorkflowsProcessed: stats.totalWorkflowsProcessed,
    },
  });
});
```

---

## Configuration Tuning

### SmartScheduler Options

```typescript
const scheduler = new SmartScheduler(repository, executeCallback, {
  // Base interval between polls (adaptive)
  basePollInterval: 60000, // 1 minute

  // Maximum workflows to claim per poll
  maxWorkflowsPerPoll: 100,

  // Enable adaptive polling (adjusts based on load)
  adaptivePolling: true,

  // Stale workflow threshold
  staleThresholdMs: 5 * 60 * 1000, // 5 minutes
});
```

### Tuning for Scale

| Scenario | Recommended Settings |
|----------|---------------------|
| Low volume (<100/hour) | `basePollInterval: 120000`, `maxWorkflowsPerPoll: 50` |
| Medium volume (100-1000/hour) | `basePollInterval: 60000`, `maxWorkflowsPerPoll: 100` |
| High volume (1000+/hour) | `basePollInterval: 30000`, `maxWorkflowsPerPoll: 500` |
| Burst traffic | Enable `adaptivePolling: true` |

---

## Troubleshooting

### Duplicate Execution

**Symptom:** Same step executes on multiple workers.

**Cause:** Handlers not idempotent, or stale threshold too low.

**Fix:**
1. Make handlers idempotent (see [guide](./IDEMPOTENT_HANDLERS.md))
2. Increase stale threshold: `staleThresholdMs: 10 * 60 * 1000`

### Workflows Stuck in Running

**Symptom:** Workflows stay in `running` status indefinitely.

**Cause:** Worker crashed without releasing claim.

**Fix:**
1. Check heartbeat timestamps - stale workflows will be reclaimed automatically
2. Ensure graceful shutdown handlers are working
3. Manually reset if needed:
```typescript
await WorkflowRun.updateMany(
  {
    status: 'running',
    heartbeatAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) }
  },
  {
    $set: { status: 'waiting', executingWorkerId: null }
  }
);
```

### High MongoDB Load

**Symptom:** MongoDB CPU/connections spike during polling.

**Cause:** Too many workers or too frequent polling.

**Fix:**
1. Reduce `maxWorkflowsPerPoll`
2. Increase `basePollInterval`
3. Ensure proper indexes exist
4. Use MongoDB connection pooling

### Cancellation Not Working

**Symptom:** Cancelled workflows continue executing.

**Cause:** In-flight handler ignoring abort signal.

**Fix:** Use `ctx.signal` in handlers:
```typescript
const handler = async (ctx) => {
  // Check signal periodically
  if (ctx.signal?.aborted) throw ctx.signal.reason;

  // Or pass to fetch
  await fetch(url, { signal: ctx.signal });
};
```

---

## Monitoring Checklist

- [ ] **Scheduler health** - All workers reporting healthy
- [ ] **Poll success rate** - Should be >99%
- [ ] **Average poll duration** - Should be <1s
- [ ] **Stale workflow count** - Should be near 0
- [ ] **MongoDB connections** - Within pool limits
- [ ] **Worker memory** - No memory leaks
- [ ] **Duplicate execution rate** - Should be 0 (idempotent handlers)

---

## See Also

- [Idempotent Handlers](./IDEMPOTENT_HANDLERS.md) - Critical for multi-worker safety
- [Cancellation & Rewind](./CANCELLATION_REWIND.md) - State management in distributed environments
- [Multi-Tenant Scheduling](./MULTI_TENANT_SCHEDULING.md) - Tenant isolation with multiple workers
