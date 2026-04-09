/**
 * Unit tests for src/utils/helpers.ts
 * Pure functions — no DB required.
 */

import { describe, it, expect } from 'vitest';
import { calculateRetryDelay, resolveBackoffMultiplier } from '../../src/utils/helpers.js';

describe('calculateRetryDelay', () => {
  it('should return base delay on attempt 0', () => {
    const delay = calculateRetryDelay(1000, 0, 2, 60000, 0); // 0 jitter
    expect(delay).toBe(1000);
  });

  it('should double delay on each attempt with multiplier=2', () => {
    const d0 = calculateRetryDelay(1000, 0, 2, 60000, 0);
    const d1 = calculateRetryDelay(1000, 1, 2, 60000, 0);
    const d2 = calculateRetryDelay(1000, 2, 2, 60000, 0);
    expect(d0).toBe(1000);
    expect(d1).toBe(2000);
    expect(d2).toBe(4000);
  });

  it('should cap at maxDelay', () => {
    const delay = calculateRetryDelay(1000, 10, 2, 5000, 0);
    expect(delay).toBe(5000);
  });

  it('should apply jitter within ±factor range', () => {
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(calculateRetryDelay(1000, 0, 2, 60000, 0.3));
    }
    // With 30% jitter on 1000ms, range is 700-1300
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(700);
      expect(r).toBeLessThanOrEqual(1300);
    }
    // Should have some variance (not all identical)
    expect(results.size).toBeGreaterThan(1);
  });

  it('should return 0 for negative results (edge case)', () => {
    expect(calculateRetryDelay(0, 0, 0, 0, 0)).toBe(0);
  });

  it('should handle multiplier=1 (linear backoff)', () => {
    const d0 = calculateRetryDelay(500, 0, 1, 60000, 0);
    const d1 = calculateRetryDelay(500, 1, 1, 60000, 0);
    const d2 = calculateRetryDelay(500, 2, 1, 60000, 0);
    expect(d0).toBe(500);
    expect(d1).toBe(500);
    expect(d2).toBe(500);
  });
});

describe('resolveBackoffMultiplier', () => {
  it("should return defaultMultiplier for 'exponential'", () => {
    expect(resolveBackoffMultiplier('exponential', 2)).toBe(2);
  });

  it('should return defaultMultiplier for undefined', () => {
    expect(resolveBackoffMultiplier(undefined, 2)).toBe(2);
  });

  it("should return 1 for 'linear'", () => {
    expect(resolveBackoffMultiplier('linear', 2)).toBe(1);
  });

  it("should return 1 for 'fixed'", () => {
    expect(resolveBackoffMultiplier('fixed', 2)).toBe(1);
  });

  it('should return the number directly for numeric input', () => {
    expect(resolveBackoffMultiplier(3, 2)).toBe(3);
    expect(resolveBackoffMultiplier(1.5, 2)).toBe(1.5);
  });
});
