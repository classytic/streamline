/**
 * Test Setup Utilities
 *
 * Provides in-memory MongoDB instance for testing
 * Ensures isolated, reproducible test environment
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { configureLogger } from '@classytic/mongokit';

let mongoServer: MongoMemoryServer | null = null;

/**
 * Start in-memory MongoDB server
 * Call once before all tests
 */
export async function setupTestDB(): Promise<void> {
  // Idempotent — safe to call from multiple test files' beforeAll hooks.
  // With vitest singleFork the same worker hosts many files; we reuse one server.
  if (mongoServer && mongoose.connection.readyState === 1) {
    return;
  }

  mongoServer = await MongoMemoryServer.create({
    binary: {
      version: '7.0.0', // Use MongoDB 7.0
    },
  });

  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Suppress MongoKit keyset pagination index hint warnings in tests.
  // These are heuristic dev hints, not errors — indexes are defined on the schema.
  configureLogger(false);

  // Create indexes for better performance in tests.
  // Includes the keyset pagination compound indexes that MongoKit expects.
  await mongoose.connection.db?.collection('workflow_runs').createIndexes([
    { key: { workflowId: 1, status: 1 } },
    { key: { status: 1, updatedAt: -1 } },
    { key: { status: 1, 'steps.status': 1, 'steps.waitingFor.resumeAt': 1 } },
    { key: { status: 1, paused: 1, updatedAt: -1, _id: -1 } },
    { key: { status: 1, paused: 1, updatedAt: 1, _id: 1 } },
    { key: { status: 1, lastHeartbeat: 1 } },
    { key: { status: 1, 'scheduling.executionTime': 1, paused: 1 } },
    // Distributed primitives
    { key: { idempotencyKey: 1, status: 1 }, sparse: true },
    { key: { workflowId: 1, concurrencyKey: 1, status: 1 } },
    { key: { status: 1, priority: -1, updatedAt: 1 } },
  ] as any);
}

/**
 * Clean all data between tests
 * Call after each test for isolation
 */
export async function cleanupTestDB(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}

/**
 * Stop MongoDB server and close connection
 * Call once after all tests
 */
export async function teardownTestDB(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
  }

  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
}

/**
 * Wait for async operations to complete
 * Useful for scheduler timing
 */
export async function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until condition is true or timeout
 * Returns true if condition met, false if timeout
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return true;
    }
    await waitFor(interval);
  }

  return false;
}

/**
 * Assert workflow reaches expected status within timeout
 */
export async function assertWorkflowStatus(
  getWorkflow: () => Promise<any>,
  expectedStatus: string,
  timeout: number = 5000
): Promise<boolean> {
  return waitUntil(async () => {
    const workflow = await getWorkflow();
    return workflow?.status === expectedStatus;
  }, timeout);
}
