import type { IncomingMessage, ServerResponse } from 'node:http'
import { MarkupTemplate } from '../core/template.js'
import { renderMap } from '../ogc/render-map.js'
import { XmlText } from '../ogc/xml-utils.js'
import { TileCache } from '../tileset/tile-cache.js'
import type { TileMatrixSet } from '../tileset/tile-matrix-set.js'
import { TilesetLayers } from '../tileset/tileset-utils.js'
import type { Tileset } from '../tileset/tileset.js'
import { Service } from './service.js'
import { ServiceHttp, ServiceNumberParser, ServiceParams } from './service-utils.js'

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

  async open(): Promise<void> {
    for (const layer of TilesetLayers.unique(this.options.tilesets)) {
      await layer.open()
    }
  }

  async close(): Promise<void> {
    for (const layer of TilesetLayers.unique(this.options.tilesets)) {
      await layer.close()
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fullUrl = ServiceHttp.requestUrl(req)
    let tileTrace: { id: number, startedAt: number } | null = null

    try {
      ServiceHttp.setCorsHeaders(res)

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        ServiceHttp.sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!this.matches(url.pathname)) {
        ServiceHttp.sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8')
        return
      }

      const params = ServiceParams.fromUrl(url)
      const service = params.get('SERVICE')
      if (service && service.toUpperCase() !== 'WMTS') {
        sendWmtsError(res, 'InvalidParameterValue', 'SERVICE must be WMTS')
        return
      }

      const request = (params.get('REQUEST') ?? 'GetCapabilities').toUpperCase()
      if (request === 'GETCAPABILITIES') {
        const xml = WmtsCapabilitiesBuilder.build(this.options.info, this.options.tilesets, ServiceHttp.serviceUrl(req, this.path))
        ServiceHttp.sendText(res, 200, xml, 'text/xml; charset=utf-8', req.method === 'HEAD')
        return
      }

      if (request === 'GETTILE') {
        const traceId = this.nextTraceId
        this.nextTraceId += 1
        const startedAt = Date.now()
        tileTrace = { id: traceId, startedAt }
        logTileStart(traceId, req.method ?? 'GET', fullUrl)

        const tileRequest = parseGetTile(params, this.tilesetByName)
        logTileParams(traceId, tileRequest)

        const cacheKey = {
          tileset: tileRequest.tileset.name,
          z: tileRequest.z,
          x: tileRequest.x,
          y: tileRequest.y
        }
        const cachedImage = this.cache ? await this.cache.read(cacheKey) : null
        const image = cachedImage ?? await renderMap({
          layers: tileRequest.tileset.layers,
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
}

function parseGetTile(params: Map<string, string>, tilesetByName: Map<string, Tileset>): WmtsTileRequest {
  const layerName = ServiceParams.require(params, 'LAYER', 'Missing required parameter LAYER')
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

  const matrixSet = ServiceParams.require(params, 'TILEMATRIXSET', 'Missing required parameter TILEMATRIXSET')
  if (matrixSet !== tileset.tileMatrixSet.id) {
    throw new Error(`TILEMATRIXSET must be ${tileset.tileMatrixSet.id}`)
  }

  const z = tileset.zoomFromMatrixId(ServiceParams.require(params, 'TILEMATRIX', 'Missing required parameter TILEMATRIX'))
  const x = ServiceNumberParser.nonNegativeInteger(ServiceParams.require(params, 'TILECOL', 'Missing required parameter TILECOL'), 'TILECOL')
  const y = ServiceNumberParser.nonNegativeInteger(ServiceParams.require(params, 'TILEROW', 'Missing required parameter TILEROW'), 'TILEROW')
  tileset.validateCoord(z, x, y)

  return {
    tileset,
    z,
    x,
    y
  }
}

function buildCapabilitiesXml(info: WmtsInfo, tilesets: Tileset[], serviceUrl: string): string {
  const onlineResource = info.onlineResource ?? serviceUrl
  const matrixSetUses = collectMatrixSetUses(tilesets)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Capabilities xmlns="http://www.opengis.net/wmts/1.0"',
    '  xmlns:ows="http://www.opengis.net/ows/1.1"',
    '  xmlns:xlink="http://www.w3.org/1999/xlink"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xsi:schemaLocation="http://www.opengis.net/wmts/1.0 http://schemas.opengis.net/wmts/1.0/wmtsGetCapabilities_response.xsd"',
    `  version="${WMTS_VERSION}">`,
    '  <ows:ServiceIdentification>',
    `    <ows:Title>${XmlText.escape(info.title)}</ows:Title>`,
    info.abstract ? `    <ows:Abstract>${XmlText.escape(info.abstract)}</ows:Abstract>` : '',
    '    <ows:ServiceType>OGC WMTS</ows:ServiceType>',
    `    <ows:ServiceTypeVersion>${WMTS_VERSION}</ows:ServiceTypeVersion>`,
    '  </ows:ServiceIdentification>',
    '  <ows:OperationsMetadata>',
    operationXml('GetCapabilities', serviceUrl),
    operationXml('GetTile', serviceUrl),
    '  </ows:OperationsMetadata>',
    '  <Contents>',
    ...tilesets.map((tileset) => layerXml(tileset, serviceUrl)),
    ...matrixSetUses.map(matrixSetXml),
    '  </Contents>',
    '  <ServiceMetadataURL xlink:href="' + XmlText.escape(onlineResource) + '"/>',
    '</Capabilities>'
  ].filter(Boolean).join('\n')
}

function operationXml(name: string, serviceUrl: string): string {
  return [
    `    <ows:Operation name="${name}">`,
    '      <ows:DCP>',
    '        <ows:HTTP>',
    `          <ows:Get xlink:href="${XmlText.escape(serviceUrl)}"/>`,
    '        </ows:HTTP>',
    '      </ows:DCP>',
    '    </ows:Operation>'
  ].join('\n')
}

function layerXml(tileset: Tileset, serviceUrl: string): string {
  return [
    '    <Layer>',
    `      <ows:Title>${XmlText.escape(tileset.title ?? tileset.name)}</ows:Title>`,
    tileset.summary ? `      <ows:Abstract>${XmlText.escape(tileset.summary)}</ows:Abstract>` : '',
    `      <ows:Identifier>${XmlText.escape(tileset.name)}</ows:Identifier>`,
    '      <Style isDefault="true">',
    '        <ows:Identifier>default</ows:Identifier>',
    '      </Style>',
    `      <Format>${XmlText.escape(tileset.format)}</Format>`,
    '      <TileMatrixSetLink>',
    `        <TileMatrixSet>${XmlText.escape(tileset.tileMatrixSet.id)}</TileMatrixSet>`,
    tileMatrixSetLimitsXml(tileset),
    '      </TileMatrixSetLink>',
    `      <ResourceURL format="${XmlText.escape(tileset.format)}" resourceType="tile" template="${XmlText.escape(tileTemplate(serviceUrl, tileset))}"/>`,
    '    </Layer>'
  ].filter(Boolean).join('\n')
}

function tileMatrixSetLimitsXml(tileset: Tileset): string {
  const limits = []
  for (let z = tileset.minZoom; z <= tileset.maxZoom; z += 1) {
    const max = 2 ** z - 1
    limits.push([
      '        <TileMatrixLimits>',
      `          <TileMatrix>${tileset.tileMatrixSet.matrixId(z)}</TileMatrix>`,
      '          <MinTileRow>0</MinTileRow>',
      `          <MaxTileRow>${max}</MaxTileRow>`,
      '          <MinTileCol>0</MinTileCol>',
      `          <MaxTileCol>${max}</MaxTileCol>`,
      '        </TileMatrixLimits>'
    ].join('\n'))
  }

  return [
    '        <TileMatrixSetLimits>',
    ...limits,
    '        </TileMatrixSetLimits>'
  ].join('\n')
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

function matrixSetXml(use: MatrixSetUse): string {
  const matrices = []
  for (let z = use.minZoom; z <= use.maxZoom; z += 1) {
    matrices.push(tileMatrixXml(use.tileMatrixSet, z, use.tileSize))
  }

  return [
    '    <TileMatrixSet>',
    `      <ows:Title>${XmlText.escape(use.tileMatrixSet.title)}</ows:Title>`,
    `      <ows:Identifier>${XmlText.escape(use.tileMatrixSet.id)}</ows:Identifier>`,
    `      <ows:SupportedCRS>${XmlText.escape(use.tileMatrixSet.supportedCrs)}</ows:SupportedCRS>`,
    ...matrices,
    '    </TileMatrixSet>'
  ].join('\n')
}

function tileMatrixXml(tileMatrixSet: TileMatrixSet, z: number, tileSize: number): string {
  const matrix = tileMatrixSet.matrix(z, tileSize)
  return [
    '      <TileMatrix>',
    `        <ows:Identifier>${matrix.id}</ows:Identifier>`,
    `        <ScaleDenominator>${matrix.scaleDenominator}</ScaleDenominator>`,
    `        <TopLeftCorner>${matrix.topLeftCorner.join(' ')}</TopLeftCorner>`,
    `        <TileWidth>${matrix.tileWidth}</TileWidth>`,
    `        <TileHeight>${matrix.tileHeight}</TileHeight>`,
    `        <MatrixWidth>${matrix.matrixWidth}</MatrixWidth>`,
    `        <MatrixHeight>${matrix.matrixHeight}</MatrixHeight>`,
    '      </TileMatrix>'
  ].join('\n')
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
    `  <ows:Exception exceptionCode="${XmlText.escape(code)}">`,
    `    <ows:ExceptionText>${XmlText.escape(message)}</ows:ExceptionText>`,
    '  </ows:Exception>',
    '</ows:ExceptionReport>'
  ].join('\n')

  ServiceHttp.sendText(res, 400, body, 'text/xml; charset=utf-8')
}
