import type { IncomingMessage, ServerResponse } from 'node:http'
import { escape, nonNegativeInteger, paramsFromUrl } from '../core/tools.js'
import { MarkupTemplate } from '../core/template.js'
import { getMap } from '../ogc/get-map.js'
import { TileCache } from '../tileset/tile-cache.js'
import type { TileMatrixSet } from '../tileset/tile-matrix-set.js'
import type { Tileset } from '../tileset/tileset.js'
import { Service } from './service.js'

const WMTS_VERSION = '1.0.0'

export type WmtsInfo = {
    title: string
    abstract?: string
    onlineResource?: string
}

export type WmtsOptions = {
    path?: string
    info: WmtsInfo
    tilesets: Tileset[]
    cache?: string
}

type WmtsTileRequest = {
    tileset: Tileset
    z: number
    x: number
    y: number
}

type MatrixSetUse = {
    tileMatrixSet: TileMatrixSet
    tileSize: number
    minZoom: number
    maxZoom: number
}

const WMTS_CAPABILITIES_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0"
  xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/wmts/1.0 http://schemas.opengis.net/wmts/1.0/wmtsGetCapabilities_response.xsd"
  version="{{version}}">
  <ows:ServiceIdentification>
    <ows:Title>{{info.title}}</ows:Title>
    {{#info.abstract}}<ows:Abstract>{{info.abstract}}</ows:Abstract>{{/info.abstract}}
    <ows:ServiceType>OGC WMTS</ows:ServiceType>
    <ows:ServiceTypeVersion>{{version}}</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <ows:OperationsMetadata>
    {{#operations}}
    <ows:Operation name="{{name}}">
      <ows:DCP>
        <ows:HTTP>
          <ows:Get xlink:href="{{serviceUrl}}"/>
        </ows:HTTP>
      </ows:DCP>
    </ows:Operation>
    {{/operations}}
  </ows:OperationsMetadata>
  <Contents>
    {{#layers}}
    <Layer>
      <ows:Title>{{title}}</ows:Title>
      {{#summary}}<ows:Abstract>{{summary}}</ows:Abstract>{{/summary}}
      <ows:Identifier>{{name}}</ows:Identifier>
      <Style isDefault="true">
        <ows:Identifier>default</ows:Identifier>
      </Style>
      <Format>{{format}}</Format>
      <TileMatrixSetLink>
        <TileMatrixSet>{{tileMatrixSet}}</TileMatrixSet>
        <TileMatrixSetLimits>
          {{#limits}}
          <TileMatrixLimits>
            <TileMatrix>{{tileMatrix}}</TileMatrix>
            <MinTileRow>{{minTileRow}}</MinTileRow>
            <MaxTileRow>{{maxTileRow}}</MaxTileRow>
            <MinTileCol>{{minTileCol}}</MinTileCol>
            <MaxTileCol>{{maxTileCol}}</MaxTileCol>
          </TileMatrixLimits>
          {{/limits}}
        </TileMatrixSetLimits>
      </TileMatrixSetLink>
      <ResourceURL format="{{format}}" resourceType="tile" template="{{resourceTemplate}}"/>
    </Layer>
    {{/layers}}
    {{#matrixSets}}
    <TileMatrixSet>
      <ows:Title>{{title}}</ows:Title>
      <ows:Identifier>{{id}}</ows:Identifier>
      <ows:SupportedCRS>{{supportedCrs}}</ows:SupportedCRS>
      {{#matrices}}
      <TileMatrix>
        <ows:Identifier>{{id}}</ows:Identifier>
        <ScaleDenominator>{{scaleDenominator}}</ScaleDenominator>
        <TopLeftCorner>{{topLeftCorner}}</TopLeftCorner>
        <TileWidth>{{tileWidth}}</TileWidth>
        <TileHeight>{{tileHeight}}</TileHeight>
        <MatrixWidth>{{matrixWidth}}</MatrixWidth>
        <MatrixHeight>{{matrixHeight}}</MatrixHeight>
      </TileMatrix>
      {{/matrices}}
    </TileMatrixSet>
    {{/matrixSets}}
  </Contents>
  <ServiceMetadataURL xlink:href="{{onlineResource}}"/>
</Capabilities>`

export class Wmts extends Service {
    private readonly tilesetByName: Map<string, Tileset>
    private readonly cache?: TileCache
    private nextTraceId = 1

    constructor(private readonly options: WmtsOptions) {
        super('wmts', options.path ?? '/wmts')

        this.tilesetByName = new Map(options.tilesets.map((tileset) => [tileset.name, tileset]))
        this.cache = options.cache ? new TileCache(options.cache) : undefined
        validateWmtsTilesets(options.tilesets)
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

            const params = paramsFromUrl(url)
            const service = params.get('SERVICE')
            if (service && service.toUpperCase() !== 'WMTS') {
                sendWmtsError(res, 'InvalidParameterValue', 'SERVICE must be WMTS')
                return
            }

            const request = (params.get('REQUEST') ?? 'GetCapabilities').toUpperCase()
            if (request === 'GETCAPABILITIES') {
                const xml = WmtsCapabilitiesBuilder.build(this.options.info, this.options.tilesets, Service.serviceUrl(req, this.path))
                Service.sendText(res, 200, xml, 'text/xml; charset=utf-8', req.method === 'HEAD')
                return
            }

            if (request === 'GETTILE') {
                const traceId = this.nextTraceId
                this.nextTraceId += 1
                const startedAt = Date.now()
                tileTrace = { id: traceId, startedAt }
                logTileStart(traceId, req.method ?? 'GET', fullUrl)

                const tileRequest = this.parseGetTile(params, this.tilesetByName)
                logTileParams(traceId, tileRequest)

                const cacheKey = {
                    tileset: tileRequest.tileset.name,
                    z: tileRequest.z,
                    x: tileRequest.x,
                    y: tileRequest.y
                }
                const cachedImage = this.cache ? await this.cache.read(cacheKey) : null
                const image = cachedImage ?? await getMap({
                    layers: tileRequest.tileset.layers,
                    styles: tileRequest.tileset.styles,
                    bbox: tileRequest.tileset.bbox(tileRequest.z, tileRequest.x, tileRequest.y),
                    width: tileRequest.tileset.tileSize,
                    height: tileRequest.tileset.tileSize,
                    crs: tileRequest.tileset.crs,
                    pixelRatio: 1
                })

                if (!cachedImage && this.cache) {
                    await this.cache.write(cacheKey, image)
                }

                res.statusCode = 200
                res.setHeader('Content-Type', tileRequest.tileset.format)
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
                return
            }

            sendWmtsError(res, 'OperationNotSupported', `Unsupported REQUEST: ${params.get('REQUEST') ?? ''}`)
        } catch (error) {
            logTileError(tileTrace?.id, fullUrl, tileTrace?.startedAt, error)
            sendWmtsError(res, 'InvalidParameterValue', error instanceof Error ? error.message : String(error))
        }
    }
    private parseGetTile(params: Map<string, string>, tilesetByName: Map<string, Tileset>): WmtsTileRequest {
        const layerName = this.require(params, 'LAYER', 'Missing required parameter LAYER')
        const tileset = tilesetByName.get(layerName)
        if (!tileset) {
            throw new Error(`Unknown WMTS layer: ${layerName}`)
        }

        const version = params.get('VERSION')
        if (version && version !== WMTS_VERSION) {
            throw new Error(`VERSION must be ${WMTS_VERSION}`)
        }

        const style = params.get('STYLE') ?? 'default'
        if (style !== 'default') {
            throw new Error('STYLE must be default')
        }

        const format = params.get('FORMAT') ?? tileset.format
        if (format !== tileset.format) {
            throw new Error(`FORMAT must be ${tileset.format}`)
        }

        const matrixSet = this.require(params, 'TILEMATRIXSET', 'Missing required parameter TILEMATRIXSET')
        if (matrixSet !== tileset.tileMatrixSet.id) {
            throw new Error(`TILEMATRIXSET must be ${tileset.tileMatrixSet.id}`)
        }

        const z = tileset.zoomFromMatrixId(this.require(params, 'TILEMATRIX', 'Missing required parameter TILEMATRIX'))
        const x = nonNegativeInteger(this.require(params, 'TILECOL', 'Missing required parameter TILECOL'), 'TILECOL')
        const y = nonNegativeInteger(this.require(params, 'TILEROW', 'Missing required parameter TILEROW'), 'TILEROW')
        tileset.validateCoord(z, x, y)

        return {
            tileset,
            z,
            x,
            y
        }
    }

}


class WmtsCapabilitiesBuilder {
    static build(info: WmtsInfo, tilesets: Tileset[], serviceUrl: string): string {
        return MarkupTemplate.render(WMTS_CAPABILITIES_TEMPLATE, {
            version: WMTS_VERSION,
            info,
            onlineResource: info.onlineResource ?? serviceUrl,
            operations: [
                { name: 'GetCapabilities', serviceUrl },
                { name: 'GetTile', serviceUrl }
            ],
            layers: tilesets.map((tileset) => this.layerView(tileset, serviceUrl)),
            matrixSets: collectMatrixSetUses(tilesets).map((use) => this.matrixSetView(use))
        })
    }

    private static layerView(tileset: Tileset, serviceUrl: string): Record<string, unknown> {
        return {
            title: tileset.title ?? tileset.name,
            summary: tileset.summary,
            name: tileset.name,
            format: tileset.format,
            tileMatrixSet: tileset.tileMatrixSet.id,
            limits: this.tileMatrixSetLimits(tileset),
            resourceTemplate: tileTemplate(serviceUrl, tileset)
        }
    }

    private static tileMatrixSetLimits(tileset: Tileset): Array<Record<string, unknown>> {
        const limits: Array<Record<string, unknown>> = []

        for (let z = tileset.minZoom; z <= tileset.maxZoom; z += 1) {
            const max = 2 ** z - 1
            limits.push({
                tileMatrix: tileset.tileMatrixSet.matrixId(z),
                minTileRow: 0,
                maxTileRow: max,
                minTileCol: 0,
                maxTileCol: max
            })
        }

        return limits
    }

    private static matrixSetView(use: MatrixSetUse): Record<string, unknown> {
        const matrices = []

        for (let z = use.minZoom; z <= use.maxZoom; z += 1) {
            const matrix = use.tileMatrixSet.matrix(z, use.tileSize)
            matrices.push({
                id: matrix.id,
                scaleDenominator: matrix.scaleDenominator,
                topLeftCorner: matrix.topLeftCorner.join(' '),
                tileWidth: matrix.tileWidth,
                tileHeight: matrix.tileHeight,
                matrixWidth: matrix.matrixWidth,
                matrixHeight: matrix.matrixHeight
            })
        }

        return {
            title: use.tileMatrixSet.title,
            id: use.tileMatrixSet.id,
            supportedCrs: use.tileMatrixSet.supportedCrs,
            matrices
        }
    }
}

function tileTemplate(serviceUrl: string, tileset: Tileset): string {
    return [
        `${serviceUrl}?SERVICE=WMTS`,
        'REQUEST=GetTile',
        `VERSION=${WMTS_VERSION}`,
        `LAYER=${encodeURIComponent(tileset.name)}`,
        'STYLE=default',
        `TILEMATRIXSET=${encodeURIComponent(tileset.tileMatrixSet.id)}`,
        'TILEMATRIX={TileMatrix}',
        'TILEROW={TileRow}',
        'TILECOL={TileCol}',
        `FORMAT=${encodeURIComponent(tileset.format)}`
    ].join('&')
}

function collectMatrixSetUses(tilesets: Tileset[]): MatrixSetUse[] {
    const uses = new Map<string, MatrixSetUse>()

    for (const tileset of tilesets) {
        const id = tileset.tileMatrixSet.id
        const existing = uses.get(id)
        if (!existing) {
            uses.set(id, {
                tileMatrixSet: tileset.tileMatrixSet,
                tileSize: tileset.tileSize,
                minZoom: tileset.minZoom,
                maxZoom: tileset.maxZoom
            })
            continue
        }

        existing.minZoom = Math.min(existing.minZoom, tileset.minZoom)
        existing.maxZoom = Math.max(existing.maxZoom, tileset.maxZoom)
    }

    return [...uses.values()]
}

function validateWmtsTilesets(tilesets: Tileset[]): void {
    const tileSizeByMatrixSet = new Map<string, number>()

    for (const tileset of tilesets) {
        const existing = tileSizeByMatrixSet.get(tileset.tileMatrixSet.id)
        if (existing !== undefined && existing !== tileset.tileSize) {
            throw new Error(`WMTS tileMatrixSet "${tileset.tileMatrixSet.id}" cannot mix tileSize ${existing} and ${tileset.tileSize}`)
        }

        tileSizeByMatrixSet.set(tileset.tileMatrixSet.id, tileset.tileSize)
    }
}

function logTileStart(traceId: number, method: string, url: string): void {
    console.log(`[WMTS ${traceId}] IN  ${method} ${url}`)
}

function logTileDone(traceId: number, statusCode: number, startedAt: number, size: number): void {
    const durationMs = Date.now() - startedAt
    console.log(`[WMTS ${traceId}] OUT ${statusCode} ${durationMs}ms ${size}B`)
}

function logTileParams(traceId: number, request: WmtsTileRequest): void {
    console.log(`[WMTS ${traceId}] LAYER=${request.tileset.name} TILEMATRIX=${request.z} ROWCOL=${request.y}/${request.x}`)
}

function logTileError(traceId: number | undefined, url: string, startedAt: number | undefined, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const duration = startedAt === undefined ? '' : ` ${Date.now() - startedAt}ms`
    const prefix = traceId === undefined ? '[WMTS]' : `[WMTS ${traceId}]`
    console.error(`${prefix} ERR${duration} ${url}`)
    console.error(`${prefix} ERR ${message}`)
}

function sendWmtsError(res: ServerResponse, code: string, message: string): void {
    const body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">',
        `  <ows:Exception exceptionCode="${escape(code)}">`,
        `    <ows:ExceptionText>${escape(message)}</ows:ExceptionText>`,
        '  </ows:Exception>',
        '</ows:ExceptionReport>'
    ].join('\n')

    Service.sendText(res, 400, body, 'text/xml; charset=utf-8')
}
