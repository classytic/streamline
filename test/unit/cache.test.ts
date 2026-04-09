/**
 * Unit tests for src/storage/cache.ts
 * LRU cache behavior — no DB required.
 */

import { describe, it, expect } from 'vitest';
import { WorkflowCache } from '../../src/storage/cache.js';
import type { WorkflowRun } from '../../src/core/types.js';

function makeRun(id: string, status: 'running' | 'waiting' | 'done' | 'failed' = 'running'): WorkflowRun {
  return {
    _id: id,
    workflowId: 'test',
    status,
    steps: [],
    currentStepId: null,
    context: {},
    input: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as WorkflowRun;
}

describe('WorkflowCache', () => {
  it('should store and retrieve active runs', () => {
    const cache = new WorkflowCache(100);
    const run = makeRun('r1', 'running');
    cache.set(run);
    expect(cache.get('r1')).toEqual(run);
  });

  it('should return null for unknown IDs', () => {
    const cache = new WorkflowCache(100);
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('should NOT cache terminal state runs (done/failed)', () => {
    const cache = new WorkflowCache(100);
    cache.set(makeRun('r1', 'done'));
    expect(cache.get('r1')).toBeNull();

    cache.set(makeRun('r2', 'failed'));
    expect(cache.get('r2')).toBeNull();
  });

  it('should evict existing entry when run reaches terminal state', () => {
    const cache = new WorkflowCache(100);
    cache.set(makeRun('r1', 'running'));
    expect(cache.get('r1')).not.toBeNull();

    // Transition to done → should be evicted
    cache.set(makeRun('r1', 'done'));
    expect(cache.get('r1')).toBeNull();
  });

  it('should evict oldest entry when at capacity', () => {
    const cache = new WorkflowCache(3);
    cache.set(makeRun('r1'));
    cache.set(makeRun('r2'));
    cache.set(makeRun('r3'));
    // r1 is oldest — adding r4 should evict it
    cache.set(makeRun('r4'));

    expect(cache.get('r1')).toBeNull();
    expect(cache.get('r2')).not.toBeNull();
    expect(cache.get('r4')).not.toBeNull();
    expect(cache.size()).toBe(3);
  });

  it('should promote to MRU on get()', () => {
    const cache = new WorkflowCache(3);
    cache.set(makeRun('r1'));
    cache.set(makeRun('r2'));
    cache.set(makeRun('r3'));

    // Access r1 → moves to MRU
    cache.get('r1');

    // Add r4 → should evict r2 (oldest after r1 was promoted)
    cache.set(makeRun('r4'));
    expect(cache.get('r1')).not.toBeNull();
    expect(cache.get('r2')).toBeNull();
  });

  it('should clear all entries', () => {
    const cache = new WorkflowCache(100);
    cache.set(makeRun('r1'));
    cache.set(makeRun('r2'));
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('should delete by ID', () => {
    const cache = new WorkflowCache(100);
    cache.set(makeRun('r1'));
    cache.delete('r1');
    expect(cache.get('r1')).toBeNull();
  });

  it('should report stats correctly', () => {
    const cache = new WorkflowCache(100);
    cache.set(makeRun('r1'));
    cache.set(makeRun('r2'));
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.maxSize).toBe(100);
    expect(stats.utilizationPercent).toBe(2);
  });

  it('should report health status based on global thresholds', () => {
    // Default maxSize=10000; COMPUTED thresholds: warning at 80%, critical at 95%
    // Small caches always report healthy since size < 8000
    const cache = new WorkflowCache(10);
    expect(cache.getHealth().status).toBe('healthy');

    // Verify the structure of health response
    const health = cache.getHealth();
    expect(health.message).toBeDefined();
    expect(typeof health.utilizationPercent).toBe('number');
  });

  it('should detect near capacity', () => {
    const cache = new WorkflowCache(10);
    expect(cache.isNearCapacity()).toBe(false);
    for (let i = 0; i < 9; i++) {
      cache.set(makeRun(`r${i}`));
    }
    expect(cache.isNearCapacity()).toBe(true);
  });

  it('should return active runs', () => {
    const cache = new WorkflowCache(100);
    cache.set(makeRun('r1', 'running'));
    cache.set(makeRun('r2', 'waiting'));
    const active = cache.getActive();
    expect(active).toHaveLength(2);
  });
});
