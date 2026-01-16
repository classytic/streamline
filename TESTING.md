# Streamline Testing Guide

Comprehensive testing guide for @classytic/streamline workflow engine.

## Test Setup

### Vitest v3 Configuration

The project uses **Vitest v3** for testing with the following setup:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

### Dependencies

```json
{
  "devDependencies": {
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "mongoose": "^8.0.0"
  }
}
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run with coverage
```bash
npm test -- --coverage
```

### Run specific test file
```bash
npm test -- hello-world.test.ts
```

### Run tests matching pattern
```bash
npm test -- --grep "parallel"
```

## Test Structure

### Test Files

Located in `test/` directory:

1. **hello-world.test.ts** - Basic workflow execution
2. **sleep-workflow.test.ts** - Timer functionality
3. **wait-workflow.test.ts** - Human-in-the-loop approval
4. **parallel.test.ts** - Parallel step execution (all, race, any modes)
5. **conditional.test.ts** - Conditional step execution with built-in conditions
6. **engine.test.ts** - Comprehensive engine tests (start, execute, resume, rewind, etc.)
7. **newsletter.test.ts** - Real-world newsletter automation workflow
8. **ai-pipeline.test.ts** - AI content pipeline with quality checks
9. **memory-concurrency.test.ts** - Memory management and concurrency control

### Test Coverage

#### Core Engine (engine.test.ts)
- ✅ Start and execute simple workflow
- ✅ Handle workflow with retry
- ✅ Handle workflow failure after max retries
- ✅ Handle wait and resume
- ✅ Handle pause and resume
- ✅ Handle cancel
- ✅ Handle rewindTo
- ✅ Retrieve workflow from cache
- ✅ Handle step timeout
- ✅ Handle getOutput from previous steps

#### Parallel Execution (parallel.test.ts)
- ✅ Execute steps in parallel (all mode)
- ✅ Execute with race mode (fastest wins)
- ✅ Validate isParallelStep type guard
- ✅ Handle parallel execution errors gracefully

#### Conditional Steps (conditional.test.ts)
- ✅ Skip steps based on condition
- ✅ Validate isConditionalStep type guard
- ✅ Test built-in condition helpers (hasValue, equals, greaterThan, lessThan, and, or, not)
- ✅ Test skipIf and runIf conditions
- ✅ Create custom conditions

#### Memory & Concurrency (memory-concurrency.test.ts)
- ✅ Track memory usage
- ✅ Detect memory threshold exceeded
- ✅ Trigger garbage collection
- ✅ Start and stop automatic GC
- ✅ Limit concurrent workflow execution
- ✅ Limit concurrent step execution
- ✅ Queue tasks when limit reached
- ✅ Get concurrency stats
- ✅ Integrate with workflow engine

#### Examples Tests
- ✅ Newsletter automation workflow
- ✅ AI pipeline workflow
- ✅ Sleep workflow
- ✅ Wait/resume workflow
- ✅ Hello world workflow

## Local Build Testing

### Example Project Setup

The `streamline-example` directory demonstrates importing from local build:

```json
{
  "dependencies": {
    "@classytic/streamline": "file:../streamline"
  }
}
```

### Running Example Project

```bash
cd ../streamline-example
npm install
npm start    # Run example application
npm test     # Run integration tests
```

### Integration Tests (streamline-example/src/example.test.ts)

- ✅ Import and execute workflow from local build
- ✅ Verify all exports are available
- ✅ Handle wait and resume from local build

## MongoDB Setup for Tests

Tests require a running MongoDB instance:

```bash
# Using Docker
docker run -d -p 27017:27017 --name mongodb mongo:8

# Or install MongoDB locally
# https://www.mongodb.com/docs/manual/installation/
```

Update connection string in tests if needed:
```typescript
await mongoose.connect('mongodb://localhost:27017/streamline-test');
```

## Writing Tests

### Basic Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createWorkflow } from '@classytic/streamline';

interface TestContext {
  value: number;
  result?: number;
}

describe('My Workflow Test', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/test');
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  it('should execute workflow', async () => {
    const workflow = createWorkflow<TestContext, { value: number }>('test-workflow', {
      steps: {
        compute: async (ctx) => {
          const result = ctx.context.value * 2;
          await ctx.set('result', result);
          return { result };
        },
      },
      context: (input) => ({ value: input.value }),
      version: '1.0.0',
    });

    const run = await workflow.start({ value: 10 });

    // Wait for execution to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = await workflow.get(run._id);

    expect(result?.status).toBe('done');
    expect(result?.context.result).toBe(20);
  });
});
```

### Testing Wait/Resume

```typescript
it('should wait and resume', async () => {
  const workflow = defineWorkflow<TestContext>()
    .step({ id: 'wait', name: 'Wait' })
    .build();

  const handlers = {
    wait: async (ctx) => {
      await ctx.wait('Waiting for input', { value: ctx.context.value });
    },
  };

  const engine = new WorkflowEngine(workflow, handlers);
  const run = await engine.start({ value: 5 });

  // Execute until waiting
  const waitingRun = await engine.execute(run._id);
  expect(waitingRun.status).toBe('waiting');

  // Resume with payload
  const resumedRun = await engine.resume(run._id, { approved: true });
  expect(resumedRun.status).toBe('completed');
});
```

### Testing Parallel Execution

