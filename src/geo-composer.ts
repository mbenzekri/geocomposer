import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type LoadedConfig } from './config/config.js'
import type { Service } from './service/service.js'
import { Wms } from './service/wms.js'
import { Xyz } from './service/xyz.js'

export class GeoComposer {
  readonly server: Server
  readonly paths: {
    readonly wms: string
    readonly xyz?: string
  }

  private readonly services: readonly Service[]
  private readonly wms: Wms
  private readonly xyz?: Xyz
  private readonly sockets = new Set<Socket>()
  private shuttingDown = false

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly port = loaded.server.port
  ) {
    this.wms = new Wms(loaded.wms)
    this.xyz = loaded.xyz ? new Xyz(loaded.xyz) : undefined
    this.services = [
      this.wms,
      ...(this.xyz ? [this.xyz] : [])
    ]

    this.paths = {
      wms: this.wms.path,
      ...(this.xyz ? { xyz: this.xyz.path } : {})
    }

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        sendText(res, 500, message, 'text/plain; charset=utf-8', req.method === 'HEAD')
      })
    })

    this.trackConnections()
  }

  static async fromEnv(): Promise<GeoComposer> {
    const configPath = resolve(process.cwd(), process.env.CONFIG ?? 'config.json')
    const loaded = await loadConfig(configPath)
    return new GeoComposer(loaded, parsePort(process.env.PORT, loaded.server.port))
  }

  async start(): Promise<void> {
    try {
      await this.openServices()
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
      await this.closeServices()
      throw error
    }
  }

  async stop(signal = 'manual'): Promise<void> {
    if (this.shuttingDown) {
      this.destroySockets()
      return
    }

    this.shuttingDown = true
    console.log(`Stopping GeoComposer server (${signal})...`)

    const forceClose = setTimeout(() => {
      this.server.closeAllConnections?.()
      this.destroySockets()
    }, 1000)

    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })

      this.server.closeIdleConnections?.()
      this.server.closeAllConnections?.()
    }).finally(() => {
      clearTimeout(forceClose)
    })

    await this.closeServices()
    this.shuttingDown = false
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
    const service = this.services.find((entry) => entry.matches(url.pathname))

    if (service) {
      await service.handle(req, res)
      return
    }

    setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', req.method === 'HEAD')
  }

  private trackConnections(): void {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => {
        this.sockets.delete(socket)
      })
    })
  }

  private logListening(): void {
    const baseUrl = `http://localhost:${this.port}`
    console.log(`Config: ${this.loaded.path}`)
    console.log(`WMS listening on ${baseUrl}${this.paths.wms}`)
    console.log(`GetCapabilities: ${baseUrl}${this.paths.wms}?SERVICE=WMS&REQUEST=GetCapabilities`)

    if (this.paths.xyz && this.loaded.xyz) {
      console.log(`XYZ listening on ${baseUrl}${this.paths.xyz}`)

      const sampleLayer = this.loaded.xyz.layers[0]?.name
      if (sampleLayer) {
        console.log(`Sample tile: ${baseUrl}${this.paths.xyz}/${encodeURIComponent(sampleLayer)}/1/1/1.png`)
        console.log(`Retina sample: ${baseUrl}${this.paths.xyz}/${encodeURIComponent(sampleLayer)}/1/1/1@2x.png`)
      }
    }
  }

  private shutdown(signal: string): void {
    if (this.shuttingDown) {
      this.destroySockets()
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

  private async openServices(): Promise<void> {
    for (const service of this.services) {
      await service.open()
    }
  }

  private async closeServices(): Promise<void> {
    for (const service of [...this.services].reverse()) {
      await service.close()
    }
  }

  private destroySockets(): void {
    for (const socket of this.sockets) {
      socket.destroy()
    }
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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  headOnly = false
): void {
  if (res.headersSent) {
    res.end()
    return
  }

  res.statusCode = statusCode
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(headOnly ? undefined : body)
}

if (isMain()) {
  const geo = await GeoComposer.fromEnv()
  geo.trapSignals()
  await geo.start()
}

function isMain(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
}
