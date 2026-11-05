import pino from 'pino';

/**
 * JSON lines to stdout; systemd forwards them to journald (no log files on the SD card).
 * journald adds its own timestamp, so pino's is omitted. Secrets are never passed to the
 * logger, but the redact list is a backstop in case an error object carries one.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
  timestamp: false,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ['password', 'token', '*.password', '*.token', 'headers.authorization', 'headers.Authorization'],
    censor: '[redacted]',
  },
});

export type Logger = pino.Logger;