```typescript
it('should execute in parallel', async () => {
  const workflow = defineWorkflow()
    .step({
      id: 'parallel',
      name: 'Parallel',
      parallel: ['step1', 'step2', 'step3'],
      mode: 'all',
    })
    .build();

  const handlers = {
    parallel: async (ctx) => {
      const results = await Promise.all([
        fetch('api1'),
        fetch('api2'),
        fetch('api3'),
      ]);
      return { results };
    },
  };

  const engine = new WorkflowEngine(workflow, handlers);
  const run = await engine.start({});
  const result = await engine.execute(run._id);

  expect(result.status).toBe('completed');
});
```

### Testing Conditional Steps

```typescript
import { conditions } from '@classytic/streamline';

it('should skip steps conditionally', async () => {
  const workflow = defineWorkflow()
    .step({
      id: 'premium',
      name: 'Premium Feature',
      condition: conditions.equals('tier', 'premium'),
    })
    .build();

  const handlers = {
    premium: async (ctx) => {
      return { activated: true };
    },
  };

  const engine = new WorkflowEngine(workflow, handlers);

  // Test with standard tier
  const run1 = await engine.start({ tier: 'standard' });
  const result1 = await engine.execute(run1._id);
  expect(result1.steps[0].status).toBe('skipped');

  // Test with premium tier
  const run2 = await engine.start({ tier: 'premium' });
  const result2 = await engine.execute(run2._id);
  expect(result2.steps[0].status).toBe('done');
});
```

### Testing Error Handling

```typescript
it('should handle errors with retry', async () => {
  let attempts = 0;

  const workflow = defineWorkflow()
    .step({ id: 'flaky', name: 'Flaky Step', retries: 2 })
    .build();

  const handlers = {
    flaky: async (ctx) => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Temporary error');
      }
      return { success: true, attempts };
    },
  };

  const engine = new WorkflowEngine(workflow, handlers);
  const run = await engine.start({});
  const result = await engine.execute(run._id);

  expect(result.status).toBe('completed');
  expect(attempts).toBe(2);
});
```

## Test Best Practices

### 1. Clean Up After Tests

```typescript
afterEach(async () => {
  // Clean up test data
  const runs = await workflowRunRepository.getAll({ limit: 100 });
  for (const run of runs.docs) {
    await workflowRunRepository.delete(run._id);
  }
});
```

### 2. Use Unique Workflow IDs

```typescript
const workflow = defineWorkflow()
  .id(`test-${Date.now()}`)  // Unique ID per test
  .build();
```

### 3. Test Timeout Configuration

```typescript
it('should timeout properly', async () => {
  const workflow = defineWorkflow()
    .step({ id: 'slow', name: 'Slow', timeout: 100 })
    .build();

  const handlers = {
    slow: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };

  const engine = new WorkflowEngine(workflow, handlers);
  const run = await engine.start({});
  const result = await engine.execute(run._id);

  expect(result.status).toBe('failed');
  expect(result.steps[0].error?.message).toContain('timed out');
});
```

### 4. Mock External Dependencies

```typescript
import { vi } from 'vitest';

it('should call external API', async () => {
  const mockFetch = vi.fn().mockResolvedValue({ data: 'test' });

  const handlers = {
    fetch: async (ctx) => {
      const data = await mockFetch();
      return data;
    },
  };

  // ... test execution

  expect(mockFetch).toHaveBeenCalledTimes(1);
});
```

## Coverage Goals

Target coverage metrics:

- **Statements**: > 90%
- **Branches**: > 85%
- **Functions**: > 90%
- **Lines**: > 90%

Check coverage:
```bash
npm test -- --coverage
```

Coverage report will be generated in `coverage/` directory.

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      mongodb:
        image: mongo:8
        ports:
          - 27017:27017

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test -- --coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v4
```

## Troubleshooting

### MongoDB Connection Issues

```typescript
// Increase timeout
beforeAll(async () => {
  await mongoose.connect('mongodb://localhost:27017/test', {
    serverSelectionTimeoutMS: 5000,
  });
}, 10000);
```

### Test Timeout Issues

```typescript
// Increase test timeout in vitest.config.ts
export default defineConfig({
  test: {
    testTimeout: 60000,  // 60 seconds
  },
});
```

### Memory Leaks

```typescript
// Ensure proper cleanup
afterAll(async () => {
  await mongoose.connection.close();
  await new Promise(resolve => setTimeout(resolve, 100));
});
```

## Performance Testing

### Load Testing Example

```typescript
it('should handle 100 concurrent workflows', async () => {
  const workflow = defineWorkflow()
    .step({ id: 'process', name: 'Process' })
    .build();

  const handlers = {
    process: async (ctx) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { processed: true };
    },
  };

  const engine = new WorkflowEngine(workflow, handlers);

  const startTime = Date.now();

  const runs = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const run = await engine.start({ id: i });
      return await engine.execute(run._id);
    })
  );

  const duration = Date.now() - startTime;

  expect(runs).toHaveLength(100);
  runs.forEach(run => {
    expect(run.status).toBe('completed');
  });

  console.log(`Executed 100 workflows in ${duration}ms`);
  expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
});
```

## Summary

The streamline workflow engine includes comprehensive test coverage across:

- ✅ Core workflow execution
- ✅ Step retry and error handling
- ✅ Wait/resume functionality
- ✅ Parallel execution
- ✅ Conditional steps
- ✅ Memory management
- ✅ Concurrency control
- ✅ Real-world use cases (newsletter, AI pipeline)
- ✅ Local build integration

All tests use **Vitest v3** and are designed to be:
- Fast (< 30 seconds total)
- Reliable (no flaky tests)
- Maintainable (clear structure)
- Comprehensive (> 90% coverage)

Run `npm test` to execute all tests and verify the implementation!
