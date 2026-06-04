import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BBox } from '../core/geometry.js'
import { getMap } from '../ogc/get-map.js'
import { TileCache } from '../tileset/tile-cache.js'
import { getTileMatrixSet } from '../tileset/tile-matrix-set.js'
import { Tileset } from '../tileset/tileset.js'
import { Service } from './service.js'
import { nonNegativeInteger } from '../core/tools.js'

const DEFAULT_MAX_SCALE_FACTOR = 4

export type XyzOptions = {
    path?: string
    tilesets: Tileset[]
    maxScaleFactor?: number
    cache?: string
}

type TileRequest = {
    tileset: Tileset
    z: number
    x: number
    y: number
    bbox: BBox
    width: number
    height: number
    scale: number
}

export class Xyz extends Service {
    private readonly maxScaleFactor: number
    private readonly tilesets: Tileset[]
    private readonly tilesetByName: Map<string, Tileset>
    private readonly cache?: TileCache
    private nextTraceId = 1

    constructor(private readonly options: XyzOptions) {
        super('xyz', options.path ?? '/tiles')

        this.maxScaleFactor = options.maxScaleFactor ?? DEFAULT_MAX_SCALE_FACTOR
        validateXyzOptions(this.maxScaleFactor)

        this.tilesets = options.tilesets
        this.tilesetByName = new Map(this.tilesets.map((tileset) => [tileset.name, tileset]))
        this.cache = options.cache ? new TileCache(options.cache) : undefined
    }

    matches(pathname: string): boolean {
        return pathname === this.path || pathname.startsWith(`${this.path}/`)
    }

    async clearCache(): Promise<void> {
        if (!this.cache) {
            return
        }

        await this.cache.clear()
        console.log(`Cleared tile cache: ${this.options.cache}`)
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const fullUrl = Service.requestUrl(req)
        let tileTrace: { id: number, startedAt: number } | null = null

        try {
            Service.setCorsHeaders(res)

            if (req.method === 'OPTIONS') {
                res.statusCode = 204
                res.end()
                return
            }

            if (req.method !== 'GET' && req.method !== 'HEAD') {
                Service.sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
                return
            }

            const url = new URL(req.url ?? '/', 'http://localhost')
            if (!this.matches(url.pathname)) {
                Service.sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8')
                return
            }

            const traceId = this.nextTraceId
            this.nextTraceId += 1
            const startedAt = Date.now()
            tileTrace = { id: traceId, startedAt }
            logTileStart(traceId, req.method ?? 'GET', fullUrl)

            const tileRequest = this.parseTileRequest(url, {
                path: this.path,
                tilesetByName: this.tilesetByName,
                maxScaleFactor: this.maxScaleFactor
            })
            logTileParams(traceId, tileRequest)

            const cachedImage = this.cache
                ? await this.cache.read(tileCacheKey(tileRequest))
                : null
            const image = cachedImage ?? await getMap({
                layers: tileRequest.tileset.layers,
                styles: tileRequest.tileset.styles,
                bbox: tileRequest.bbox,
                width: tileRequest.width,
                height: tileRequest.height,
                crs: tileRequest.tileset.crs,
                pixelRatio: tileRequest.scale
            })

            if (!cachedImage && this.cache) {
                await this.cache.write(tileCacheKey(tileRequest), image)
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'image/png')
            res.setHeader('Content-Length', image.byteLength)
            if (tileRequest.tileset.cacheControl) {
                res.setHeader('Cache-Control', tileRequest.tileset.cacheControl)
            }

            if (req.method !== 'HEAD') {
                res.end(image)
                logTileDone(traceId, res.statusCode, startedAt, image.byteLength)
                return
            }

            res.end()
            logTileDone(traceId, res.statusCode, startedAt, 0)
        } catch (error) {
            logTileError(tileTrace?.id, fullUrl, tileTrace?.startedAt, error)
            Service.sendText(
                res,
                400,
                error instanceof Error ? error.message : String(error),
                'text/plain; charset=utf-8'
            )
        }
    }
    private parseTileRequest(
        url: URL,
        options: {
            path: string
            tilesetByName: Map<string, Tileset>
            maxScaleFactor: number
        }
    ): TileRequest {
        const segments = pathSegmentsAfter(url.pathname, options.path)
        if (segments.length !== 4) {
            throw new Error(`XYZ tile path must be ${options.path}/{tileset}/{z}/{x}/{y}.png`)
        }

        const tilesetName = decodeURIComponent(segments[0])
        const tileset = options.tilesetByName.get(tilesetName)
        if (!tileset) {
            throw new Error(`Unknown XYZ tileset: ${tilesetName}`)
        }

        const z = nonNegativeInteger(segments[1], 'z')
        const x = nonNegativeInteger(segments[2], 'x')
        const parsedY = parseYSegment(segments[3])
        const y = parsedY.y
        const scale = parseScale(url.searchParams.get('scale'), parsedY.scale, options.maxScaleFactor)

        tileset.validateCoord(z, x, y)

        const pixelSize = Math.round(tileset.tileSize * scale)

        return {
            tileset,
            z,
            x,
            y,
            bbox: getTileMatrixSet('WebMercatorQuad').bbox(z, x, y),
            width: pixelSize,
            height: pixelSize,
            scale
        }
    }


}

