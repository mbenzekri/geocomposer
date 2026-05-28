import type { IncomingMessage, ServerResponse } from 'node:http'
import proj4 from 'proj4'
import type { BBox, CrsCode } from '../core/types.js'
import { MarkupTemplate } from '../core/template.js'
import {
  featureInfoToGeoJson,
  featureInfoToXml,
  getFeatureInfo
} from '../ogc/get-feature-info.js'
import { renderMap, type RenderLayer } from '../ogc/render-map.js'
import { escape } from '../core/tools.js'
import type { Layer } from '../layer/layer.js'
import { Service } from './service.js'
import { ServiceHttp, ServiceParams } from './service-utils.js'
import type { StyleFn } from '../style/style-fn.js'

const WMS_VERSION = '1.3.0'
const WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
const FEATURE_INFO_FORMATS = ['application/geo+json', 'application/json', 'text/xml', 'application/xml'] as const

export type WmsInfo = {
  title: string
  abstract?: string
  onlineResource?: string
}

export type WmsOptions = {
  path?: string
  info: WmsInfo
  crs?: CrsCode[]
  layers: Layer[]
  maxWidth?: number
  maxHeight?: number
}

export class Wms extends Service {
  private readonly maxWidth: number
  private readonly maxHeight: number
  private readonly layerByName: Map<string, Layer>
  private readonly crs: CrsCode[]
  private nextTraceId = 1

  constructor(private readonly options: WmsOptions) {
    super('wms', options.path ?? '/wms')

    this.maxWidth = options.maxWidth ?? 4096
    this.maxHeight = options.maxHeight ?? 4096
    this.layerByName = new Map(options.layers.map((layer) => [layer.name, layer]))
    this.crs = unique(options.crs && options.crs.length > 0
      ? options.crs
      : options.layers.map((layer) => layer.sourceCrs)
    )
  }

  async open(): Promise<void> {
    for (const layer of this.options.layers) {
      await layer.open()
    }
  }

