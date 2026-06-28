import './core/log-level.js'
import path from 'node:path'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { ARGS_HELP, Args, DEFAULT_CONFIG_PATH, isMain, parseArgs, parsePort } from './core/tools.js'
import { Config } from './config/config.js'
import { Indexer } from './index/file-indexer.js'
import { Service } from './service/service.js'
import { FileSource, Source } from './source/source.js'
import { Layer } from './layer/layer.js'
import { Crs } from './core/crs.js'
import { Style } from './style/style.js'
import { Tileset } from './tileset/tileset.js'
import { TileMatrixSet } from './tileset/tile-matrix-set.js'
import { CatalogPage } from './service/catalog-page.js'
import { StaticSite } from './service/static-site.js'


export class GeoComposer {
    readonly port: number
    readonly server: Server
    private readonly catalogPage = new CatalogPage()
    private readonly staticSite?: StaticSite
    private shuttingDown = false
    private opened = false
    
    private constructor(config: Config) {
        this.port = config.port
        this.staticSite = config.site ? new StaticSite(config.site) : undefined

        this.server = createServer((req, res) => {
            this.handle(req, res).catch((error) => {
                const message = error instanceof Error ? error.message : String(error)
                Service.sendText(res, 500, message, 'text/plain; charset=utf-8', req.method === 'HEAD')
            })
        })

    }

    static async from(args: Partial<Args> = {}): Promise<GeoComposer> {
        const configPath = path.resolve(process.cwd(), args.configPath ?? process.env.CONFIG ?? DEFAULT_CONFIG_PATH)
        const port = parsePort(process.env.PORT, args.port)
        const config = await Config.load(configPath, port)

        if (args.clearTileCache) {
            await Promise.all(Service.registry.all.map(service => service.clearCache()))
        }

        return new GeoComposer(config)
    }

    static async launch(args = parseArgs()) {
        if (args.help) {
            console.log(ARGS_HELP)
            process.exitCode = 0
            return
        }

        try {
            // Init GeoComposer from Conf
            const geoc = await GeoComposer.from(args)

            if (args.buildIndexAll || args.buildIndexForce || args.buildIndexSources?.length) {
                const result = await geoc.buildIndexes(args.buildIndexAll || !args.buildIndexSources?.length ? undefined : args.buildIndexSources, args.buildIndexForce)
                GeoComposer.logBuildIndexResult(result)
                process.exitCode = result.failed === 0 ? 0 : 1
                return
            }

            try {
                // Run server and handle requests
                await geoc.run()
            } catch (error) {
                // runtime error caught
                if (error instanceof Error) {
                    console.error(`[GeoComposer] Runtime failure ${error.message}/${error.cause}`)
                        if (error instanceof AggregateError) {
                            error.errors.forEach((err, i) => console.error(`- Error ${i + 1}: ${err}`))
                        }
                } else {
                    console.error(`[GeoComposer] Runtime failure ${ error }`)
                }
            }
        } catch (error) {
            // Initialisation error caught
            process.exitCode = 1
            console.error(`[GeoComposer] Initialisation failure`)
            console.error(String(error))
            return
        }
        process.exitCode = 0
    }

    async open(): Promise<void> {
        if (this.opened) return

        const openedSources: Source[] = []

        try {
            for (const source of Source.registry.all) {
                await source.open()
                openedSources.push(source)
            }

            await this.loadIndexes()
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
            await this.closeSources(Source.registry.all.reverse())
        } finally {
            GeoComposer.clear()
            this.opened = false
        }
    }

