import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer,type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { Config } from './config/config.js'
import { Service } from './service/service.js'
import { parsePort } from './core/tools.js'

type Args = {
    configPath: string
    clearTileCache: boolean
    port?: number
}

export class GeoComposer {
    readonly server: Server

    private shuttingDown = false

    private constructor(
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

    static async from(args: Partial<Args> = {}): Promise<GeoComposer> {
        const configPath = path.resolve(process.cwd(), args.configPath ?? process.env.CONFIG ?? 'config.json')
        const config = await Config.load(configPath)
        const port = args.port ?? parsePort(process.env.PORT, config.server.port) ?? config.server.port

        if (args.clearTileCache) {
            await config.xyzService?.clearCache()
            await config.wmtsService?.clearCache()
        }

        return new GeoComposer(config, port)
    }

    async start(): Promise<void> {
        process.once('SIGINT', () =>  this.shutdown('SIGINT'))
        process.once('SIGTERM', () =>  this.shutdown('SIGTERM'))

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
        if (this.shuttingDown)  return

        this.shuttingDown = true
        console.log(`Stopping GeoComposer server (${signal})...`)

        const forceClose = setTimeout(() =>  this.server.closeAllConnections?.(), 10_000)

        try {
            await new Promise<void>((resolve, reject) => {
                this.server.close((error?: Error) => {
                    return error ? reject(error) : resolve()
                })
                this.server.closeIdleConnections?.()
            })

            await this.config.close()
        } finally {
            clearTimeout(forceClose)
            this.shuttingDown = false
        }
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

        this.stop(signal).then(
            () => process.exit(0) ,
            (error: unknown) => {
                console.error(error)
                process.exit(1)
            }
        )
    }

}

function parseArgs(): Args {
    const args = process.argv.slice(2)
    const options: Args = {
        configPath: path.resolve(process.cwd(), process.env.CONFIG ?? 'config.json'),
        clearTileCache: false
    }

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]

        if (arg === '--clear-tile-cache' || arg === '-cc') {
            options.clearTileCache = true
            continue
        }

        if (arg === '--port' || arg === '-p') {
            const value = args[index + 1]
            if (!value || value.startsWith('-')) {
                throw new Error(`${arg} requires a port number`)
            }

            options.port = parsePort(value,undefined)
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


if (isMain()) {
    const args = parseArgs()
    const geo = await GeoComposer.from(args)
    await geo.start()
}

function isMain(): boolean {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
}
