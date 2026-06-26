import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Feature, SourceRef } from '../src/core/feature.js'
import type { BBox } from '../src/core/geometry.js'
import type { Layer } from '../src/layer/layer.js'
import { GeoComposer } from '../src/geo-composer.js'
import { Source, type StreamOptions } from '../src/source/source.js'
import { Service } from '../src/service/service.js'
import { testTempPath } from './test-temp.js'
import { config_base, config_full_path, config_min, init, writeConf } from './test-tools.js'

describe('GeoComposer', () => {
    beforeEach(() => {
        init()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        process.removeAllListeners('SIGINT')
        process.removeAllListeners('SIGTERM')
        delete process.env.CONFIG
        delete process.env.PORT
        GeoComposer.clear()
    })

    test('Start GeoComposer from minimal config', async () => {
        const configPath = writeConf('config_min_start.json', config_min)
        await expect(GeoComposer.from({ configPath })).resolves.toBeInstanceOf(GeoComposer)
    })

    test('Start GeoComposer from base config', async () => {
        const configPath = writeConf('config_base_start.json', config_base)
        await expect(GeoComposer.from({ configPath })).resolves.toBeInstanceOf(GeoComposer)
    })

    test('Start GeoComposer from full config', async () => {
        await expect(GeoComposer.from({ configPath: config_full_path })).resolves.toBeInstanceOf(GeoComposer)
    })

    test('loads from environment config and clears declared service caches when requested', async () => {
        process.env.CONFIG = writeConf('config_env_start.json', config_min)

        const app = await GeoComposer.from({ clearTileCache: true })

        expect(app).toBeInstanceOf(GeoComposer)
    })

    test('loads the default config path and applies PORT from the environment', async () => {
        process.env.PORT = '1'

        const app = await GeoComposer.from()

        expect(app.port).toBe(1)
    })

    test('launch reports runtime and initialisation failures without throwing', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const run = vi.fn().mockResolvedValue(undefined)

        vi.spyOn(GeoComposer, 'from').mockResolvedValueOnce({
            run
        } as unknown as GeoComposer)

        await GeoComposer.launch({ configPath: 'config.json', clearTileCache: false })

        expect(run).toHaveBeenCalled()
        expect(process.exitCode).toBe(0)

        vi.spyOn(GeoComposer, 'from').mockResolvedValueOnce({
            run: vi.fn().mockRejectedValue(new Error('runtime failed'))
        } as unknown as GeoComposer)

        await GeoComposer.launch({ configPath: 'config.json', clearTileCache: false })

        expect(consoleError).toHaveBeenCalledWith('[GeoComposer] Runtime failure runtime failed/undefined')
        expect(process.exitCode).toBe(0)

        vi.spyOn(GeoComposer, 'from').mockRejectedValueOnce(new Error('init failed'))

        await GeoComposer.launch({ configPath: 'config.json', clearTileCache: false })

        expect(consoleError).toHaveBeenCalledWith('[GeoComposer] Runtime failure runtime failed/undefined')
        expect(process.exitCode).toBe(0)
    })

    test('opens sources only once and closes opened sources once', async () => {
        const app = await composerWithSources(new TestSource('a'))
        const source = Source.registry.get('a') as TestSource

        await app.open()
        await app.open()
        await app.close()
        await app.close()

        expect(source.openCalls).toBe(1)
        expect(source.closeCalls).toBe(1)
        expect(Source.registry.all).toHaveLength(0)
    })

    test('closes already opened sources in reverse order when opening fails', async () => {
        const calls: string[] = []
        const sourceA = new TestSource('a', calls)
        const sourceB = new TestSource('b', calls)
        const sourceC = new TestSource('c', calls, new Error('open-c'))
        const app = await composerWithSources(sourceA, sourceB, sourceC)

        await expect(app.open()).rejects.toThrow('open-c')

        expect(calls).toEqual([
            'open-a',
            'open-b',
            'open-c',
            'close-b',
            'close-a'
        ])
    })

    test('preserves opening error when cleanup close also fails', async () => {
        const sourceA = new TestSource('a', undefined, undefined, new Error('close-a'))
        const sourceB = new TestSource('b', undefined, new Error('open-b'))
        const app = await composerWithSources(sourceA, sourceB)

        await expect(app.open()).rejects.toThrow('open-b')
    })

    test('closeSources attempts every source and throws the first close error', async () => {
        const first = new TestSource('a', undefined, undefined, new Error('first'))
        const second = new TestSource('b', undefined, undefined, new Error('second'))
        const app = await composerWithSources()

        await expect(app.closeSources([first, second])).rejects.toThrow('first')

        expect(first.closeCalls).toBe(1)
        expect(second.closeCalls).toBe(1)
    })

    test('runs a server, logs services, routes requests and stops cleanly', async () => {
        const app = await composerWithSources(new TestSource('a'))
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const service = new TestService('/unit')
        Service.registry.set('unit', service)

        await app.run()

        const baseUrl = serverUrl(app)
        const serviceResponse = await fetch(`${baseUrl}/unit`)
        const catalogResponse = await fetch(`${baseUrl}/`)
        const optionsResponse = await fetch(`${baseUrl}/missing`, { method: 'OPTIONS' })
        const missingResponse = await fetch(`${baseUrl}/missing`)
        const missingHeadResponse = await fetch(`${baseUrl}/missing`, { method: 'HEAD' })
        const boomResponse = await fetch(`${baseUrl}/unit?boom=1`, { method: 'HEAD' })
        const stringErrorResponse = await fetch(`${baseUrl}/unit?boom=string`)

        expect(serviceResponse.status).toBe(200)
        expect(await serviceResponse.text()).toBe('unit service')
        expect(catalogResponse.status).toBe(200)
        expect(await catalogResponse.text()).toContain('Catalogue GeoComposer')
        expect(optionsResponse.status).toBe(204)
        expect(missingResponse.status).toBe(404)
        expect(await missingResponse.text()).toBe('Not Found')
        expect(missingHeadResponse.status).toBe(404)
        expect(await missingHeadResponse.text()).toBe('')
        expect(boomResponse.status).toBe(500)
        expect(stringErrorResponse.status).toBe(500)
        expect(await stringErrorResponse.text()).toBe('string boom')
        expect(service.logCalls).toEqual(['http://localhost:0'])
        expect(consoleLog).toHaveBeenCalledWith('[Catalog] landing page: http://localhost:0/')

        const shutdown = vi.spyOn(app as unknown as { shutdown(signal: string): void }, 'shutdown')
            .mockImplementation(() => undefined)

        process.emit('SIGINT')
        process.emit('SIGTERM')

        expect(shutdown).toHaveBeenCalledWith('SIGINT')
        expect(shutdown).toHaveBeenCalledWith('SIGTERM')

        await app.stop('test')

        expect(app.server.listening).toBe(false)
    })

    test('serves static site from config sibling site directory under /site while keeping catalog unchanged', async () => {
        const configName = 'geo-composer-static-site/geo_composer_static_site.json'
        const sitePath = testTempPath('geo-composer-static-site', 'site')
        fs.mkdirSync(sitePath, { recursive: true })
        fs.writeFileSync(path.join(sitePath, 'index.html'), '<!doctype html><title>Static Site</title>')
        fs.writeFileSync(path.join(sitePath, 'index.css'), 'body { color: black; }')

        const app = await composerWithSite(configName)
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

        await app.run()

        const baseUrl = serverUrl(app)
        const catalogResponse = await fetch(`${baseUrl}/`)
        const siteResponse = await fetch(`${baseUrl}/site/`)
        const siteNoSlashResponse = await fetch(`${baseUrl}/site`, { redirect: 'manual' })
        const cssResponse = await fetch(`${baseUrl}/site/index.css`)
        const headResponse = await fetch(`${baseUrl}/site/index.html`, { method: 'HEAD' })
        const traversalResponse = await fetch(`${baseUrl}/site/%2e%2e/geo_composer_static_site.json`)

        expect(catalogResponse.status).toBe(200)
        expect(await catalogResponse.text()).toContain('Catalogue GeoComposer')
        expect(siteResponse.status).toBe(200)
        expect(await siteResponse.text()).toContain('Static Site')
        expect(siteNoSlashResponse.status).toBe(308)
        expect(siteNoSlashResponse.headers.get('location')).toBe('/site/')
        expect(cssResponse.status).toBe(200)
        expect(cssResponse.headers.get('content-type')).toContain('text/css')
        expect(await cssResponse.text()).toBe('body { color: black; }')
        expect(headResponse.status).toBe(200)
        expect(await headResponse.text()).toBe('')
        expect(traversalResponse.status).toBe(404)
        expect(consoleLog).toHaveBeenCalledWith('[Catalog] landing page: http://localhost:0/')
        expect(consoleLog).toHaveBeenCalledWith('[Site] static site: http://localhost:0/site/')

        await app.stop('test')
    })

    test('run closes resources and preserves the run error when startup fails', async () => {
        const app = await composerWithSources(new TestSource('a'))
        const error = new Error('listen failed')
        const close = vi.spyOn(app, 'close')

        vi.spyOn(app.server, 'listen').mockImplementation(() => {
            app.server.emit('error', error)
            return app.server
        })

        await expect(app.run()).rejects.toThrow('listen failed')

        expect(close).toHaveBeenCalled()

        const appWithCloseFailure = await composerWithSources(new TestSource('b'))

        vi.spyOn(appWithCloseFailure.server, 'listen').mockImplementation(() => {
            appWithCloseFailure.server.emit('error', error)
            return appWithCloseFailure.server
        })
        vi.spyOn(appWithCloseFailure, 'close').mockRejectedValue(new Error('close failed'))

        await expect(appWithCloseFailure.run()).rejects.toThrow('listen failed')
    })

    test('handles requests without a url as catalog requests', async () => {
        const app = await composerWithSources()
        const res = new TestResponse()

        await (app as unknown as {
            handle(req: Partial<IncomingMessage>, res: ServerResponse): Promise<void>
        }).handle({ method: 'HEAD' }, res as unknown as ServerResponse)

        expect(res.statusCode).toBe(200)
        expect(res.body).toBeUndefined()
    })

    test('stop returns while already shutting down and clears its state after close errors', async () => {
        const app = await composerWithSources()
        const close = vi.spyOn(app.server, 'close')

        ;(app as unknown as { shuttingDown: boolean }).shuttingDown = true
        await app.stop('test')

        expect(close).not.toHaveBeenCalled()

        ;(app as unknown as { shuttingDown: boolean }).shuttingDown = false
        vi.spyOn(app.server, 'close').mockImplementation((callback?: (error?: Error) => void) => {
            callback?.(new Error('close failed'))
            return app.server
        })

        await expect(app.stop('test')).rejects.toThrow('close failed')
        expect((app as unknown as { shuttingDown: boolean }).shuttingDown).toBe(false)
    })

    test('stop force closes connections when graceful close takes too long', async () => {
        vi.useFakeTimers()
        const app = await composerWithSources()
        let closeCallback: ((error?: Error) => void) | undefined
        const closeAllConnections = vi.spyOn(app.server, 'closeAllConnections')

        vi.spyOn(app.server, 'close').mockImplementation((callback?: (error?: Error) => void) => {
            closeCallback = callback
            return app.server
        })

        const stopping = app.stop('timeout')

        await vi.advanceTimersByTimeAsync(10_000)

        expect(closeAllConnections).toHaveBeenCalled()

        closeCallback?.()
        await stopping
        vi.useRealTimers()
    })

    test('shutdown exits cleanly, reports stop failures and force closes repeated signals', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never))

        const clean = await composerWithSources()
        vi.spyOn(clean, 'stop').mockResolvedValue(undefined)
        ;(clean as unknown as { shutdown(signal: string): void }).shutdown('SIGINT')

        await Promise.resolve()
        await Promise.resolve()

        expect(clean.stop).toHaveBeenCalledWith('SIGINT')
        expect(exit).toHaveBeenCalledWith(0)

        const failing = await composerWithSources()
        const error = new Error('stop failed')
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        vi.spyOn(failing, 'stop').mockRejectedValue(error)
        ;(failing as unknown as { shutdown(signal: string): void }).shutdown('SIGTERM')

        await Promise.resolve()
        await Promise.resolve()

        expect(consoleError).toHaveBeenCalledWith(error)
        expect(exit).toHaveBeenCalledWith(1)

        const repeated = await composerWithSources()
        const closeAllConnections = vi.spyOn(repeated.server, 'closeAllConnections')
        ;(repeated as unknown as { shuttingDown: boolean }).shuttingDown = true
        ;(repeated as unknown as { shutdown(signal: string): void }).shutdown('SIGINT')

        expect(closeAllConnections).toHaveBeenCalled()
        expect(exit).toHaveBeenCalledWith(1)
    })
})

