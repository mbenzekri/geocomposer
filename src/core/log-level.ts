export enum LogLevel {
  DEBUG = 0,
  LOG = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

const timestamp = (): string => {
  return new Date().toISOString()
}

const originalConsole = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

const withTimestamp =
  (fn: (...args: any[]) => void) =>
  (...args: any[]): void => {
    fn(`[${timestamp()}]`, ...args)
  }

console.DEBUG = LogLevel.DEBUG
console.LOG = LogLevel.LOG
console.WARN = LogLevel.WARN
console.ERROR = LogLevel.ERROR
console.NONE = LogLevel.NONE

console.setLevel = (level: LogLevel): void => {
  console.debug =
    level <= LogLevel.DEBUG
      ? withTimestamp(originalConsole.debug)
      : () => {}

  console.log =
    level <= LogLevel.LOG
      ? withTimestamp(originalConsole.log)
      : () => {}

  console.warn =
    level <= LogLevel.WARN
      ? withTimestamp(originalConsole.warn)
      : () => {}

  console.error =
    level <= LogLevel.ERROR
      ? withTimestamp(originalConsole.error)
      : () => {}
}

declare global {
  interface Console {
    DEBUG: LogLevel
    LOG: LogLevel
    WARN: LogLevel
    ERROR: LogLevel
    NONE: LogLevel
    setLevel(level: LogLevel): void
  }
}