  async close(): Promise<void> {
    for (const layer of this.options.layers) {
      await layer.close()
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fullUrl = ServiceHttp.requestUrl(req)
    let mapTrace: { id: number, startedAt: number } | null = null

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
      const request = (params.get('REQUEST') ?? 'GetCapabilities').toUpperCase()
      const service = params.get('SERVICE')

      if (service && service.toUpperCase() !== 'WMS') {
        sendWmsError(res, 'InvalidParameterValue', 'SERVICE must be WMS')
        return
      }

      if (request === 'GETCAPABILITIES') {
        const xml = await WmsCapabilitiesBuilder.build(this.options.info, this.options.layers, this.path, this.crs)
        ServiceHttp.sendText(res, 200, xml, 'text/xml; charset=utf-8')
        return
      }

      if (request === 'GETMAP') {
        const traceId = this.nextTraceId
        this.nextTraceId += 1
        const startedAt = Date.now()
        mapTrace = { id: traceId, startedAt }
        logGetMapStart(traceId, req.method ?? 'GET', fullUrl)

        const mapRequest = parseGetMap(params, this.layerByName, this.crs, this.maxWidth, this.maxHeight)
        logGetMapParams(traceId, mapRequest)
        const image = await renderMap({
          layers: mapRequest.layers,
          bbox: mapRequest.bbox,
          width: mapRequest.width,
          height: mapRequest.height,
          crs: mapRequest.crs,
          pixelRatio: mapRequest.pixelRatio
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

      if (request === 'GETFEATUREINFO') {
        const featureInfoRequest = parseGetFeatureInfo(params, this.layerByName, this.crs, this.maxWidth, this.maxHeight)
        const result = await getFeatureInfo({
          layers: featureInfoRequest.layers,
          bbox: featureInfoRequest.bbox,
          width: featureInfoRequest.width,
          height: featureInfoRequest.height,
          crs: featureInfoRequest.crs,
          i: featureInfoRequest.i,
          j: featureInfoRequest.j,
          featureCount: featureInfoRequest.featureCount,
          tolerancePixels: featureInfoRequest.tolerancePixels
        })
        const body = formatFeatureInfo(result, featureInfoRequest.infoFormat)
        ServiceHttp.sendText(res, 200, body, contentTypeForInfoFormat(featureInfoRequest.infoFormat), req.method === 'HEAD')
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

type MapRequest = {
  layers: RenderLayer[]
  layerNames: string[]
  rawBbox: string
  bbox: BBox
  bboxOrder: 'xy' | 'yx'
  width: number
  height: number
  crs: CrsCode
  pixelRatio: number
  version: string
  format: string
}

type FeatureInfoRequest = {
  layers: Layer[]
  rawBbox: string
  bbox: BBox
  bboxOrder: 'xy' | 'yx'
  width: number
  height: number
  crs: CrsCode
  version: string
  i: number
  j: number
  featureCount: number
  tolerancePixels: number
  infoFormat: FeatureInfoFormat
}

type FeatureInfoFormat = typeof FEATURE_INFO_FORMATS[number]

type WmsBoundingBoxView = {
  crs: CrsCode
  minx: number
  miny: number
  maxx: number
  maxy: number
}

const WMS_CAPABILITIES_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="{{version}}" xmlns="http://www.opengis.net/wms">
  <Service>
    <Name>WMS</Name>
    <Title>{{service.title}}</Title>
    {{#service.abstract}}<Abstract>{{service.abstract}}</Abstract>{{/service.abstract}}
    {{#service.onlineResource}}<OnlineResource>{{service.onlineResource}}</OnlineResource>{{/service.onlineResource}}
  </Service>
  <Capability>
    <Request>
      <GetCapabilities><Format>text/xml</Format><DCPType><HTTP><Get><OnlineResource>{{onlineResource}}</OnlineResource></Get></HTTP></DCPType></GetCapabilities>
      <GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource>{{onlineResource}}</OnlineResource></Get></HTTP></DCPType></GetMap>
      <GetFeatureInfo>{{#featureInfoFormats}}<Format>{{.}}</Format>{{/featureInfoFormats}}<DCPType><HTTP><Get><OnlineResource>{{onlineResource}}</OnlineResource></Get></HTTP></DCPType></GetFeatureInfo>
    </Request>
    <Exception><Format>text/xml</Format></Exception>
    <Layer>
      <Title>{{service.title}}</Title>
      {{#crs}}<CRS>{{.}}</CRS>{{/crs}}
      {{#layers}}
      <Layer queryable="1">
        <Name>{{name}}</Name>
        <Title>{{title}}</Title>
        {{#summary}}<Abstract>{{summary}}</Abstract>{{/summary}}
        {{#crs}}<CRS>{{.}}</CRS>{{/crs}}
        {{#styles}}
        <Style>
          <Name>{{name}}</Name>
          <Title>{{title}}</Title>
          {{#summary}}<Abstract>{{summary}}</Abstract>{{/summary}}
        </Style>
        {{/styles}}
        {{#extent}}
        <EX_GeographicBoundingBox>
          <westBoundLongitude>{{west}}</westBoundLongitude>
          <eastBoundLongitude>{{east}}</eastBoundLongitude>
          <southBoundLatitude>{{south}}</southBoundLatitude>
          <northBoundLatitude>{{north}}</northBoundLatitude>
        </EX_GeographicBoundingBox>
        {{#boundingBoxes}}<BoundingBox CRS="{{crs}}" minx="{{minx}}" miny="{{miny}}" maxx="{{maxx}}" maxy="{{maxy}}"/>{{/boundingBoxes}}
        {{/extent}}
      </Layer>
      {{/layers}}
    </Layer>
  </Capability>
</WMS_Capabilities>`

function parseGetMap(
  params: Map<string, string>,
  layerByName: Map<string, Layer>,
  supportedCrs: CrsCode[],
  maxWidth: number,
  maxHeight: number
): MapRequest {
  const layerNames = ServiceParams.require(params, 'LAYERS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (layerNames.length === 0) {
    throw new Error('LAYERS must not be empty')
  }

  const selectedLayers = layerNames.map((name) => {
    const layer = layerByName.get(name)
    if (!layer) {
      throw new Error(`Unknown layer: ${name}`)
    }

    return layer
  })

  const version = params.get('VERSION') ?? WMS_VERSION
  const width = parsePositiveInt(ServiceParams.require(params, 'WIDTH'), 'WIDTH', maxWidth)
  const height = parsePositiveInt(ServiceParams.require(params, 'HEIGHT'), 'HEIGHT', maxHeight)
  const pixelRatio = parseWmsPixelRatio(params)
  const crs = params.get('CRS') ?? params.get('SRS')
  if (!crs) {
    throw new Error('CRS is required')
  }
  const rawBbox = ServiceParams.require(params, 'BBOX')
  const parsedBbox = parseBBox(rawBbox, crs, version)
  validateCrs(supportedCrs, crs)
  const styleNames = parseStyles(params.get('STYLES'), selectedLayers.length)
  const layers = selectedLayers.map((layer, index) => ({
    layer,
    style: resolveLayerStyle(layer, styleNames[index])
  }))

  const format = params.get('FORMAT') ?? 'image/png'
  if (format !== 'image/png') {
    throw new Error(`Unsupported FORMAT: ${format}`)
  }

  return {
    layers,
    layerNames,
    rawBbox,
    bbox: parsedBbox.bbox,
    bboxOrder: parsedBbox.order,
    width,
    height,
    crs,
    pixelRatio,
    version,
    format
  }
}

function parseGetFeatureInfo(
  params: Map<string, string>,
  layerByName: Map<string, Layer>,
  supportedCrs: CrsCode[],
  maxWidth: number,
  maxHeight: number
): FeatureInfoRequest {
  const mapRequest = parseGetMap(params, layerByName, supportedCrs, maxWidth, maxHeight)
  const queryLayerNames = ServiceParams.require(params, 'QUERY_LAYERS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (queryLayerNames.length === 0) {
    throw new Error('QUERY_LAYERS must not be empty')
  }

  const mapLayerNames = new Set(mapRequest.layerNames)
  const layers = queryLayerNames.map((name) => {
    if (!mapLayerNames.has(name)) {
      throw new Error(`QUERY_LAYERS layer "${name}" must also be present in LAYERS`)
    }

    const layer = layerByName.get(name)
    if (!layer) {
      throw new Error(`Unknown query layer: ${name}`)
    }

    return layer
  })
  const i = parsePixelIndex(params.get('I') ?? params.get('X'), mapRequest.version === '1.3.0' ? 'I' : 'X', mapRequest.width)
  const j = parsePixelIndex(params.get('J') ?? params.get('Y'), mapRequest.version === '1.3.0' ? 'J' : 'Y', mapRequest.height)
  const featureCount = params.has('FEATURE_COUNT')
    ? parsePositiveInt(ServiceParams.require(params, 'FEATURE_COUNT'), 'FEATURE_COUNT', 100)
    : 1
  const tolerancePixels = params.has('BUFFER')
    ? parseNonNegativeInt(ServiceParams.require(params, 'BUFFER'), 'BUFFER', 50)
    : 4
  const infoFormat = normalizeInfoFormat(params.get('INFO_FORMAT'))

  return {
    layers,
    rawBbox: mapRequest.rawBbox,
    bbox: mapRequest.bbox,
    bboxOrder: mapRequest.bboxOrder,
    width: mapRequest.width,
    height: mapRequest.height,
    crs: mapRequest.crs,
    version: mapRequest.version,
    i,
    j,
    featureCount,
    tolerancePixels,
    infoFormat
  }
}

class WmsCapabilitiesBuilder {
  static async build(service: WmsInfo, layers: Layer[], path: string, crs: CrsCode[]): Promise<string> {
    const supportedCrs = unique(crs)
    const layerViews = []

    for (const layer of layers) {
      layerViews.push(await this.layerView(layer, supportedCrs))
    }

    return MarkupTemplate.render(WMS_CAPABILITIES_TEMPLATE, {
      version: WMS_VERSION,
      service,
      onlineResource: service.onlineResource ?? path,
      featureInfoFormats: FEATURE_INFO_FORMATS,
      crs: supportedCrs,
      layers: layerViews
    })
  }

  private static async layerView(layer: Layer, supportedCrs: CrsCode[]): Promise<Record<string, unknown>> {
    const extent = await layer.getExtent()

    return {
      name: layer.name,
      title: layer.title ?? layer.name,
      summary: layer.summary,
      crs: supportedCrs,
      styles: layer.styles.map((style) => ({
        name: style.name,
        title: style.title ?? style.name,
        summary: style.summary
      })),
      extent: extent ? this.extentView(extent, layer.sourceCrs, supportedCrs) : undefined
    }
  }

  private static extentView(bbox: BBox, sourceCrs: CrsCode, crs: CrsCode[]): Record<string, unknown> {
    const geographicBbox = sourceCrs === 'EPSG:4326'
      ? bbox
      : transformBBox(bbox, sourceCrs, 'EPSG:4326') ?? bbox
    const boundingBoxes = crs
      .map((code) => {
        const targetBbox = code === sourceCrs
          ? bbox
          : transformBBox(bbox, sourceCrs, code)
        if (!targetBbox) return null

        const axisBbox = toWmsBoundingBox(targetBbox, code, WMS_VERSION)
        return {
          crs: code,
          minx: axisBbox[0],
          miny: axisBbox[1],
          maxx: axisBbox[2],
          maxy: axisBbox[3]
        }
      })
      .filter((entry): entry is WmsBoundingBoxView => entry !== null)

    return {
      west: geographicBbox[0],
      east: geographicBbox[2],
      south: geographicBbox[1],
      north: geographicBbox[3],
      boundingBoxes
    }
  }
}

function transformBBox(bbox: BBox, sourceCrs: CrsCode, targetCrs: CrsCode): BBox | null {
  if (sourceCrs === targetCrs) return bbox

  const positions = [
    transformPosition([bbox[0], bbox[1]], sourceCrs, targetCrs),
    transformPosition([bbox[0], bbox[3]], sourceCrs, targetCrs),
    transformPosition([bbox[2], bbox[1]], sourceCrs, targetCrs),
    transformPosition([bbox[2], bbox[3]], sourceCrs, targetCrs)
  ]

  if (positions.some((position) => !position)) return null

  const points = positions as [number, number][]
  return [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1]))
  ]
}

function transformPosition(position: [number, number], sourceCrs: CrsCode, targetCrs: CrsCode): [number, number] | null {
  const x = position[0]
  const y = position[1]
  const [fromX, fromY] = sourceCrs === 'EPSG:4326' && targetCrs === 'EPSG:3857'
    ? [x, clamp(y, -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT)]
    : [x, y]

  try {
    return proj4(sourceCrs, targetCrs, [fromX, fromY]) as [number, number]
  } catch {
    return null
  }
}

function parseStyles(value: string | undefined, layerCount: number): Array<string | undefined> {
  if (value === undefined) {
    return Array.from({ length: layerCount }, () => undefined)
  }

  const styleNames = value.split(',').map((style) => style.trim())
  if (styleNames.length === 1 && styleNames[0] === '') {
    return Array.from({ length: layerCount }, () => undefined)
  }

  if (styleNames.length !== layerCount) {
    throw new Error('STYLES must include one entry per LAYERS entry')
  }

  return styleNames.map((style) => style || undefined)
}

function resolveLayerStyle(layer: Layer, styleName: string | undefined): StyleFn {
  return layer.resolveStyle(styleName)
}

function validateCrs(supportedCrs: CrsCode[], crs: CrsCode): void {
  if (supportedCrs.length > 0 && !supportedCrs.includes(crs)) {
    throw new Error(`CRS ${crs} is not supported by this service`)
  }
}

function parseBBox(value: string, crs: CrsCode, version: string): { bbox: BBox, order: 'xy' | 'yx' } {
  const parts = value.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid BBOX: ${value}`)
  }

  if (!usesLatLonAxisOrder(crs, version)) {
    const bbox: BBox = [parts[0], parts[1], parts[2], parts[3]]
    validateBBox(bbox, crs)
    return {
      bbox,
      order: 'xy'
    }
  }

  const bbox: BBox = [parts[1], parts[0], parts[3], parts[2]]
  validateBBox(bbox, crs)
  return {
    bbox,
    order: 'yx'
  }
}

function validateBBox(bbox: BBox, crs: CrsCode): void {
  const [minX, minY, maxX, maxY] = bbox

  if (!(minX < maxX) || !(minY < maxY)) {
    throw new Error(`Invalid BBOX for ${crs}: minimum bounds must be lower than maximum bounds`)
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
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

function parseWmsPixelRatio(params: Map<string, string>): number {
  const dpiValue = params.get('MAP_RESOLUTION')
    ?? params.get('DPI')
    ?? getFormatOptionsDpi(params.get('FORMAT_OPTIONS'))

  if (dpiValue === undefined) return 1

  const dpi = Number(dpiValue)
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new Error('WMS DPI must be a positive number')
  }

  return dpi / 90
}

function getFormatOptionsDpi(value: string | undefined): string | undefined {
  if (!value) return undefined

  return value.match(/(?:^|;)\s*dpi\s*:\s*([^;]+)/i)?.[1]?.trim()
}

function parseNonNegativeInt(value: string, name: string, maxValue: number): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  if (number > maxValue) {
    throw new Error(`${name} exceeds maximum value ${maxValue}`)
  }

  return number
}

function parsePixelIndex(value: string | undefined, name: string, size: number): number {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`)
  }

  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number >= size) {
    throw new Error(`${name} must be an integer pixel index between 0 and ${size - 1}`)
  }

  return number
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

function normalizeInfoFormat(value: string | undefined): FeatureInfoFormat {
  const format = (value ?? 'application/geo+json').toLowerCase()
  if (isFeatureInfoFormat(format)) return format

  throw new Error(`Unsupported INFO_FORMAT: ${value ?? ''}`)
}

function isFeatureInfoFormat(value: string): value is FeatureInfoFormat {
  return (FEATURE_INFO_FORMATS as readonly string[]).includes(value)
}

function formatFeatureInfo(
  result: Awaited<ReturnType<typeof getFeatureInfo>>,
  format: FeatureInfoFormat
): string {
  if (format === 'text/xml' || format === 'application/xml') {
    return featureInfoToXml(result)
  }

  return featureInfoToGeoJson(result)
}

function contentTypeForInfoFormat(format: FeatureInfoFormat): string {
  return `${format}; charset=utf-8`
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
  console.log(`[GetMap ${traceId}] CRS=${request.crs} VERSION=${request.version} ORDER=${request.bboxOrder} SIZE=${request.width}x${request.height} PIXEL_RATIO=${request.pixelRatio}`)
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
    `<ServiceException code="${escape(code)}">${escape(message)}</ServiceException>`,
    '</ServiceExceptionReport>'
  ].join('')

  ServiceHttp.sendText(res, 400, body, 'text/xml; charset=utf-8')
}
