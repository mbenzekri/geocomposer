import path from "node:path"
import { fileURLToPath } from 'node:url'
import { LogLevel } from "./log-level.js"
import fs from "fs"
export type Constructor<T> = abstract new (...args: any[]) => T
export type Props = Record<string, unknown>
export type Dict<T> = Record<string, T>


export function isMain(metaurl: string): boolean {
    return process.argv[1] !== undefined && fileURLToPath(metaurl) === path.resolve(process.argv[1])
}

export type Args = {
    configPath: string
    clearTileCache: boolean
    port?: number
}

export const DEFAULT_CONFIG_PATH = 'config/config.json'

export function parseArgs(): Args {
    const args = process.argv.slice(2)
    const options: Args = {
        configPath: path.resolve(process.cwd(), process.env.CONFIG ?? DEFAULT_CONFIG_PATH),
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
  protected constructor(ctor: Function) {

    if (Singleton.instances.has(ctor)) {
      throw new Error(`${ctor.name} already initialized`)
    }

    Singleton.instances.set(ctor, this)
  }
  static delete(ctor: Function) {
     Singleton.instances.delete(ctor)
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

  get(name: string): T {
    const crs = this.reg.get(name)
    if (crs) return crs
    throw new Error(`Item ${name} not found in Registry ${this.name}`)
  }

  get all(): T[] {
    return [...this.reg.values()]
  }

  has(name: string): boolean {
    return this.reg.has(name)
  }
  clear() {
    this.reg.clear()
  }
}

export function assertExistsFile(path: string | undefined ) {
    if(path == null) return
    if (!fs.existsSync(path)) throw new Error(`File not found: ${path}`)
    if (!fs.statSync(path).isFile()) throw new Error(`Not a file: ${path}`)            
}
export function assertExistsCreateDir(path: string | undefined ) {
    if(path == null) return
    if (fs.existsSync(path) && !fs.statSync(path).isDirectory()) {
        throw new Error(`Not a directory: ${path}`)
    }
    try { fs.mkdirSync(path,{recursive: true}) } catch(e) { throw new Error(`Unable to create Directory: ${path}`) }
    if (!fs.existsSync(path)) throw new Error(`Directory not found: ${path}`)
    if (!fs.statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`)
}


export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value)
}

export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

export function isTruthy(value: unknown): boolean {
    return Boolean(Array.isArray(value) ? value.length : value)
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


export function paramsFromUrl(url: URL): Map<string, string> {
    const params = new Map<string, string>()

    for (const [key, value] of url.searchParams.entries()) {
        params.set(key.toUpperCase(), value)
    }

    return params
}


export function parsePort(value: string | undefined, fallback: number | undefined): number | undefined {
    if (value === undefined || value === '') return fallback

    const port = Number.parseInt(value, 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid PORT: ${value}`)
    }

    return port
}

export function parseNonNegativeInt(value: string, name: string, maxValue: number): number {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${name} must be a non-negative integer`)
    }

    if (number > maxValue) {
        throw new Error(`${name} exceeds maximum value ${maxValue}`)
    }

    return number
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

export function parsePositiveInt(value: string, name: string, maxValue: number): number {
    const number = Number.parseInt(value, 10)
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`${name} must be a positive integer`)
    }

    if (number > maxValue) {
        throw new Error(`${name} exceeds maximum value ${maxValue}`)
    }

    return number
}

export function parsePixelIndex(value: string | undefined, name: string, size: number): number {
    if (value === undefined || value === '') {
        throw new Error(`${name} is required`)
    }

    const number = Number(value)
    if (!Number.isInteger(number) || number < 0 || number >= size) {
        throw new Error(`${name} must be an integer pixel index between 0 and ${size - 1}`)
    }

    return number
}
