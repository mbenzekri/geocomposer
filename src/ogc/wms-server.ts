import type { IncomingMessage, ServerResponse } from 'node:http'
import { TLSSocket } from 'node:tls'
import type { BBox, CrsCode } from '../core/types.js'
import { renderMap, type RenderLayer } from './render-map.js'
import type { Source } from '../source/source.js'
import type { StyleFn } from '../style/style-fn.js'

const WMS_VERSION = '1.3.0'

export type WmsLayer = {
  name: string
  title?: string
  abstract?: string
  source: Source
  style: StyleFn
}

export type WmsService = {
  title: string
  abstract?: string
  onlineResource?: string
}

export type WmsAppOptions = {
  path?: string
  service: WmsService
  layers: WmsLayer[]
  maxWidth?: number
  maxHeight?: number
}

export type WmsApp = {
  open(): Promise<void>
  close(): Promise<void>
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export function createWmsApp(options: WmsAppOptions): WmsApp {
  const path = options.path ?? '/wms'
  const maxWidth = options.maxWidth ?? 4096
  const maxHeight = options.maxHeight ?? 4096
  const layerByName = new Map(options.layers.map((layer) => [layer.name, layer]))
  const sources = [...new Set(options.layers.map((layer) => layer.source))]
  let nextTraceId = 1

  return {
    async open() {
      for (const source of sources) {
        await source.open()
      }
    },

    async close() {
      for (const source of sources) {
        await source.close()
      }
    },

    async handle(req, res) {
      const fullUrl = getRequestUrl(req)
      let mapTrace: { id: number, startedAt: number } | null = null

      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
          return
        }

        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== path) {
          sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8')
          return
        }

        const params = getParams(url)
        const request = (params.get('REQUEST') ?? 'GetCapabilities').toUpperCase()
        const service = params.get('SERVICE')

        if (service && service.toUpperCase() !== 'WMS') {
          sendWmsError(res, 'InvalidParameterValue', 'SERVICE must be WMS')
          return
        }

        if (request === 'GETCAPABILITIES') {
          const xml = await buildCapabilitiesXml(options.service, options.layers, path)
          sendText(res, 200, xml, 'text/xml; charset=utf-8')
          return
        }

        if (request === 'GETMAP') {
          const traceId = nextTraceId
          nextTraceId += 1
          const startedAt = Date.now()
          mapTrace = { id: traceId, startedAt }
          logGetMapStart(traceId, req.method ?? 'GET', fullUrl)

          const mapRequest = parseGetMap(params, layerByName, maxWidth, maxHeight)
          logGetMapParams(traceId, mapRequest)
          const image = await renderMap({
            layers: mapRequest.layers,
            bbox: mapRequest.bbox,
            width: mapRequest.width,
            height: mapRequest.height,
            crs: mapRequest.crs
          })

          res.statusCode = 200
          res.setHeader('Content-Type', mapRequest.format)
          res.setHeader('Content-Length', image.byteLength)
          if (req.method !== 'HEAD') {
            res.end(image)
            logGetMapDone(traceId, res.statusCode, startedAt, image.byteLength)
            return
          }

          res.end()
          logGetMapDone(traceId, res.statusCode, startedAt, 0)
          return
        }

        sendWmsError(res, 'OperationNotSupported', `Unsupported REQUEST: ${params.get('REQUEST') ?? ''}`)
      } catch (error) {
        if (mapTrace || isGetMapRequest(req.url)) {
          logGetMapError(mapTrace?.id, fullUrl, mapTrace?.startedAt, error)
        }
        sendWmsError(res, 'InvalidParameterValue', error instanceof Error ? error.message : String(error))
      }
    }
  }
}

type MapRequest = {
  layers: RenderLayer[]
  rawBbox: string
  bbox: BBox
  bboxOrder: 'xy' | 'yx'
  width: number
  height: number
  crs: CrsCode
  version: string
  format: string
}

