import { DateTime } from 'luxon';

/**
 * Result of timezone calculation including DST transition metadata
 */
export interface TimezoneCalculationResult {
  /** UTC execution time for scheduler to use */
  executionTime: Date;
  /** Local time in user's timezone (for display) */
  localTimeDisplay: string;
  /** Whether this time falls during a DST transition */
  isDSTTransition: boolean;
  /** Human-readable note about DST adjustment (if any) */
  dstNote?: string;
}

/**
 * TimezoneHandler - Industry-standard timezone conversion with DST edge case handling
 *
 * Handles two critical DST edge cases:
 * 1. Spring Forward (non-existent time): When clocks jump forward, e.g., 2:30 AM doesn't exist
 * 2. Fall Back (ambiguous time): When clocks fall back, e.g., 1:30 AM occurs twice
 *
 * Design Philosophy:
 * - Store both intent (timezone + local time) AND execution time (UTC)
 * - Gracefully handle invalid times by adjusting forward
 * - Warn users about ambiguous times during fall back
 * - Use IANA timezone database (not abbreviations like "EST")
 *
 * @example
 * ```typescript
 * const handler = new TimezoneHandler();
 *
 * // Schedule for 9:00 AM New York time
 * const result = handler.calculateExecutionTime(
 *   '2024-03-10T09:00:00',
 *   'America/New_York'
 * );
 *
 * console.log(result.executionTime); // UTC time for scheduler
 * console.log(result.isDSTTransition); // false (9 AM is safe)
 * ```
 */
export class TimezoneHandler {
  /**
   * Calculate UTC execution time from user's local timezone intent
   *
   * @param scheduledFor - Local date/time as ISO string WITHOUT timezone (naive datetime)
   *                       Format: "YYYY-MM-DDTHH:mm:ss" (e.g., "2024-03-10T09:00:00")
   *
   *                       This represents the LOCAL time in the target timezone.
   *                       Do NOT include timezone offset (Z, +00:00, etc.)
   *
   * @param timezone - IANA timezone name (e.g., "America/New_York", "Europe/London")
   * @returns Calculation result with execution time and DST metadata
   *
   * @throws {Error} If timezone is invalid or scheduledFor format is invalid
   *
   * @example Basic Usage
   * ```typescript
   * // Schedule for 9:00 AM New York time
   * const result = handler.calculateExecutionTime(
   *   '2024-03-10T09:00:00',
   *   'America/New_York'
   * );
   * console.log(result.executionTime); // UTC Date object for scheduler
   * console.log(result.localTimeDisplay); // "2024-03-10 09:00:00 EDT"
   * ```
   *
   * @example Spring Forward Edge Case (non-existent time)
   * ```typescript
   * const result = handler.calculateExecutionTime(
   *   '2024-03-10T02:30:00', // 2:30 AM doesn't exist (DST springs forward)
   *   'America/New_York'
   * );
   * // Result: Adjusted to 3:30 AM, isDSTTransition=true, dstNote explains adjustment
   * ```
   *
   * @example Fall Back Edge Case (ambiguous time)
   * ```typescript
   * const result = handler.calculateExecutionTime(
   *   '2024-11-03T01:30:00', // 1:30 AM occurs twice (DST falls back)
   *   'America/New_York'
   * );
   * // Result: Uses first occurrence (DST), isDSTTransition=true, dstNote warns of ambiguity
   * ```
   */
  calculateExecutionTime(scheduledFor: Date | string, timezone: string): TimezoneCalculationResult {
    // Validate timezone using Luxon (throws if invalid)
    if (!DateTime.local().setZone(timezone).isValid) {
      throw new Error(
        `Invalid timezone: ${timezone}. Use IANA timezone names like "America/New_York"`,
      );
    }

    // Normalize to ISO string format
    let isoString: string;
    if (scheduledFor instanceof Date) {
      // Convert Date to ISO-like string (YYYY-MM-DDTHH:mm:ss) using local components
      // This preserves the "naive" datetime interpretation (e.g., 9:00 AM means 9:00 AM in target timezone)
      const y = scheduledFor.getFullYear();
      const m = String(scheduledFor.getMonth() + 1).padStart(2, '0');
      const d = String(scheduledFor.getDate()).padStart(2, '0');
      const hh = String(scheduledFor.getHours()).padStart(2, '0');
      const mm = String(scheduledFor.getMinutes()).padStart(2, '0');
      const ss = String(scheduledFor.getSeconds()).padStart(2, '0');
      isoString = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
    } else {
      isoString = scheduledFor;
    }

    // Parse ISO string directly in target timezone (clean, unambiguous approach)
    const dt = DateTime.fromISO(isoString, { zone: timezone });
    if (!dt.isValid) {
      throw new Error(
        `Invalid scheduledFor: "${scheduledFor}". ` +
          `Expected ISO format without timezone: "YYYY-MM-DDTHH:mm:ss" (e.g., "2024-03-10T09:00:00")`,
      );
    }

    const year = dt.year;
    const month = dt.month;
    const day = dt.day;
    const hour = dt.hour;
    const minute = dt.minute;
    const second = dt.second;

    // Create DateTime in target timezone (using explicit components for DST handling)
    const dtInZone = DateTime.fromObject(
      { year, month, day, hour, minute, second },
      { zone: timezone },
    );

    // Edge Case 1: Spring Forward (non-existent time)
    // When clocks jump forward, some times don't exist (e.g., 2:30 AM)
    if (!dtInZone.isValid) {
      // Luxon's invalid reason tells us what happened
      const reason = dtInZone.invalidReason || 'unknown';

      // Adjust forward to next valid time (usually 1 hour ahead)
      const adjustedDt = DateTime.fromObject(
        { year, month, day, hour: hour + 1, minute, second },
        { zone: timezone },
      );

      return {
        executionTime: adjustedDt.toUTC().toJSDate(),
        localTimeDisplay: adjustedDt.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
        isDSTTransition: true,
        dstNote: `Scheduled time ${hour}:${String(minute).padStart(2, '0')} does not exist due to DST spring forward. Adjusted to ${adjustedDt.hour}:${String(adjustedDt.minute).padStart(2, '0')}. Reason: ${reason}`,
      };
    }

    // Edge Case 2: Fall Back (ambiguous time)
    // When clocks fall back, some times occur twice (e.g., 1:30 AM)
    // Check if this time is ambiguous by seeing if adding 1 hour crosses DST boundary
    const oneHourLater = dtInZone.plus({ hours: 1 });
    const isAmbiguous =
      dtInZone.isInDST !== oneHourLater.isInDST && dtInZone.offset !== oneHourLater.offset;

    if (isAmbiguous) {
      // During fall back, Luxon defaults to the FIRST occurrence (DST time)
      // This is the safer choice for scheduling (earlier execution)
      return {
        executionTime: dtInZone.toUTC().toJSDate(),
        localTimeDisplay: dtInZone.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
        isDSTTransition: true,
        dstNote: `Scheduled time ${hour}:${String(minute).padStart(2, '0')} is ambiguous due to DST fall back (occurs twice). Using first occurrence (${dtInZone.offsetNameShort}). Consider scheduling outside 1-2 AM window during fall transitions.`,
      };
    }

    // Normal case: no DST transition issues
    return {
      executionTime: dtInZone.toUTC().toJSDate(),
      localTimeDisplay: dtInZone.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      isDSTTransition: false,
    };
  }

