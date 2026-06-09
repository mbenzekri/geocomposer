import path from "node:path"
import { LogLevel } from "./log-level.js"
export type Constructor<T> = abstract new (...args: any[]) => T
export type Props = Record<string, unknown>
export type Dict<T> = Record<string, T>


export type Args = {
    configPath: string
    clearTileCache: boolean
    port?: number
}

export function parseArgs(): Args {
    const args = process.argv.slice(2)
    const options: Args = {
        configPath: path.resolve(process.cwd(), process.env.CONFIG ?? 'config.json'),
        clearTileCache: false
    }
    console.setLevel(LogLevel.LOG)

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]

        if (arg === '--clear-cache' || arg === '-cc') {
            options.clearTileCache = true
            continue
        }

        if (arg === '--port' || arg === '-p') {
            const value = args[index + 1]
            if (!value || value.startsWith('-')) {
                throw new Error(`${arg} requires a port number`)
            }

            options.port = parsePort(value, undefined)
            index += 1
            continue
        }
        if (arg === '--loglevel' || arg === '-l') {
            const value = args[index + 1]
            if (!value || value.startsWith('-')) {
                throw new Error(`${arg} requires a level `)
            }
            const levels = ["DEBUG" ,"LOG","WARN","ERROR","NONE"]
            const level = levels.indexOf(value)
            if (level >= 0) {
                console.setLevel(level)
                console.log(`[Logging] - level ${value}`)
            }
            index += 1
            continue
        }

        if (arg === '--config' || arg === '-c') {
            const value = args[index + 1]
            if (!value || value.startsWith('-')) {
                throw new Error(`${arg} requires a config path`)
            }

            options.configPath = path.resolve(process.cwd(), value)
            index += 1
            continue
        }

        if (arg.startsWith('--config=')) {
            const value = arg.slice('--config='.length)
            if (!value) {
                throw new Error('--config requires a config path')
            }

            options.configPath = path.resolve(process.cwd(), value)
            continue
        }

        throw new Error(`Unknown argument: ${arg}`)
    }

    return options
}

export abstract class Singleton {
  private static instances = new Map<Function, unknown>()

  protected constructor() {
    const type = this.constructor

    if (Singleton.instances.has(type)) {
      throw new Error(`${type.name} already initialized`)
    }

    Singleton.instances.set(type, this)
  }

  static instance<T>(
    this: abstract new (...args: any[]) => T
  ): T {
    const instance = Singleton.instances.get(this)

    if (!instance) {
      throw new Error(`${this.name} not initialized`)
    }

    return instance as T
  }
}

export class Registry<T>  {
  private reg = new Map<string, T>()
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  set(name: string, item: T): void {
    if (this.reg.has(name)) {
      throw new Error(`Item ${name} already exists in Registry ${this.name}`)
    }

    this.reg.set(name, item)
  }

  get(name: string): T | undefined {
    return this.reg.get(name)
  }

  get all(): T[] {
    return [...this.reg.values()]
  }

  has(name: string): boolean {
    return this.reg.has(name)
  }
}


export function isTruthy(value: unknown): boolean {
    return Boolean(Array.isArray(value) ? value.length : value)
}

export function parsePort(value: string | undefined, fallback: number | undefined): number | undefined {
    if (value === undefined || value === '') return fallback

    const port = Number.parseInt(value, 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid PORT: ${value}`)
    }

    return port
}

export function stringify(value: unknown): string {
    return String(value == null ? '' : value)
}

export function escape(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export function nonNegativeInteger(value: string, name: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} must be a non-negative integer`)
    }

    const number = Number(value)
    if (!Number.isSafeInteger(number)) {
        throw new Error(`${name} is outside the safe integer range`)
    }

    return number
}

export function paramsFromUrl(url: URL): Map<string, string> {
    const params = new Map<string, string>()

    for (const [key, value] of url.searchParams.entries()) {
        params.set(key.toUpperCase(), value)
    }

    return params
}