function parseGetMap(
  params: Map<string, string>,
  layerByName: Map<string, WmsLayer>,
  maxWidth: number,
  maxHeight: number
): MapRequest {
  const layerNames = requireParam(params, 'LAYERS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (layerNames.length === 0) {
    throw new Error('LAYERS must not be empty')
  }

  const layers = layerNames.map((name) => {
    const layer = layerByName.get(name)
    if (!layer) {
      throw new Error(`Unknown layer: ${name}`)
    }

    return {
      source: layer.source,
      style: layer.style
    }
  })

  const version = params.get('VERSION') ?? WMS_VERSION
  const width = parsePositiveInt(requireParam(params, 'WIDTH'), 'WIDTH', maxWidth)
  const height = parsePositiveInt(requireParam(params, 'HEIGHT'), 'HEIGHT', maxHeight)
  const crs = params.get('CRS') ?? params.get('SRS')
  if (!crs) {
    throw new Error('CRS is required')
  }
  const rawBbox = requireParam(params, 'BBOX')
  const parsedBbox = parseBBox(rawBbox, crs, version)

  const format = params.get('FORMAT') ?? 'image/png'
  if (format !== 'image/png') {
    throw new Error(`Unsupported FORMAT: ${format}`)
  }

  return {
    layers,
    rawBbox,
    bbox: parsedBbox.bbox,
    bboxOrder: parsedBbox.order,
    width,
    height,
    crs,
    version,
    format
  }
}

async function buildCapabilitiesXml(service: WmsService, layers: WmsLayer[], path: string): Promise<string> {
  const layerXml: string[] = []

  for (const layer of layers) {
    const extent = await layer.source.getExtent()
    layerXml.push([
      '<Layer queryable="0">',
      `<Name>${escapeXml(layer.name)}</Name>`,
      `<Title>${escapeXml(layer.title ?? layer.name)}</Title>`,
      layer.abstract ? `<Abstract>${escapeXml(layer.abstract)}</Abstract>` : '',
      `<CRS>${escapeXml(layer.source.crs)}</CRS>`,
      extent ? bboxXml(extent, layer.source.crs) : '',
      '</Layer>'
    ].join(''))
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<WMS_Capabilities version="${WMS_VERSION}" xmlns="http://www.opengis.net/wms">`,
    '<Service>',
    '<Name>WMS</Name>',
    `<Title>${escapeXml(service.title)}</Title>`,
    service.abstract ? `<Abstract>${escapeXml(service.abstract)}</Abstract>` : '',
    service.onlineResource ? `<OnlineResource>${escapeXml(service.onlineResource)}</OnlineResource>` : '',
    '</Service>',
    '<Capability>',
    '<Request>',
    `<GetCapabilities><Format>text/xml</Format><DCPType><HTTP><Get><OnlineResource>${escapeXml(path)}</OnlineResource></Get></HTTP></DCPType></GetCapabilities>`,
    `<GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource>${escapeXml(path)}</OnlineResource></Get></HTTP></DCPType></GetMap>`,
    '</Request>',
    '<Exception><Format>text/xml</Format></Exception>',
    '<Layer>',
    `<Title>${escapeXml(service.title)}</Title>`,
    ...layerXml,
    '</Layer>',
    '</Capability>',
    '</WMS_Capabilities>'
  ].join('')
}

function bboxXml(bbox: BBox, crs: CrsCode): string {
  const axisBbox = toWmsBoundingBox(bbox, crs, WMS_VERSION)

  return [
    '<EX_GeographicBoundingBox>',
    `<westBoundLongitude>${bbox[0]}</westBoundLongitude>`,
    `<eastBoundLongitude>${bbox[2]}</eastBoundLongitude>`,
    `<southBoundLatitude>${bbox[1]}</southBoundLatitude>`,
    `<northBoundLatitude>${bbox[3]}</northBoundLatitude>`,
    '</EX_GeographicBoundingBox>',
    `<BoundingBox CRS="${escapeXml(crs)}" minx="${axisBbox[0]}" miny="${axisBbox[1]}" maxx="${axisBbox[2]}" maxy="${axisBbox[3]}"/>`
  ].join('')
}

function parseBBox(value: string, crs: CrsCode, version: string): { bbox: BBox, order: 'xy' | 'yx' } {
  const parts = value.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid BBOX: ${value}`)
  }

  if (!usesLatLonAxisOrder(crs, version)) {
    const bbox: BBox = [parts[0], parts[1], parts[2], parts[3]]
    validateBBox(bbox, crs, version)
    return {
      bbox,
      order: 'xy'
    }
  }

  const bbox: BBox = [parts[1], parts[0], parts[3], parts[2]]
  validateBBox(bbox, crs, version)
  return {
    bbox,
    order: 'yx'
  }
}

