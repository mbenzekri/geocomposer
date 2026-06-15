import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { escape, nonNegativeInteger, paramsFromUrl, Props } from '../core/tools.js'
import { MarkupTemplate } from '../core/template.js'
import { getMap } from '../ogc/get-map.js'
import type { TileMatrixSet } from '../tileset/tile-matrix-set.js'
import { Tileset, type TileOutput } from '../tileset/tileset.js'
import { getVectorTile } from '../tileset/vector-tile.js'
import { Service } from './service.js'
import { DescInfo, ServiceInfo } from '../core/feature.js'

const WMTS_VERSION = '1.0.0'

export type WmtsJson = DescInfo & ServiceInfo & {
    cache?: string
    tilesets?: string[]
}

type WmtsTileRequest = {
    tileset: Tileset
    output: TileOutput
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
      {{#formats}}
      <Format>{{.}}</Format>
      {{/formats}}
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
      {{#resourceTemplates}}
      <ResourceURL format="{{format}}" resourceType="tile" template="{{template}}"/>
      {{/resourceTemplates}}
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
    private nextTraceId = 1

    constructor(opts: WmtsJson) {
        super('wmts', opts.title, opts.abstract, opts.path ?? '/wmts', opts.onlineResource, opts.cache)

        const tilesets = Tileset.select(opts.tilesets, 'WMTS')
        this.tilesetByName = new Map(tilesets.map((tileset) => [tileset.name, tileset]))
        validateWmtsTilesets(tilesets)
    }

    static fromConfig(entry: WmtsJson, baseDir: string): Wmts {
        return new Wmts({
            ...entry,
            cache: entry.cache ? resolve(baseDir, entry.cache) : undefined
        })
    }

    get tilesets(): Tileset[] {
        return [...this.tilesetByName.values()]
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const fullUrl = Service.requestUrl(req)
        const startedAt = Date.now()
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

            const params = paramsFromUrl(url)
            const service = params.get('SERVICE')
            if (service && service.toUpperCase() !== 'WMTS') {
                sendWmtsError(res, 'InvalidParameterValue', 'SERVICE must be WMTS')
                return
            }

            const request = (params.get('REQUEST') ?? 'GetCapabilities').toUpperCase()
            if (request === 'GETCAPABILITIES') {
                const xml = WmtsCapabilitiesBuilder.build(this, this.tilesets, Service.serviceUrl(req, this.path))
                Service.sendText(res, 200, xml, 'text/xml; charset=utf-8', req.method === 'HEAD')
                return
            }

            if (request === 'GETTILE') {
                this.nextTraceId += 1
                this.logHandleStart(traceId, req.method ?? 'GET', fullUrl)

                const tileRequest = this.parseGetTile(params, this.tilesetByName)
                this.logHandleParams(traceId, tileRequest)

                const cacheKey = {
                    tileset: tileRequest.tileset.name,
                    z: tileRequest.z,
                    x: tileRequest.x,
                    y: tileRequest.y,
                    extension: tileRequest.output.extension
                }
                const cachedTile = this.cache ? await this.cache.read(cacheKey) : null
                const tile = cachedTile ?? await renderTile(tileRequest)

                if (!cachedTile && this.cache) {
                    await this.cache.write(cacheKey, tile)
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
                } else {
                    res.end()
                    this.logHandleDone(traceId, res.statusCode, startedAt, 0)
                }

                return
            }

            sendWmtsError(res, 'OperationNotSupported', `Unsupported REQUEST: ${params.get('REQUEST') ?? ''}`)
        } catch (error) {
            this.logHandleError(traceId, fullUrl, startedAt, error)
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

        const output = tileset.resolveOutput(params.get('FORMAT') ?? tileset.defaultFormat)

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
            output,
            z,
            x,
            y
        }
    }
    logListening(baseUrl: string): void {
        console.log(`[WMTS] listening on: ${baseUrl}${this.path}`)
        console.log(`[WMTS] GetCapabilities: ${baseUrl}${this.path}?SERVICE=WMTS&REQUEST=GetCapabilities`)
        const sampleTileset = this.tilesets[0]?.name
        if (sampleTileset) {
            console.log(`[WMTS] Get Tile: ${baseUrl}${this.path}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${encodeURIComponent(sampleTileset)}&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX=1&TILEROW=1&TILECOL=1&FORMAT=image%2Fpng`)
        }
    }

    protected logHandleParams(traceId: number, request: WmtsTileRequest): void {
        console.log(`[WMTS ${traceId}] LAYER=${request.tileset.name} FORMAT=${request.output.format} TILEMATRIX=${request.z} ROWCOL=${request.y}/${request.x}`)
    }
}

async function renderTile(request: WmtsTileRequest): Promise<Buffer> {
    const bbox = request.tileset.bbox(request.z, request.x, request.y)

    if (!request.output.vector) {
        return getMap({
            layers: request.tileset.layers,
            styles: request.tileset.styles,
            bbox,
            width: request.tileset.tileSize,
            height: request.tileset.tileSize,
            crs: request.tileset.crs,
            pixelRatio: 1
        })
    }

    return getVectorTile({
        layers: request.tileset.layers,
        bbox,
        crs: request.tileset.crs,
        tileSize: request.tileset.tileSize,
        format: request.output.format,
        vector: request.tileset.vector
    })
}


class WmtsCapabilitiesBuilder {
    static build(wmts: Wmts, tilesets: Tileset[], serviceUrl: string): string {
        return MarkupTemplate.render(WMTS_CAPABILITIES_TEMPLATE, {
            version: WMTS_VERSION,
            info: wmts,
            onlineResource: wmts.onlineResource ?? serviceUrl,
            operations: [
                { name: 'GetCapabilities', serviceUrl },
                { name: 'GetTile', serviceUrl }
            ],
            layers: tilesets.map((tileset) => this.layerView(tileset, serviceUrl)),
            matrixSets: collectMatrixSetUses(tilesets).map((use) => this.matrixSetView(use))
        })
    }

    private static layerView(tileset: Tileset, serviceUrl: string): Props {
        return {
            title: tileset.title ?? tileset.name,
            summary: tileset.summary,
            name: tileset.name,
            formats: tileset.formats,
            tileMatrixSet: tileset.tileMatrixSet.id,
            limits: this.tileMatrixSetLimits(tileset),
            resourceTemplates: tileset.outputs.map((output) => ({
                format: output.format,
                template: tileTemplate(serviceUrl, tileset, output)
            }))
        }
    }

    private static tileMatrixSetLimits(tileset: Tileset): Array<Props> {
        const limits = []

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

    private static matrixSetView(use: MatrixSetUse): Props {
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

function tileTemplate(serviceUrl: string, tileset: Tileset, output: TileOutput): string {
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
        `FORMAT=${encodeURIComponent(output.format)}`
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
