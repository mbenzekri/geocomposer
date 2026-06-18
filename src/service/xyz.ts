import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BBox } from '../core/geometry.js'
import { getMap } from '../ogc/get-map.js'
import { type TileOutput, Tileset, tileFormatFromExtension } from '../tileset/tileset.js'
import { getVectorTile } from '../tileset/vector-tile.js'
import { Service } from './service.js'
import { nonNegativeInteger } from '../core/tools.js'
import { DescInfo, ServiceInfo } from '../core/feature.js'

const DEFAULT_MAX_SCALE_FACTOR = 4

export type XyzJson = DescInfo & ServiceInfo & {
    maxScaleFactor?: number
    cache?: string
    tilesets?: string[]
}

type TileRequest = {
    tileset: Tileset
    output: TileOutput
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
    readonly tilesets: Tileset[]
    private readonly tilesetByName: Map<string, Tileset>
    private nextTraceId = 1

    constructor(options: XyzJson) {
        super('xyz', options.title, options.abstract, options.path ?? '/xyz',options.onlineResource,options.cache)

        this.maxScaleFactor = options.maxScaleFactor ?? DEFAULT_MAX_SCALE_FACTOR
        validateXyzOptions(this.maxScaleFactor)

        this.tilesets = Tileset.select(options.tilesets, 'XYZ')
        this.tilesetByName = new Map(this.tilesets.map((tileset) => [tileset.name, tileset]))
    }

    static fromConfig(entry: XyzJson): Xyz {
        return new Xyz(entry)
    }

    matches(pathname: string): boolean {
        return pathname === this.path || pathname.startsWith(`${this.path}/`)
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const fullUrl = Service.requestUrl(req)
        let tileTrace: { id: number, startedAt: number } | null = null

        const traceId = this.nextTraceId
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

            this.nextTraceId += 1
            const startedAt = Date.now()
            tileTrace = { id: traceId, startedAt }
            this.logHandleStart(traceId, req.method ?? 'GET', fullUrl)

            const tileRequest = this.parseTileRequest(url, {
                path: this.path,
                tilesetByName: this.tilesetByName,
                maxScaleFactor: this.maxScaleFactor
            })
            this.logHandleParams(traceId, tileRequest)

            const cachedTile = this.cache
                ? await this.cache.read(tileCacheKey(tileRequest))
                : null
            const tile = cachedTile ?? await renderTile(tileRequest)

            if (!cachedTile && this.cache) {
                await this.cache.write(tileCacheKey(tileRequest), tile)
            }

            res.statusCode = 200
            res.setHeader('Content-Type', tileRequest.output.format)
            res.setHeader('Content-Length', tile.byteLength)
            if (tileRequest.tileset.cacheControl) {
                res.setHeader('Cache-Control', tileRequest.tileset.cacheControl)
            }

            if (req.method !== 'HEAD') {
                res.end(tile)
                this.logHandleDone(traceId, res.statusCode, startedAt, tile.byteLength)
                return
            } else {
                res.end()
                this.logHandleDone(traceId, res.statusCode, startedAt, 0)
            }

        } catch (error) {
            this.logHandleError(traceId, fullUrl, tileTrace?.startedAt, error)
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
            throw new Error(`XYZ tile path must be ${options.path}/{tileset}/{z}/{x}/{y}.{png|geojson|pbf}`)
        }

        const tilesetName = decodeURIComponent(segments[0])
        const tileset = options.tilesetByName.get(tilesetName)
        if (!tileset) {
            throw new Error(`Unknown XYZ tileset: ${tilesetName}`)
        }

        const z = nonNegativeInteger(segments[1], 'z')
        const x = nonNegativeInteger(segments[2], 'x')
        const parsedY = parseYSegment(segments[3])
        const output = tileset.resolveOutput(parsedY.format)
        const y = parsedY.y
        const scale = parseScale(url.searchParams.get('scale'), parsedY.scale, options.maxScaleFactor)
        if (output.vector && scale !== 1) {
            throw new Error('Vector XYZ tiles do not support scale or @2x requests')
        }

        tileset.validateCoord(z, x, y)

        const pixelSize = Math.round(tileset.tileSize * scale)

        return {
            tileset,
            output,
            z,
            x,
            y,
            bbox: tileset.bbox(z, x, y),
            width: pixelSize,
            height: pixelSize,
            scale
        }
    }

    logListening(baseUrl: string): void {
        console.log(`[XYZ] listening on: ${baseUrl}${this.path}`)
        const sampleTileset = this.tilesets[0]?.name
        if (sampleTileset) {
            console.log(`[XYZ] Get Tile: ${baseUrl}${this.path}/${encodeURIComponent(sampleTileset)}/1/1/1.png`)
            console.log(`[XYZ] Get Tile (Retina): ${baseUrl}${this.path}/${encodeURIComponent(sampleTileset)}/1/1/1@2x.png`)
        }
    }

    protected logHandleParams(traceId: number, request: TileRequest): void {
        console.debug(`[XYZ ${traceId}] TILESET=${request.tileset.name} FORMAT=${request.output.format} ZXY=${request.z}/${request.x}/${request.y} SIZE=${request.width}x${request.height} SCALE=${request.scale} BBOX=${request.bbox.join(',')}`)
    }

}

function parseYSegment(segment: string): { y: number, scale?: number, format?: string } {
    const match = segment.match(/^(\d+)(?:@([1-9]\d*)x)?(?:\.(png|geojson|json|pbf|mvt))?$/i)
    if (!match) {
        throw new Error('y must be an integer tile coordinate, optionally ending with .png, .geojson, .json, .pbf or .mvt')
    }

    return {
        y: nonNegativeInteger(match[1], 'y'),
        scale: match[2] ? nonNegativeInteger(match[2], 'scale') : undefined,
        format: match[3] ? tileFormatFromExtension(match[3]) : undefined
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
        scale: request.scale,
        extension: request.output.extension
    }
}

async function renderTile(request: TileRequest): Promise<Buffer> {
    if (!request.output.vector) {
        return getMap({
            layers: request.tileset.layers,
            styles: request.tileset.resolveStyles(),
            bbox: request.bbox,
            width: request.width,
            height: request.height,
            crs: request.tileset.crs,
            pixelRatio: request.scale
        })
    }

    return getVectorTile({
        layers: request.tileset.layers,
        bbox: request.bbox,
        crs: request.tileset.crs,
        tileSize: request.tileset.tileSize,
        format: request.output.format,
        vector: request.tileset.vector
    })
}
