/**
 * Scheduling Module
 *
 * Timezone-aware workflow scheduling with DST edge case handling.
 *
 * @example
 * ```typescript
 * import { SchedulingService, TimezoneHandler } from '@classytic/streamline';
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

// Recurrence engine — next-occurrence math for recurring scheduled workflows.
// `computeNextOccurrence` is exported for hosts that want to preview the next
// firing; `validateRecurrence` is what `SchedulingService.schedule` enforces.
export { computeNextOccurrence, validateRecurrence } from './recurrence.js';
// Core scheduling service
export {
  type GetScheduledWorkflowsOptions,
  type ScheduleWorkflowOptions,
  SchedulingService,
  type SchedulingServiceConfig,
} from './scheduling.service.js';

// Timezone utilities
export {
  type TimezoneCalculationResult,
  TimezoneHandler,
  timezoneHandler,
} from './timezone-handler.js';