function parseYSegment(segment: string): { y: number, scale?: number } {
    const match = segment.match(/^(\d+)(?:@([1-9]\d*)x)?(?:\.png)?$/i)
    if (!match) {
        throw new Error('y must be an integer tile coordinate, optionally ending with .png or @2x.png')
    }

    return {
        y: nonNegativeInteger(match[1], 'y'),
        scale: match[2] ? nonNegativeInteger(match[2], 'scale') : undefined
    }
}

function parseScale(queryValue: string | null, pathValue: number | undefined, maxScaleFactor: number): number {
    const raw = queryValue ?? (pathValue === undefined ? undefined : String(pathValue))
    if (raw === undefined || raw === '') return 1

    const scale = Number(raw)
    if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error('scale must be a positive number')
    }

    if (scale > maxScaleFactor) {
        throw new Error(`scale exceeds maximum value ${maxScaleFactor}`)
    }

    return scale
}

function validateXyzOptions(maxScaleFactor: number): void {
    if (!Number.isFinite(maxScaleFactor) || maxScaleFactor <= 0) {
        throw new Error('XYZ maxScaleFactor must be a positive number')
    }
}



function pathSegmentsAfter(pathname: string, basePath: string): string[] {
    const suffix = pathname.slice(basePath.length)
    return suffix
        .split('/')
        .filter(Boolean)
}

function tileCacheKey(request: TileRequest) {
    return {
        tileset: request.tileset.name,
        z: request.z,
        x: request.x,
        y: request.y,
        scale: request.scale
    }
}

function logTileStart(traceId: number, method: string, url: string): void {
    console.log(`[XYZ ${traceId}] IN  ${method} ${url}`)
}

function logTileDone(traceId: number, statusCode: number, startedAt: number, size: number): void {
    const durationMs = Date.now() - startedAt
    console.log(`[XYZ ${traceId}] OUT ${statusCode} ${durationMs}ms ${size}B`)
}

function logTileParams(traceId: number, request: TileRequest): void {
    console.log(`[XYZ ${traceId}] TILESET=${request.tileset.name} ZXY=${request.z}/${request.x}/${request.y} SIZE=${request.width}x${request.height} SCALE=${request.scale}`)
    console.log(`[XYZ ${traceId}] BBOX=${request.bbox.join(',')}`)
}

function logTileError(traceId: number | undefined, url: string, startedAt: number | undefined, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const duration = startedAt === undefined ? '' : ` ${Date.now() - startedAt}ms`
    const prefix = traceId === undefined ? '[XYZ]' : `[XYZ ${traceId}]`
    console.error(`${prefix} ERR${duration} ${url}`)
    console.error(`${prefix} ERR ${message}`)
}
