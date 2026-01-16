/**
 * Scheduling Module
 *
 * Timezone-aware workflow scheduling with DST edge case handling.
 *
 * @example
 * ```typescript
 * import { SchedulingService, TimezoneHandler } from '@classytic/streamline/scheduling';
 *
 * // Create scheduling service
 * const scheduler = new SchedulingService(workflow, handlers);
 *
 * // Schedule workflow for 9 AM New York time
 * const run = await scheduler.schedule({
 *   scheduledFor: '2024-12-25T09:00:00',
 *   timezone: 'America/New_York',
 *   input: { message: 'Happy Holidays!' }
 * });
 * ```
 */

// Core scheduling service
export {
  SchedulingService,
  type ScheduleWorkflowOptions,
  type GetScheduledWorkflowsOptions,
  type SchedulingServiceConfig,
} from './scheduling.service.js';

// Timezone utilities
export {
  TimezoneHandler,
  timezoneHandler,
  type TimezoneCalculationResult,
} from './timezone-handler.js';