  /**
   * Validate if a timezone is recognized by IANA database
   *
   * @param timezone - Timezone string to validate
   * @returns true if valid, false otherwise
   *
   * @example
   * ```typescript
   * handler.isValidTimezone('America/New_York'); // true
   * handler.isValidTimezone('EST'); // false (use IANA names)
   * handler.isValidTimezone('Invalid/Zone'); // false
   * ```
   */
  isValidTimezone(timezone: string): boolean {
    try {
      const dt = DateTime.local().setZone(timezone);
      return dt.isValid;
    } catch {
      return false;
    }
  }

  /**
   * Get current offset for a timezone (useful for debugging)
   *
   * @param timezone - IANA timezone name
   * @returns Offset in minutes from UTC (e.g., -300 for EST)
   *
   * @example
   * ```typescript
   * handler.getCurrentOffset('America/New_York'); // -300 (EST) or -240 (EDT)
   * ```
   */
  getCurrentOffset(timezone: string): number {
    const dt = DateTime.local().setZone(timezone);
    if (!dt.isValid) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }
    return dt.offset;
  }

  /**
   * Check if a timezone is currently in DST
   *
   * @param timezone - IANA timezone name
   * @returns true if currently observing DST, false otherwise
   *
   * @example
   * ```typescript
   * handler.isInDST('America/New_York'); // true in summer, false in winter
   * ```
   */
  isInDST(timezone: string): boolean {
    const dt = DateTime.local().setZone(timezone);
    if (!dt.isValid) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }
    return dt.isInDST;
  }
}

/**
 * Singleton instance for convenience
 * Use this for most cases unless you need custom configuration
 */
export const timezoneHandler = new TimezoneHandler();
