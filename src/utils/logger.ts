/**
 * Structured logging utility
 * Simple, type-safe logging with log levels and context
 * Can be easily replaced with Winston/Pino in production
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  runId?: string;
  stepId?: string;
  workflowId?: string;
  attempt?: number;
  [key: string]: unknown;
}

class Logger {
  private minLevel: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const errorContext = error instanceof Error
      ? { error: { message: error.message, stack: error.stack }, ...context }
      : { error, ...context };
    this.log('error', message, errorContext);
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...context,
    };

    const logFn = this.getLogFunction(level);
    logFn(JSON.stringify(logEntry));
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private getLogFunction(level: LogLevel): (msg: string) => void {
    switch (level) {
      case 'error':
        return console.error;
      case 'warn':
        return console.warn;
      case 'info':
        return console.info;
      case 'debug':
      default:
        return console.debug;
    }
  }
}

export const logger = new Logger();

// For development/testing, set to debug
if (process.env.NODE_ENV === 'development') {
  logger.setLevel('debug');
}
