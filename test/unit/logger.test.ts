/**
 * Unit tests for src/utils/logger.ts
 * Tests centralized logger: levels, enable/disable, custom transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStreamlineLogger, logger } from '../../src/utils/logger.js';

describe('Logger', () => {
  beforeEach(() => {
    // Reset to defaults
    configureStreamlineLogger({ level: 'info', enabled: true, transport: null });
  });

  it('should log info messages by default', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('test message');
    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe('INFO');
    expect(parsed.message).toBe('test message');
    expect(parsed.timestamp).toBeDefined();
    spy.mockRestore();
  });

  it('should suppress debug when level=info', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('should not appear');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('should show debug when level=debug', () => {
    configureStreamlineLogger({ level: 'debug' });
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('visible');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('should suppress all output when enabled=false', () => {
    configureStreamlineLogger({ enabled: false });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.info('nope');
    logger.error('nope either');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should suppress all output when level=silent', () => {
    configureStreamlineLogger({ level: 'silent' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.warn('nope');
    logger.error('nope');
    expect(warnSpy).not.toHaveBeenCalled();
    // error still logs even at silent? No — silent = level 4, error = level 3
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should use custom transport when set', () => {
    const entries: unknown[] = [];
    configureStreamlineLogger({
      transport: (entry) => entries.push(entry),
    });

    logger.info('custom', { runId: 'r1' });
    logger.warn('warning');

    expect(entries).toHaveLength(2);
    expect((entries[0] as Record<string, unknown>).message).toBe('custom');
    expect((entries[0] as Record<string, unknown>).runId).toBe('r1');
    expect((entries[1] as Record<string, unknown>).level).toBe('WARN');
  });

  it('should restore default transport when set to null', () => {
    configureStreamlineLogger({
      transport: () => {},
    });
    // Now restore
    configureStreamlineLogger({ transport: null });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('back to default');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('should include context fields in log output', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('step done', { runId: 'r1', stepId: 's1', attempt: 2 });
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.runId).toBe('r1');
    expect(parsed.stepId).toBe('s1');
    expect(parsed.attempt).toBe(2);
    spy.mockRestore();
  });

  it('should format error objects in error()', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('failed', new Error('boom'));
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.error.message).toBe('boom');
    expect(parsed.error.stack).toBeDefined();
    spy.mockRestore();
  });
});
