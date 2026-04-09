/**
 * Unit tests for src/utils/validation.ts
 * Pure functions — no DB required.
 */

import { describe, it, expect } from 'vitest';
import { validateId, validateRetryConfig } from '../../src/utils/validation.js';

describe('validateId', () => {
  it('should accept valid alphanumeric IDs', () => {
    expect(() => validateId('hello')).not.toThrow();
    expect(() => validateId('my-workflow')).not.toThrow();
    expect(() => validateId('step_1')).not.toThrow();
    expect(() => validateId('CamelCase123')).not.toThrow();
  });

  it('should reject empty string', () => {
    expect(() => validateId('')).toThrow('non-empty string');
  });

  it('should reject dots', () => {
    expect(() => validateId('bad.id', 'step')).toThrow('step ID "bad.id" contains invalid characters');
  });

  it('should reject spaces', () => {
    expect(() => validateId('bad id')).toThrow('invalid characters');
  });

  it('should reject slashes', () => {
    expect(() => validateId('path/traversal')).toThrow('invalid characters');
  });

  it('should reject NoSQL operators', () => {
    expect(() => validateId('$gt')).toThrow('invalid characters');
    expect(() => validateId('{"$ne":""}')).toThrow('invalid characters');
  });

  it('should reject IDs exceeding max length', () => {
    expect(() => validateId('a'.repeat(200))).toThrow('too long');
  });

  it('should reject null bytes', () => {
    expect(() => validateId('ok\x00evil')).toThrow('invalid characters');
  });
});

describe('validateRetryConfig', () => {
  it('should accept valid configs', () => {
    expect(() => validateRetryConfig(3, 5000)).not.toThrow();
    expect(() => validateRetryConfig(0, 100)).not.toThrow();
    expect(() => validateRetryConfig(undefined, undefined)).not.toThrow();
  });

  it('should reject negative retries', () => {
    expect(() => validateRetryConfig(-1)).toThrow('non-negative integer');
  });

  it('should reject float retries', () => {
    expect(() => validateRetryConfig(2.5)).toThrow('non-negative integer');
  });

  it('should reject zero timeout', () => {
    expect(() => validateRetryConfig(undefined, 0)).toThrow('positive integer');
  });

  it('should reject negative timeout', () => {
    expect(() => validateRetryConfig(undefined, -100)).toThrow('positive integer');
  });

  it('should reject negative retryDelay', () => {
    expect(() => validateRetryConfig(undefined, undefined, -10)).toThrow('retryDelay must be a non-negative integer');
  });

  it('should reject zero retryBackoff (number must be positive)', () => {
    expect(() => validateRetryConfig(undefined, undefined, undefined, 0)).toThrow(
      "retryBackoff must be 'exponential', 'linear', 'fixed', or a positive number",
    );
  });

  it('should accept valid retryBackoff values', () => {
    expect(() => validateRetryConfig(undefined, undefined, undefined, 'exponential')).not.toThrow();
    expect(() => validateRetryConfig(undefined, undefined, undefined, 'linear')).not.toThrow();
    expect(() => validateRetryConfig(undefined, undefined, undefined, 'fixed')).not.toThrow();
    expect(() => validateRetryConfig(undefined, undefined, undefined, 3)).not.toThrow();
  });
});
