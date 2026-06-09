import './core/log-level.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { Args, parseArgs, parsePort, Registry } from './core/tools.js'
import { Config } from './config/config.js'
import { Service } from './service/service.js'
import { Source } from './source/source.js'
import { Layer, NamedStyle } from './layer/layer.js'
import { CrsCode } from './core/geometry.js'
import { Tileset } from './tileset/tileset.js'


export class GeoComposer {
    readonly port: number
    readonly server: Server
    readonly serviceReg: Registry<Service>
    readonly sourceReg: Registry<Source>
    readonly layerReg: Registry<Layer>
    readonly styleReg: Registry<NamedStyle>
    readonly crsReg: Registry<CrsCode>
    readonly tilesetReg: Registry<Tileset>
    private shuttingDown = false
    private opened = false

    private constructor(config: Config) {
        this.port = config.port
        this.serviceReg = config.serviceReg
        this.sourceReg = config.sourceReg
        this.layerReg = config.layerReg
        this.styleReg = config.styleReg
        this.crsReg = config.crsReg
        this.tilesetReg = config.tilesetReg

        this.server = createServer((req, res) => {
            this.handle(req, res).catch((error) => {
                const message = error instanceof Error ? error.message : String(error)
                Service.sendText(res, 500, message, 'text/plain; charset=utf-8', req.method === 'HEAD')
            })
        })

    }

    static async from(args: Partial<Args> = {}): Promise<GeoComposer> {
        const configPath = path.resolve(process.cwd(), args.configPath ?? process.env.CONFIG ?? 'config.json')
        const port = parsePort(process.env.PORT, args.port)
        const config = await Config.load(configPath,port)

        if (args.clearTileCache) {
            await Promise.all(config.serviceReg.all.map(service => service.clearCache()))
        }

        return new GeoComposer(config)
    }

    async open(): Promise<void> {
        if (this.opened) return

        const openedSources: Source[] = []

        try {
            for (const source of this.sourceReg.all) {
                await source.open()
                openedSources.push(source)
            }

            this.opened = true
        } catch (error) {
            try {
                await this.closeSources([...openedSources].reverse())
            } catch {
                // Preserve the startup error; cleanup errors are secondary here.
            }
            throw error
        }
    }

    async close(): Promise<void> {
        if (!this.opened) return

        try {
            await this.closeSources(this.sourceReg.all.reverse())
        } finally {
            this.opened = false
        }
    }
    async run(): Promise<void> {
        process.once('SIGINT', () => this.shutdown('SIGINT'))
        process.once('SIGTERM', () => this.shutdown('SIGTERM'))

        try {
            await this.open()
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
                await this.close()
            } catch {
                // Preserve the startup error; cleanup errors are secondary here.
            }
            throw error
        }
    }

    async stop(signal = 'manual'): Promise<void> {
        if (this.shuttingDown) return

        this.shuttingDown = true
        console.log(`[GeoComposer] Stopping  server (${signal})...`)

        const forceClose = setTimeout(() => this.server.closeAllConnections?.(), 10_000)

        try {
            await new Promise<void>((resolve, reject) => {
                this.server.close((error?: Error) => {
                    return error ? reject(error) : resolve()
                })
                this.server.closeIdleConnections?.()
            })

            await this.close()
        } finally {
            clearTimeout(forceClose)
            this.shuttingDown = false
        }
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const service = this.serviceReg.all.find((entry) => entry.matches(url.pathname))

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
        this.serviceReg.all.forEach(
            service => service.logListening(baseUrl)
        )
    }

    private shutdown(signal: string): void {
        if (this.shuttingDown) {
            this.server.closeAllConnections?.()
            process.exit(1)
        }

        this.stop(signal).then(
            () => process.exit(0),
            (error: unknown) => {
                console.error(error)
                process.exit(1)
            }
        )
    }

    async closeSources(sources: Iterable<Source>): Promise<void> {
        let firstError: unknown

        for (const source of sources) {
            try {
                await source.close()
            } catch (error) {
                firstError ??= error
            }
        }

        if (firstError) throw firstError
    }

}



if (isMain()) {
    const args = parseArgs()
    let geoc: GeoComposer
    try {
        // Init GeoComposer from Conf
        geoc = await GeoComposer.from(args)
        try {
            // Run server and handle requests
            await geoc.run()
        } catch (error) {
            // runtime error caught
            console.error(`[GeoComposer] Runtime failure`)
            console.error(String(error))
        }
    } catch (error) {
        // Initialisation error caught
        process.exitCode = 1
        console.error(`[GeoComposer] Initialisation failure`)
        console.error(String(error))
    }
    process.exitCode = 0
}

function isMain(): boolean {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
}
