import type { IncomingMessage, ServerResponse } from 'node:http'
import { TLSSocket } from 'node:tls'
import { TileCache } from '../tileset/tile-cache.js'
import { Registry } from '../core/tools.js'
import { RegistryEntry } from '../core/feature.js'
import type { OgcFeaturesJson } from './ogc-features.js'
import type { WmsJson } from './wms.js'
import type { WmtsJson } from './wmts.js'
import type { XyzJson } from './xyz.js'

export type ServicesJson = {
    wms?: WmsJson
    api?: OgcFeaturesJson
    xyz?: XyzJson
    wmts?: WmtsJson
}

export abstract class Service extends RegistryEntry {
    static readonly registry = new Registry<Service>('SERVICES')

    readonly path: string
    readonly onlineResource?: string
    protected readonly  cache?: TileCache

    protected constructor(
        id: string,
        title = `${id.toUpperCase()} service`,
        abstract = `${id.toUpperCase()} map service`,
        path: string,
        onlineResource?: string,
        cache?: string
    ) {
        super(id, { title, abstract })
        this.path = this.normalize(path)
        this.onlineResource = onlineResource
        this.cache = cache ? new TileCache(cache) : undefined

    }

    static build(
        services: unknown,
    ): Registry<Service> {
        throw new Error('Service.build is not initialized')
    }

    async clearCache() {
        return this.cache?.clear().finally(() => console.log(`[${this.logId}]: Cache cleared`))
    }
    matches(pathname: string): boolean {
        return pathname === this.path
    }
    abstract handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    abstract logListening(baseUrl:string): void
    protected abstract logHandleParams(traceId: number, request: any ): void 

    protected logHandleStart(traceId: number, method: string, url: string): void {
        console.log(`[${this.logId} ${traceId}] IN  ${method} ${url}`)
    }
    protected logHandleError(traceId: number, url: string, startedAt: number | undefined, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        const duration = startedAt == null ? '' : ` ${Date.now() - startedAt}ms`
        const prefix = traceId == null ? `[${this.logId}]` : `[${this.logId} ${traceId}]`
        console.error(`${prefix} ERROR ${duration} ${url} ${message}`)
    }
    protected logHandleDone(traceId: number, statusCode: number, startedAt: number, size: number): void {
        const durationMs = Date.now() - startedAt
        console.log(`[${this.logId}  ${traceId}] OUT ${statusCode} ${durationMs}ms ${size}B`)
    }

    protected get logId(): string {
        return this.id.toUpperCase()
    }

    static setCorsHeaders(res: ServerResponse): void {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
    }

    static sendText(res: ServerResponse, statusCode: number, body: string, contentType: string, headOnly = false): void {
        if (res.headersSent) {
            res.end()
            return
        }

        res.statusCode = statusCode
        res.setHeader('Content-Type', contentType)
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(headOnly ? undefined : body)
    }

    static requestUrl(req: IncomingMessage): string {
        return new URL(req.url ?? '/', this.requestBaseUrl(req)).toString()
    }

    static serviceUrl(req: IncomingMessage, path: string): string {
        return new URL(path, this.requestBaseUrl(req)).toString()
    }

    private static requestBaseUrl(req: IncomingMessage): string {
        const socketProtocol = req.socket instanceof TLSSocket && req.socket.encrypted
            ? 'https'
            : 'http'
        const forwardedProtocol = req.headers['x-forwarded-proto']
        const protocol = Array.isArray(forwardedProtocol)
            ? forwardedProtocol[0] ?? socketProtocol
            : forwardedProtocol ?? socketProtocol
        const host = req.headers.host ?? 'localhost'

        return `${protocol}://${host}`
    }

    protected require(params: Map<string, string>, name: string, missingMessage = `${name} is required`): string {
        const value = params.get(name)
        if (value === undefined || value === '') {
            throw new Error(missingMessage)
        }

        return value
    }
    private normalize(path: string): string {
        const normalized = path.startsWith('/') ? path : `/${path}`
        return normalized.length > 1 && normalized.endsWith('/')
            ? normalized.slice(0, -1)
            : normalized
    }

}
