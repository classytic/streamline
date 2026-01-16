import { randomUUID } from 'node:crypto';

export function generateRunId(): string {
  return randomUUID();
}

/**
 * Calculate retry delay with exponential backoff and jitter
 * 
 * Jitter prevents thundering herd problem where many workflows
 * retry at exactly the same time after a system failure.
 * 
 * @param baseDelay - Starting delay (e.g., 1000ms)
 * @param attempt - Current attempt number (0-indexed)
 * @param multiplier - Exponential multiplier (e.g., 2 for doubling)
 * @param maxDelay - Cap for maximum delay
 * @param jitterFactor - Randomness factor (0.3 = ±30%)
 * @returns Delay in milliseconds with applied jitter
 * 
 * @example
 * // Attempt 0: 1000ms ± 30% = 700-1300ms
 * // Attempt 1: 2000ms ± 30% = 1400-2600ms
 * // Attempt 2: 4000ms ± 30% = 2800-5200ms
 */
export function calculateRetryDelay(
  baseDelay: number,
  attempt: number,
  multiplier: number,
  maxDelay: number,
  jitterFactor: number = 0.3
): number {
  const exponentialDelay = baseDelay * Math.pow(multiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  
  // Apply jitter: ±jitterFactor (e.g., ±30%)
  const jitter = 1 + (Math.random() * 2 - 1) * jitterFactor; // 0.7 to 1.3 for 30%
  const delayWithJitter = Math.round(cappedDelay * jitter);
  
  return Math.max(delayWithJitter, 0); // Ensure non-negative
}

export function isRetriableError(error: Error): boolean {
  const nonRetriableErrors = ['ValidationError', 'AuthenticationError', 'AuthorizationError'];
  return !nonRetriableErrors.includes(error.name);
}

/**
 * Error with optional code property (common in Node.js errors)
 */
interface ErrorWithCode extends Error {
  code?: string;
}

export function sanitizeError(error: Error): { message: string; code?: string; stack?: string } {
  const errorWithCode = error as ErrorWithCode;
  return {
    message: error.message,
    code: errorWithCode.code,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  };
}

export function validateStepId(stepId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(stepId);
}
