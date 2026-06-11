/**
 * Recurrence engine — computes the NEXT occurrence of a recurring scheduled
 * workflow from its persisted `SchedulingInfo`.
 *
 * Driven by the engine at scheduled-draft pickup: when the scheduler claims a
 * recurring draft (`scheduling.recurrence` present), it immediately creates
 * the next occurrence as a new draft with a deterministic idempotency key —
 * so a crash or a second worker cannot double-spawn the chain.
 *
 * Semantics (kept deliberately simple):
 *   - `daily` / `weekly` / `monthly` advance the ORIGINAL local wall-clock
 *     time (`scheduledFor` + `timezone`), so "9am daily in New York" stays
 *     9am across DST (luxon handles the offset shift; ambiguous/non-existent
 *     times go through `TimezoneHandler.calculateExecutionTime`).
 *   - `custom` uses a standard 5-field cron expression evaluated in the
 *     schedule's timezone (via cron-parser).
 *   - NO catch-up: if the engine was down across N missed occurrences, the
 *     next occurrence is the first one in the future — missed firings are
 *     skipped, not replayed.
 *   - `until` / `count` stop the chain: no next draft is created once the
 *     deadline passes or the occurrence budget is spent.
 */

import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import type { RecurrencePattern, SchedulingInfo } from '../core/types.js';
import { timezoneHandler } from './timezone-handler.js';

const LOCAL_ISO_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

/** Hard bound on the skip-missed-occurrences walk (defense vs broken patterns). */
const MAX_SKIP_ITERATIONS = 1000;

/**
 * Validate a recurrence pattern at schedule time — fail loudly at the API
 * boundary instead of silently never firing.
 */
export function validateRecurrence(recurrence: RecurrencePattern): void {
  const patterns = ['daily', 'weekly', 'monthly', 'custom'];
  if (!patterns.includes(recurrence.pattern)) {
    throw new Error(
      `Invalid recurrence.pattern "${recurrence.pattern}" — expected one of ${patterns.join(', ')}.`,
    );
  }
  if (recurrence.pattern === 'custom') {
    if (!recurrence.cronExpression) {
      throw new Error(`recurrence.pattern "custom" requires a cronExpression.`);
    }
    try {
      CronExpressionParser.parse(recurrence.cronExpression);
    } catch (err) {
      throw new Error(
        `Invalid recurrence.cronExpression "${recurrence.cronExpression}": ${(err as Error).message}`,
      );
    }
  }
  if (recurrence.daysOfWeek) {
    if (
      !Array.isArray(recurrence.daysOfWeek) ||
      recurrence.daysOfWeek.length === 0 ||
      recurrence.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      throw new Error(
        `recurrence.daysOfWeek must be a non-empty array of integers 0-6 (0=Sunday).`,
      );
    }
  }
  if (recurrence.dayOfMonth !== undefined) {
    if (
      !Number.isInteger(recurrence.dayOfMonth) ||
      recurrence.dayOfMonth < 1 ||
      recurrence.dayOfMonth > 31
    ) {
      throw new Error(`recurrence.dayOfMonth must be an integer 1-31.`);
    }
  }
  if (
    recurrence.count !== undefined &&
    (!Number.isInteger(recurrence.count) || recurrence.count < 1)
  ) {
    throw new Error(`recurrence.count must be a positive integer.`);
  }
}

/**
 * Compute the next occurrence's full `SchedulingInfo`, or `null` when the
 * chain is finished (`count` spent, `until` passed) or the input is not a
 * recurring schedule.
 *
 * Pure function: no I/O. `now` is injectable for tests.
 */