function validateBBox(bbox: BBox, crs: CrsCode, version: string): void {
  const [minX, minY, maxX, maxY] = bbox

  if (!(minX < maxX) || !(minY < maxY)) {
    throw new Error(`Invalid BBOX for ${crs}: bounds must be ordered as minx,miny,maxx,maxy`)
  }

  if (crs.toUpperCase() !== 'EPSG:4326') {
    return
  }

  if (!isLongitude(minX) || !isLongitude(maxX) || !isLatitude(minY) || !isLatitude(maxY)) {
    if (usesLatLonAxisOrder(crs, version)) {
      throw new Error(
        `Invalid BBOX for ${crs} in WMS ${version}: expected axis order lat,lon (minLat,minLon,maxLat,maxLon)`
      )
    }

    throw new Error(`Invalid BBOX for ${crs}: longitude must be within [-180,180] and latitude within [-90,90]`)
  }
}

function toWmsBoundingBox(bbox: BBox, crs: CrsCode, version: string): BBox {
  if (usesLatLonAxisOrder(crs, version)) {
    return [bbox[1], bbox[0], bbox[3], bbox[2]]
  }

  return bbox
}

function usesLatLonAxisOrder(crs: CrsCode, version: string): boolean {
  return version === '1.3.0' && crs.toUpperCase() === 'EPSG:4326'
}

function isLatitude(value: number): boolean {
  return value >= -90 && value <= 90
}

function isLongitude(value: number): boolean {
  return value >= -180 && value <= 180
}

function parsePositiveInt(value: string, name: string, maxValue: number): number {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  if (number > maxValue) {
    throw new Error(`${name} exceeds maximum value ${maxValue}`)
  }

  return number
}

function requireParam(params: Map<string, string>, name: string): string {
  const value = params.get(name)
  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

function getParams(url: URL): Map<string, string> {
  const params = new Map<string, string>()

  for (const [key, value] of url.searchParams.entries()) {
    params.set(key.toUpperCase(), value)
  }

  return params
}

function getRequestUrl(req: IncomingMessage): string {
  const socketProtocol = req.socket instanceof TLSSocket && req.socket.encrypted
    ? 'https'
    : 'http'
  const protocol = req.headers['x-forwarded-proto']
    ?? socketProtocol
  const host = req.headers.host ?? 'localhost'
  return new URL(req.url ?? '/', `${protocol}://${host}`).toString()
}

function isGetMapRequest(urlText: string | undefined): boolean {
  if (!urlText) return false

  try {
    const url = new URL(urlText, 'http://localhost')
    const request = url.searchParams.get('REQUEST')
    return (request ?? '').toUpperCase() === 'GETMAP'
  } catch {
    return false
  }
}

function logGetMapStart(traceId: number, method: string, url: string): void {
  console.log(`[GetMap ${traceId}] IN  ${method} ${url}`)
}

function logGetMapDone(traceId: number, statusCode: number, startedAt: number, size: number): void {
  const durationMs = Date.now() - startedAt
  console.log(`[GetMap ${traceId}] OUT ${statusCode} ${durationMs}ms ${size}B`)
}

function logGetMapParams(traceId: number, request: MapRequest): void {
  console.log(`[GetMap ${traceId}] BBOX raw  = ${request.rawBbox}`)
  console.log(`[GetMap ${traceId}] BBOX used = ${request.bbox.join(',')}`)
  console.log(`[GetMap ${traceId}] CRS=${request.crs} VERSION=${request.version} ORDER=${request.bboxOrder} SIZE=${request.width}x${request.height}`)
}

function logGetMapError(traceId: number | undefined, url: string, startedAt: number | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const duration = startedAt === undefined ? '' : ` ${Date.now() - startedAt}ms`
  const prefix = traceId === undefined ? '[GetMap]' : `[GetMap ${traceId}]`
  console.error(`${prefix} ERR${duration} ${url}`)
  console.error(`${prefix} ERR ${message}`)
}

function sendWmsError(res: ServerResponse, code: string, message: string): void {
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc">',
    `<ServiceException code="${escapeXml(code)}">${escapeXml(message)}</ServiceException>`,
    '</ServiceExceptionReport>'
  ].join('')

  sendText(res, 400, body, 'text/xml; charset=utf-8')
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
