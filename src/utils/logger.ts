/**
 * Centralized structured logger for streamline.
 *
 * All engine output goes through this logger — no direct console.log calls.
 * Controlled via `configureLogger()` for enable/disable/level/custom transport.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogContext {
  runId?: string;
  stepId?: string;
  workflowId?: string;
  attempt?: number;
  [key: string]: unknown;
}

/**
 * Custom log transport — replace the default JSON-to-console output
 * with your own (e.g., Pino, Winston, Datadog, file writer).
 */
export type LogTransport = (entry: {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: unknown;
}) => void;

/** Numeric log levels — O(1) comparison on every log call */
const LOG_LEVEL_VALUE: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** Default transport: JSON to console */
function defaultTransport(logFn: (msg: string) => void, entry: Record<string, unknown>): void {
  logFn(JSON.stringify(entry));
}

class Logger {
  private minLevelValue = LOG_LEVEL_VALUE.info;
  private enabled = true;
  private customTransport: LogTransport | null = null;

  /** Set minimum log level. 'silent' disables all output. */
  setLevel(level: LogLevel): void {
    this.minLevelValue = LOG_LEVEL_VALUE[level];
  }

  /** Enable or disable all logging. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Set a custom transport. Pass null to restore default JSON-to-console. */
  setTransport(transport: LogTransport | null): void {
    this.customTransport = transport;
  }

  debug(message: string, context?: LogContext): void {
    if (!this.enabled || this.minLevelValue > LOG_LEVEL_VALUE.debug) return;
    this.write('DEBUG', console.debug, message, context);
  }

  info(message: string, context?: LogContext): void {
    if (!this.enabled || this.minLevelValue > LOG_LEVEL_VALUE.info) return;
    this.write('INFO', console.info, message, context);
  }

  warn(message: string, context?: LogContext): void {
    if (!this.enabled || this.minLevelValue > LOG_LEVEL_VALUE.warn) return;
    this.write('WARN', console.warn, message, context);
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    if (!this.enabled || this.minLevelValue > LOG_LEVEL_VALUE.error) return;
    const errorContext =
      error instanceof Error
        ? { error: { message: error.message, stack: error.stack }, ...context }
        : { error, ...context };
    this.write('ERROR', console.error, message, errorContext);
  }

  private write(
    level: string,
    logFn: (msg: string) => void,
    message: string,
    context?: LogContext,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };

    if (this.customTransport) {
      this.customTransport(entry);
    } else {
      defaultTransport(logFn, entry);
    }
  }
}

/** Global streamline logger instance */
export const logger = new Logger();

/**
 * Configure streamline logging. Call once at app startup.
 *
 * @example Disable all logging
 * ```typescript
 * import { configureStreamlineLogger } from '@classytic/streamline';
 * configureStreamlineLogger({ enabled: false });
 * ```
 *
 * @example Set to debug level
 * ```typescript
 * configureStreamlineLogger({ level: 'debug' });
 * ```
 *
 * @example Use Pino as transport
 * ```typescript
 * import pino from 'pino';
 * const pinoLogger = pino();
 * configureStreamlineLogger({
 *   transport: (entry) => pinoLogger[entry.level.toLowerCase()](entry, entry.message),
 * });
 * ```
 */
export function configureStreamlineLogger(options: {
  level?: LogLevel;
  enabled?: boolean;
  transport?: LogTransport | null;
}): void {
  if (options.level !== undefined) logger.setLevel(options.level);
  if (options.enabled !== undefined) logger.setEnabled(options.enabled);
  if (options.transport !== undefined) logger.setTransport(options.transport);
}