class TestSource extends Source {
    readonly type = 'test'
    readonly storage = 'mem'
    openCalls = 0
    closeCalls = 0

    constructor(
        readonly id: string,
        private readonly calls: string[] = [],
        private readonly openError?: Error,
        private readonly closeError?: Error
    ) {
        super()
    }

    override async open(): Promise<void> {
        this.openCalls += 1
        this.calls.push(`open-${this.id}`)
        if (this.openError) throw this.openError
    }

    override async close(): Promise<void> {
        this.closeCalls += 1
        this.calls.push(`close-${this.id}`)
        if (this.closeError) throw this.closeError
    }

    async getExtent(_layer: Layer): Promise<BBox | null> {
        return null
    }

    stream(_options: StreamOptions): ReadableStream<Feature> {
        return new ReadableStream<Feature>({
            start(controller) {
                controller.close()
            }
        })
    }

    async read(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
        return null
    }
}

class TestService extends Service {
    readonly logCalls: string[] = []

    constructor(path: string) {
        super('unit', 'Unit service', 'Unit service', path)
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.url?.includes('boom=1')) {
            throw new Error('boom')
        }
        if (req.url?.includes('boom=string')) {
            throw 'string boom'
        }

        Service.sendText(res, 200, 'unit service', 'text/plain; charset=utf-8', req.method === 'HEAD')
    }

    logListening(baseUrl: string): void {
        this.logCalls.push(baseUrl)
    }

    protected logHandleParams(_traceId: number, _request: unknown): void {}
}

class TestResponse {
    statusCode = 0
    headersSent = false
    headers = new Map<string, string | number>()
    body: string | undefined

    setHeader(name: string, value: string | number): void {
        this.headers.set(name.toLowerCase(), value)
    }

    end(body?: string): void {
        this.headersSent = true
        this.body = body
    }
}

async function composerWithSources(...sources: TestSource[]): Promise<GeoComposer> {
    init()
    const configPath = writeConf('geo_composer_unit.json', config_min)
    const app = await GeoComposer.from({ configPath, port: 0 })

    GeoComposer.clear()
    for (const source of sources) {
        Source.registry.set(source.id, source)
    }

    return app
}

async function composerWithSite(configName: string): Promise<GeoComposer> {
    init()
    const configPath = writeConf(configName, config_min)
    return GeoComposer.from({ configPath, port: 0 })
}

function serverUrl(app: GeoComposer): string {
    const address = app.server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Expected GeoComposer test server to listen on a TCP address')
    }

    return `http://127.0.0.1:${address.port}`
}
