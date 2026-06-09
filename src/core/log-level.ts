enum LogLevel {
  DEBUG = 0,
  LOG = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

const original = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
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

console.DEBUG = LogLevel.DEBUG
console.LOG = LogLevel.LOG
console.WARN = LogLevel.WARN
console.ERROR = LogLevel.ERROR
console.NONE = LogLevel.NONE

console.setLevel = (level: LogLevel): void => {
  console.debug = level <= LogLevel.DEBUG ? original.debug : () => {}
  console.log = level <= LogLevel.LOG ? original.log : () => {}
  console.warn = level <= LogLevel.WARN ? original.warn : () => {}
  console.error = level <= LogLevel.ERROR ? original.error : () => {}
}