export function computeNextOccurrence(
  scheduling: SchedulingInfo,
  now: Date = new Date(),
): SchedulingInfo | null {
  const recurrence = scheduling.recurrence;
  if (!recurrence) return null;

  // Legacy-data guard: `recurrence` could be stored on runs created before
  // v2.6 (when the field was inert). Only spawn for patterns we positively
  // recognize — junk/unknown patterns stay inert instead of silently
  // activating (e.g. as an unintended daily job).
  if (!['daily', 'weekly', 'monthly', 'custom'].includes(recurrence.pattern)) return null;
  if (recurrence.pattern === 'custom' && !recurrence.cronExpression) return null;

  // Occurrence budget: the run being picked up is the Nth firing (1-based;
  // legacy/first runs without the counter are occurrence 1).
  const fired = recurrence.occurrences ?? 1;
  if (recurrence.count !== undefined && fired >= recurrence.count) return null;

  const zone = scheduling.timezone || 'UTC';

  let result: {
    scheduledFor: string;
    executionTime: Date;
    localTimeDisplay: string;
    isDSTTransition: boolean;
    dstNote?: string;
  };

  if (recurrence.pattern === 'custom') {
    // cron-parser already yields exact UTC instants in the target zone — no
    // DST recalculation needed (and re-deriving via a naive local string
    // could shift across an ambiguous fall-back hour).
    const interval = CronExpressionParser.parse(recurrence.cronExpression ?? '', {
      currentDate: now,
      tz: zone,
    });
    const executionTime = interval.next().toDate();
    const local = DateTime.fromJSDate(executionTime, { zone });
    result = {
      scheduledFor: local.toFormat(LOCAL_ISO_FORMAT),
      executionTime,
      localTimeDisplay: `${local.toFormat('yyyy-MM-dd HH:mm:ss')} ${local.offsetNameShort ?? zone}`,
      isDSTTransition: false,
    };
  } else {
    // Advance the original LOCAL wall-clock time so "9am daily" stays 9am
    // across DST. Walk forward past `now` (skip missed occurrences).
    let local = DateTime.fromFormat(scheduling.scheduledFor, LOCAL_ISO_FORMAT, { zone });
    if (!local.isValid) {
      // scheduledFor may carry sub-second/offset variants — fall back to ISO.
      local = DateTime.fromISO(scheduling.scheduledFor, { zone });
    }
    if (!local.isValid) return null;

    let next = advance(local, recurrence);
    let guard = 0;
    while (next.toUTC().toMillis() <= now.getTime()) {
      if (++guard > MAX_SKIP_ITERATIONS) return null;
      next = advance(next, recurrence);
    }

    // Route through the DST-aware calculator (spring-forward / fall-back).
    const naive = next.toFormat(LOCAL_ISO_FORMAT);
    const tz = timezoneHandler.calculateExecutionTime(naive, zone);
    result = {
      scheduledFor: naive,
      executionTime: tz.executionTime,
      localTimeDisplay: tz.localTimeDisplay,
      isDSTTransition: tz.isDSTTransition,
      ...(tz.dstNote ? { dstNote: tz.dstNote } : {}),
    };
  }

  if (recurrence.until && result.executionTime.getTime() > new Date(recurrence.until).getTime()) {
    return null;
  }

  return {
    scheduledFor: result.scheduledFor,
    timezone: zone,
    localTimeDisplay: result.localTimeDisplay,
    executionTime: result.executionTime,
    isDSTTransition: result.isDSTTransition,
    ...(result.dstNote ? { dstNote: result.dstNote } : {}),
    recurrence: { ...recurrence, occurrences: fired + 1 },
  };
}

/** One pattern step from a given local time (daily/weekly/monthly). */
function advance(local: DateTime, recurrence: RecurrencePattern): DateTime {
  switch (recurrence.pattern) {
    case 'daily':
      return local.plus({ days: 1 });

    case 'weekly': {
      if (!recurrence.daysOfWeek || recurrence.daysOfWeek.length === 0) {
        return local.plus({ weeks: 1 });
      }
      // Pattern uses 0=Sunday..6=Saturday; luxon weekday is 1=Monday..7=Sunday.
      const wanted = new Set(recurrence.daysOfWeek.map((d) => (d === 0 ? 7 : d)));
      let next = local.plus({ days: 1 });
      for (let i = 0; i < 7; i++) {
        if (wanted.has(next.weekday)) return next;
        next = next.plus({ days: 1 });
      }
      return next; // unreachable for valid input
    }

    case 'monthly': {
      const day = recurrence.dayOfMonth ?? local.day;
      const nextMonth = local.plus({ months: 1 }).startOf('month');
      // Clamp: dayOfMonth 31 in a 30-day month fires on the last day.
      return nextMonth.set({
        day: Math.min(day, nextMonth.daysInMonth ?? 28),
        hour: local.hour,
        minute: local.minute,
        second: local.second,
      });
    }

    default:
      // 'custom' never reaches here (handled by cron branch).
      return local.plus({ days: 1 });
  }
}
