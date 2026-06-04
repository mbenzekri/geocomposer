import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from './config/config.js'
import { Service } from './service/service.js'
import { TileCache } from './tileset/tile-cache.js'

type LaunchOptions = {
  configPath: string
  clearTileCache: boolean
}

export class GeoComposer {
  readonly server: Server

  private shuttingDown = false

  constructor(
    private readonly config: Config,
    private readonly port = config.server.port
  ) {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        Service.sendText(res, 500, message, 'text/plain; charset=utf-8', req.method === 'HEAD')
      })
    })
  }

  static async fromEnv(options: Partial<LaunchOptions> = {}): Promise<GeoComposer> {
    const configPath = resolve(process.cwd(), options.configPath ?? process.env.CONFIG ?? 'config.json')
    const config = await Config.load(configPath)

    if (options.clearTileCache) {
      await clearTileCaches(config)
    }

    return new GeoComposer(config, parsePort(process.env.PORT, config.server.port))
  }

  async start(): Promise<void> {
    try {
      await this.config.open()
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server.off('listening', onListening)
          reject(error)
        }

        const onListening = () => {
          this.server.off('error', onError)
          this.logListening()
          resolve()
        }

        this.server.once('error', onError)
        this.server.once('listening', onListening)
        this.server.listen(this.port)
      })
    } catch (error) {
      try {
        await this.config.close()
      } catch {
        // Preserve the startup error; cleanup errors are secondary here.
      }
      throw error
    }
  }

  async stop(signal = 'manual'): Promise<void> {
    if (this.shuttingDown) {
      return
    }

    this.shuttingDown = true
    console.log(`Stopping GeoComposer server (${signal})...`)

    const forceClose = setTimeout(() => {
      this.server.closeAllConnections?.()
    }, 10_000)

    try {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error?: Error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })

        this.server.closeIdleConnections?.()
      })

      await this.config.close()
    } finally {
      clearTimeout(forceClose)
      this.shuttingDown = false
    }
  }

  trapSignals(): void {
    process.once('SIGINT', () => {
      this.shutdown('SIGINT')
    })

    process.once('SIGTERM', () => {
      this.shutdown('SIGTERM')
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const service = this.config.services.find((entry) => entry.matches(url.pathname))

    if (service) {
      await service.handle(req, res)
      return
    }

    Service.setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    Service.sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', req.method === 'HEAD')
  }

  private logListening(): void {
    const baseUrl = `http://localhost:${this.port}`
    const wmsPath = this.config.wmsService.path
    console.log(`Config: ${this.config.path}`)
    console.log(`WMS listening on ${baseUrl}${wmsPath}`)
    console.log(`GetCapabilities: ${baseUrl}${wmsPath}?SERVICE=WMS&REQUEST=GetCapabilities`)

    if (this.config.xyzService && this.config.xyz) {
      const xyzPath = this.config.xyzService.path
      console.log(`XYZ listening on ${baseUrl}${xyzPath}`)

      const sampleTileset = this.config.xyz.tilesets[0]?.name
      if (sampleTileset) {
        console.log(`Sample tile: ${baseUrl}${xyzPath}/${encodeURIComponent(sampleTileset)}/1/1/1.png`)
        console.log(`Retina sample: ${baseUrl}${xyzPath}/${encodeURIComponent(sampleTileset)}/1/1/1@2x.png`)
      }
    }

    if (this.config.wmtsService && this.config.wmts) {
      const wmtsPath = this.config.wmtsService.path
      console.log(`WMTS listening on ${baseUrl}${wmtsPath}`)
      console.log(`WMTS GetCapabilities: ${baseUrl}${wmtsPath}?SERVICE=WMTS&REQUEST=GetCapabilities`)

      const sampleTileset = this.config.wmts.tilesets[0]?.name
      if (sampleTileset) {
        console.log(`WMTS sample tile: ${baseUrl}${wmtsPath}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${encodeURIComponent(sampleTileset)}&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX=1&TILEROW=1&TILECOL=1&FORMAT=image%2Fpng`)
      }
    }
  }

  private shutdown(signal: string): void {
    if (this.shuttingDown) {
      this.server.closeAllConnections?.()
      process.exit(1)
    }

    void this.stop(signal).then(
      () => {
        process.exit(0)
      },
      (error: unknown) => {
        console.error(error)
        process.exit(1)
      }
    )
  }

}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback

  const port = Number.parseInt(value, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`)
  }

  return port
}

function parseLaunchOptions(args: readonly string[]): LaunchOptions {
  const options: LaunchOptions = {
    configPath: resolve(process.cwd(), process.env.CONFIG ?? 'config.json'),
    clearTileCache: false
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--clear-tile-cache') {
      options.clearTileCache = true
      continue
    }

    if (arg === '--config' || arg === '-c') {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`${arg} requires a config path`)
      }

      options.configPath = resolve(process.cwd(), value)
      index += 1
      continue
    }

    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length)
      if (!value) {
        throw new Error('--config requires a config path')
      }

      options.configPath = resolve(process.cwd(), value)
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

async function clearTileCaches(config: Config): Promise<void> {
  const dirs = uniqueStrings([
    config.xyz?.cache,
    config.wmts?.cache
  ])

  if (dirs.length === 0) {
    console.log('No tile cache configured.')
    return
  }

  for (const dir of dirs) {
    await new TileCache(dir).clear()
    console.log(`Cleared tile cache: ${dir}`)
  }
}

function uniqueStrings(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))]
}

if (isMain()) {
  const geo = await GeoComposer.fromEnv(parseLaunchOptions(process.argv.slice(2)))
  geo.trapSignals()
  await geo.start()
}

function isMain(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
}
