/**
 * Logger interface. Every Doubloon package accepts an optional logger.
 * Compatible with pino, winston, console, or any structured logger.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** No-op logger. Used when no logger is provided. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