    static clear() {
        Service.registry.clear()
        Source.registry.clear()
        Layer.registry.clear()
        Crs.registry.clear()
        Style.registry.clear()
        TileMatrixSet.build({})
        Tileset.registry.clear()
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

    private async loadIndexes(): Promise<void> {
        const layerBySource = new Map<string, Layer>()
        for (const layer of Layer.registry.all) {
            if (!layerBySource.has(layer.source.id)) layerBySource.set(layer.source.id, layer)
        }

        for (const source of Source.registry.all) {
            if (!source.indexes || !(source instanceof FileSource)) continue

            const layer = layerBySource.get(source.id)
            if (!layer) {
                throw new Error(`Source "${source.id}" expects indexes but has no layer`)
            }

            await new Indexer(layer).load()
        }
    }

    async buildIndexes(sourceIds?: readonly string[], force = false): Promise<BuildIndexResult> {
        const result: BuildIndexResult = {
            created: 0,
            rebuilt: 0,
            skipped: 0,
            failed: 0,
            items: []
        }

        try {
            const layerBySource = new Map<string, Layer>()
            for (const layer of Layer.registry.all) {
                if (!layerBySource.has(layer.source.id)) layerBySource.set(layer.source.id, layer)
            }

            const sources = sourceIds
                ? [...new Set(sourceIds)].map((sourceId) => {
                    try {
                        return Source.registry.get(sourceId)
                    } catch (error) {
                        result.failed += 1
                        result.items.push({
                            status: 'failed',
                            layer: '-',
                            source: sourceId,
                            message: error instanceof Error ? error.message : String(error)
                        })
                        return null
                    }
                }).filter((source): source is Source => source !== null)
                : Source.registry.all.filter((source) => source.indexes)

            for (const source of sources) {
                const layer = layerBySource.get(source.id)

                if (!source.indexes) {
                    result.skipped += 1
                    result.items.push({
                        status: 'skipped',
                        layer: layer?.id ?? '-',
                        source: source.id,
                        message: 'source has no indexes configured'
                    })
                    continue
                }

                if (!layer) {
                    result.failed += 1
                    result.items.push({
                        status: 'failed',
                        layer: '-',
                        source: source.id,
                        message: 'source has no layer'
                    })
                    continue
                }

                if (!(source instanceof FileSource)) {
                    result.skipped += 1
                    result.items.push({
                        status: 'skipped',
                        layer: layer.id,
                        source: source.id,
                        message: 'source is not a FileSource'
                    })
                    continue
                }

                try {
                    const buildState = await Indexer.needsBuild(layer)
                    if (!force && buildState === 'up-to-date') {
                        result.skipped += 1
                        result.items.push({
                            status: 'skipped',
                            layer: layer.id,
                            source: source.id,
                            path: Indexer.resolveIndexPath(layer),
                            message: 'index is up-to-date'
                        })
                        continue
                    }

                    await source.open()
                    try {
                        const index = await new Indexer(layer).build()
                        const status = buildState === 'missing' ? 'created' : 'rebuilt'
                        result[status] += 1
                        result.items.push({
                            status,
                            layer: layer.id,
                            source: source.id,
                            path: index.path,
                            message: `${index.recordCount} records`
                        })
                    } finally {
                        await source.close()
                    }
                } catch (error) {
                    result.failed += 1
                    result.items.push({
                        status: 'failed',
                        layer: layer.id,
                        source: source.id,
                        message: error instanceof Error ? error.message : String(error)
                    })
                }
            }
        } finally {
            GeoComposer.clear()
        }

        return result
    }

    private static logBuildIndexResult(result: BuildIndexResult): void {
        console.log(`[GeoComposer] Build index: ${result.created} created, ${result.rebuilt} rebuilt, ${result.skipped} skipped, ${result.failed} failed`)

        for (const item of result.items) {
            const suffix = item.path ? ` ${item.path}` : ''
            console.log(`[GeoComposer] ${item.status} layer=${item.layer} source=${item.source}${suffix}: ${item.message}`)
        }
    }


    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const service = Service.registry.all.find((entry) => entry.matches(url.pathname))

        if (service) {
            await service.handle(req, res)
            return
        }

        if (this.staticSite?.matches(url.pathname)) {
            await this.staticSite.handle(req, res)
            return
        }

        if (this.catalogPage.matches(url.pathname)) {
            await this.catalogPage.handle(req, res)
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
        console.log(`[Catalog] landing page: ${baseUrl}/`)
        if (this.staticSite) {
            console.log(`[Site] static site: ${baseUrl}/site/`)
        }
        Service.registry.all.forEach(
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


}

export type BuildIndexItem = {
    status: 'created' | 'rebuilt' | 'skipped' | 'failed'
    layer: string
    source: string
    path?: string
    message: string
}

export type BuildIndexResult = {
    created: number
    rebuilt: number
    skipped: number
    failed: number
    items: BuildIndexItem[]
}

/* v8 ignore next 3 -- CLI entrypoint is exercised by running the built command, not by importing this module in unit tests. */
if (isMain(import.meta.url)) {
    await GeoComposer.launch()
}
