import type { IncomingMessage, ServerResponse } from 'node:http'
import { TLSSocket } from 'node:tls'
import { TileCache } from '../tileset/tile-cache.js'

export abstract class Service {
    readonly name: string
    readonly path: string
    readonly title: string
    readonly abstract: string
    readonly onlineResource?: string
    protected readonly  cache?: TileCache

    protected constructor(
        name: string,
        title = `${name} WMS`,
        abstract = `OGC ${name} WMS service`,
        path: string,
        onlineResource?: string,
        cache?: string
    ) {
        this.name = name
        this.path = this.normalize(path)
        this.title = title
        this.abstract = abstract
        this.onlineResource = onlineResource
        this.cache = cache ? new TileCache(cache) : undefined

    }
    async clearCache() {
        return this.cache?.clear().finally(() => console.log(`Service[${this.name}]: Cache cleared`))
    }
    matches(pathname: string): boolean {
        return pathname === this.path
    }

    abstract handle(req: IncomingMessage, res: ServerResponse): Promise<void>

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

