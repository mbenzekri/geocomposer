import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BBox, CrsCode } from '../core/geometry.js'
import type { DescInfo, ServiceInfo } from '../core/feature.js'
import { Crs } from '../core/crs.js'
import { Gt } from '../core/geotools.js'
import type { Props } from '../core/tools.js'
import { Layer } from '../layer/layer.js'
import { GeoJsonFeatureEncoder } from '../ogc/feature-api/geojson-feature-encoder.js'
import { LayerFeatureRepository } from '../ogc/feature-api/layer-feature-repository.js'
import { Service } from './service.js'

const DEFAULT_LIMIT = 100
const DEFAULT_MAX_LIMIT = 10_000
const DEFAULT_CRS = 'EPSG:4326'

export type OgcFeaturesJson = DescInfo & ServiceInfo & {
  layers?: string[]
  defaultLimit?: number
  maxLimit?: number
  supportedCrs?: string[]
}

type ItemsRequest = {
  layer: Layer
  bbox?: BBox
  bboxCrs: CrsCode
  crs: CrsCode
  properties?: string[]
  limit: number
  offset: number
}

type ItemRequest = {
  layer: Layer
  featureId: string
  crs: CrsCode
  properties?: string[]
}

type Link = {
  href: string
  rel: string
  type?: string
  title?: string
}

export class OgcFeatures extends Service {
  private readonly layerByName: Map<string, Layer>
  private readonly defaultLimit: number
  private readonly maxLimit: number
  private readonly supportedCrs: CrsCode[]
  private readonly repository = new LayerFeatureRepository()
  private nextTraceId = 1

  constructor(options: OgcFeaturesJson) {
    super('api', options.title, options.abstract, options.path ?? '/api', options.onlineResource)
    const layers = selectLayers(options.layers, 'API')
    const supportedCrs = options.supportedCrs
      ? options.supportedCrs.map((crs) => resolveCrs(crs, 'API supportedCrs'))
      : Crs.registry.all.map((entry) => entry.code)

    this.layerByName = new Map(layers.map((layer) => [layer.name, layer]))
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT
    this.maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT
    this.supportedCrs = supportedCrs.length
      ? [...new Set(supportedCrs)]
      : Crs.registry.all.map((entry) => entry.code)

    validateLimitConfig(this.defaultLimit, this.maxLimit)
  }

  static fromConfig(entry: OgcFeaturesJson): OgcFeatures {
    return new OgcFeatures(entry)
  }

  getLayers(): Layer[] {
    return [...this.layerByName.values()]
  }

  getSupportedCrs(): CrsCode[] {
    return [...this.supportedCrs]
  }

  matches(pathname: string): boolean {
    return pathname === this.path || pathname.startsWith(`${this.path}/`)
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fullUrl = Service.requestUrl(req)
    const traceId = this.nextTraceId
    const startedAt = Date.now()

    try {
      Service.setCorsHeaders(res)

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendJson(res, 405, { code: 'MethodNotAllowed', description: 'Method Not Allowed' }, req.method === 'HEAD')
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!this.matches(url.pathname)) {
        this.sendJson(res, 404, { code: 'NotFound', description: 'Not Found' }, req.method === 'HEAD')
        return
      }

      this.nextTraceId += 1
      this.logHandleStart(traceId, req.method ?? 'GET', fullUrl)

      await this.route(req, res, url)
      this.logHandleDone(traceId, res.statusCode, startedAt, 0)
    } catch (error) {
      this.logHandleError(traceId, fullUrl, startedAt, error)
      this.sendJson(
        res,
        error instanceof NotFoundError ? 404 : 400,
        {
          code: error instanceof NotFoundError ? 'NotFound' : 'InvalidParameterValue',
          description: error instanceof Error ? error.message : String(error)
        },
        req.method === 'HEAD'
      )
    }
  }

  logListening(baseUrl: string): void {
    console.log(`[API] landing page: ${baseUrl}${this.path}`)
    console.log(`[API] collections: ${baseUrl}${this.path}/collections`)
  }

  protected logHandleParams(traceId: number, request: ItemsRequest | ItemRequest): void {
    if ('featureId' in request) {
      console.debug(`[API ${traceId}] COLLECTION=${request.layer.name} FEATURE_ID=${request.featureId} CRS=${request.crs}`)
      return
    }

    console.debug(`[API ${traceId}] COLLECTION=${request.layer.name} LIMIT=${request.limit} OFFSET=${request.offset} CRS=${request.crs}`)
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const headOnly = req.method === 'HEAD'
    const segments = pathSegmentsAfter(url.pathname, this.path).map(decodeURIComponent)

    if (segments.length === 0) {
      this.sendJson(res, 200, this.landingPage(req), headOnly)
      return
    }

    if (segments.length === 1 && segments[0] === 'api') {
      this.sendJson(res, 200, this.openapi(req), headOnly)
      return
    }

    if (segments.length === 1 && segments[0] === 'conformance') {
      this.sendJson(res, 200, this.conformance(), headOnly)
      return
    }

    if (segments.length === 1 && segments[0] === 'collections') {
      this.sendJson(res, 200, await this.collections(req), headOnly)
      return
    }

    if (segments[0] !== 'collections') {
      throw new NotFoundError('Unknown API route')
    }

    if (segments.length === 2) {
      this.sendJson(res, 200, await this.collection(req, this.requireLayer(segments[1])), headOnly)
      return
    }

    if (segments.length === 3 && segments[2] === 'items') {
      const request = this.parseItemsRequest(this.requireLayer(segments[1]), url)
      this.logHandleParams(this.nextTraceId - 1, request)
      const page = await this.repository.queryPage(request.layer, {
        bbox: request.bbox,
        bboxCrs: request.bboxCrs,
        crs: request.crs,
        properties: request.properties,
        limit: request.limit,
        offset: request.offset
      })
      const encoder = new GeoJsonFeatureEncoder(request.properties)
      const body = encoder.collection(page.features, {
        timeStamp: new Date().toISOString(),
        links: this.itemCollectionLinks(req, request, page.nextOffset)
      })

      this.sendGeoJson(res, 200, body, request.crs, headOnly)
      return
    }

    if (segments.length === 4 && segments[2] === 'items') {
      const request = this.parseItemRequest(this.requireLayer(segments[1]), segments[3], url)
      this.logHandleParams(this.nextTraceId - 1, request)
      const feature = await this.repository.readById(request.layer, request.featureId, {
        crs: request.crs
      })

      if (!feature) throw new NotFoundError(`Feature "${request.featureId}" was not found in collection "${request.layer.name}"`)

      this.sendGeoJson(res, 200, new GeoJsonFeatureEncoder(request.properties).feature(feature), request.crs, headOnly)
      return
    }

    throw new NotFoundError('Unknown API route')
  }

  private landingPage(req: IncomingMessage): Props {
    return {
      title: this.title,
      description: this.abstract,
      links: [
        this.link(req, this.path, 'self', 'application/json', 'This document'),
        this.link(req, `${this.path}/api`, 'service-desc', 'application/vnd.oai.openapi+json;version=3.0', 'OpenAPI definition'),
        this.link(req, `${this.path}/conformance`, 'conformance', 'application/json', 'OGC API conformance classes'),
        this.link(req, `${this.path}/collections`, 'data', 'application/json', 'Collections')
      ]
    }
  }

  private conformance(): Props {
    return {
      conformsTo: [
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
        'http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs'
      ]
    }
  }

  private openapi(req: IncomingMessage): Props {
    const base = this.absoluteUrl(req, this.path)

    return {
      openapi: '3.0.3',
      info: {
        title: this.title,
        description: this.abstract,
        version: '1.0.0'
      },
      servers: [{ url: base }],
      paths: {
        '/': { get: { summary: 'Landing page', responses: { '200': { description: 'Landing page' } } } },
        '/conformance': { get: { summary: 'Conformance classes', responses: { '200': { description: 'Conformance classes' } } } },
        '/collections': { get: { summary: 'Collections', responses: { '200': { description: 'Collections' } } } },
        '/collections/{collectionId}': { get: { summary: 'Collection metadata', responses: { '200': { description: 'Collection metadata' } } } },
        '/collections/{collectionId}/items': { get: { summary: 'Collection items', responses: { '200': { description: 'Feature collection' } } } },
        '/collections/{collectionId}/items/{featureId}': { get: { summary: 'Feature by id', responses: { '200': { description: 'Feature' } } } }
      }
    }
  }

  private async collections(req: IncomingMessage): Promise<Props> {
    return {
      links: [
        this.link(req, `${this.path}/collections`, 'self', 'application/json', 'Collections')
      ],
      collections: await Promise.all(this.getLayers().map((layer) => this.collectionView(req, layer)))
    }
  }

  private async collection(req: IncomingMessage, layer: Layer): Promise<Props> {
    return this.collectionView(req, layer)
  }

  private async collectionView(req: IncomingMessage, layer: Layer): Promise<Props> {
    const extent = await layer.getExtent()
    const view: Props = {
      id: layer.name,
      title: layer.title ?? layer.name,
      description: layer.summary,
      itemType: 'feature',
      crs: this.supportedCrs.map(crsUri),
      storageCrs: crsUri(layer.crs),
      links: [
        this.link(req, `${this.path}/collections/${encodeURIComponent(layer.name)}`, 'self', 'application/json', 'Collection metadata'),
        this.link(req, `${this.path}/collections/${encodeURIComponent(layer.name)}/items`, 'items', 'application/geo+json', 'Collection items')
      ]
    }

    if (extent) {
      view.extent = {
        spatial: {
          bbox: [extent],
          crs: crsUri(layer.crs)
        }
      }
    }

    return view
  }

  private parseItemsRequest(layer: Layer, url: URL): ItemsRequest {
    const crs = this.parseCrs(url.searchParams.get('crs') ?? DEFAULT_CRS, 'crs')
    const bboxCrs = this.parseCrs(url.searchParams.get('bbox-crs') ?? crs, 'bbox-crs')
    const bbox = this.parseBBox(url.searchParams.get('bbox'), bboxCrs)
    const limit = this.parseLimit(url.searchParams.get('limit'))
    const offset = this.parseOffset(url.searchParams.get('offset'))

    return {
      layer,
      bbox,
      bboxCrs,
      crs,
      properties: parseProperties(url.searchParams.get('properties')),
      limit,
      offset
    }
  }

  private parseItemRequest(layer: Layer, featureId: string, url: URL): ItemRequest {
    return {
      layer,
      featureId,
      crs: this.parseCrs(url.searchParams.get('crs') ?? DEFAULT_CRS, 'crs'),
      properties: parseProperties(url.searchParams.get('properties'))
    }
  }

  private parseBBox(value: string | null, crs: CrsCode): BBox | undefined {
    if (!value) return undefined

    const values = value.split(',').map((entry) => Number(entry.trim()))
    if (values.length !== 4 || values.some((entry) => !Number.isFinite(entry))) {
      throw new Error('bbox must contain four comma-separated numbers')
    }

    return Gt.normalize([values[0], values[1], values[2], values[3]], `API bbox (${crs})`)
  }

  private parseLimit(value: string | null): number {
    if (value === null || value === '') return this.defaultLimit

    const limit = parseInteger(value, 'limit')
    if (limit < 1) throw new Error('limit must be a positive integer')
    if (limit > this.maxLimit) throw new Error(`limit exceeds maximum value ${this.maxLimit}`)
    return limit
  }

  private parseOffset(value: string | null): number {
    if (value === null || value === '') return 0

    const offset = parseInteger(value, 'offset')
    if (offset < 0) throw new Error('offset must be a non-negative integer')
    return offset
  }

  private parseCrs(value: string, name: string): CrsCode {
    const crs = normalizeCrsCode(value)
    if (!this.supportedCrs.includes(crs)) {
      throw new Error(`${name} ${value} is not supported by this service`)
    }

    return crs
  }

  private itemCollectionLinks(req: IncomingMessage, request: ItemsRequest, nextOffset: number | undefined): Link[] {
    const links = [
      this.link(req, this.itemsPath(request.layer), 'self', 'application/geo+json', 'This document', this.itemsSearchParams(request)),
      this.link(req, this.collectionPath(request.layer), 'collection', 'application/json', 'Collection metadata')
    ]

    if (nextOffset !== undefined) {
      links.push(this.link(
        req,
        this.itemsPath(request.layer),
        'next',
        'application/geo+json',
        'Next page',
        this.itemsSearchParams({ ...request, offset: nextOffset })
      ))
    }

    return links
  }

  private itemsSearchParams(request: ItemsRequest): URLSearchParams {
    const params = new URLSearchParams()
    params.set('limit', String(request.limit))
    params.set('offset', String(request.offset))
    if (request.crs !== DEFAULT_CRS) params.set('crs', request.crs)
    if (request.bbox) params.set('bbox', request.bbox.join(','))
    if (request.bbox && request.bboxCrs !== request.crs) params.set('bbox-crs', request.bboxCrs)
    if (request.properties?.length) params.set('properties', request.properties.join(','))
    return params
  }

  private collectionPath(layer: Layer): string {
    return `${this.path}/collections/${encodeURIComponent(layer.name)}`
  }

  private itemsPath(layer: Layer): string {
    return `${this.collectionPath(layer)}/items`
  }

  private requireLayer(name: string): Layer {
    const layer = this.layerByName.get(name)
    if (!layer) throw new NotFoundError(`Unknown collection: ${name}`)
    return layer
  }

  private link(
    req: IncomingMessage,
    path: string,
    rel: string,
    type?: string,
    title?: string,
    searchParams?: URLSearchParams
  ): Link {
    const url = new URL(this.absoluteUrl(req, path))
    if (searchParams) url.search = searchParams.toString()

    return {
      href: url.toString(),
      rel,
      type,
      title
    }
  }

  private absoluteUrl(req: IncomingMessage, path: string): string {
    return Service.serviceUrl(req, path)
  }

  private sendJson(res: ServerResponse, statusCode: number, body: Props, headOnly = false): void {
    Service.sendText(res, statusCode, JSON.stringify(body), 'application/json; charset=utf-8', headOnly)
  }

  private sendGeoJson(res: ServerResponse, statusCode: number, body: Props, crs: CrsCode, headOnly = false): void {
    res.setHeader('Content-Crs', `<${crsUri(crs)}>`)
    Service.sendText(res, statusCode, JSON.stringify(body), 'application/geo+json; charset=utf-8', headOnly)
  }
}

class NotFoundError extends Error {}

function selectLayers(layerNames: string[] | undefined, serviceName: string): Layer[] {
  if (!layerNames) return Layer.registry.all

  return layerNames.map((name) => {
    if (Layer.registry.has(name)) return Layer.registry.get(name)
    throw new Error(`Unknown layer "${name}" in ${serviceName} service`)
  })
}

function resolveCrs(crs: string, label: string): CrsCode {
  const code = normalizeCrsCode(crs)
  if (!Crs.registry.has(code)) {
    throw new Error(`${label} "${crs}" is not declared in projections`)
  }

  return Crs.registry.get(code).code
}

function normalizeCrsCode(value: string): CrsCode {
  if (value.startsWith('http://www.opengis.net/def/crs/EPSG/0/')) {
    return `EPSG:${value.slice('http://www.opengis.net/def/crs/EPSG/0/'.length)}`
  }

  if (value.startsWith('http://www.opengis.net/def/crs/OGC/1.3/CRS84')) {
    return DEFAULT_CRS
  }

  return value
}

function crsUri(crs: CrsCode): string {
  const match = crs.match(/^EPSG:(\d+)$/i)
  if (match) return `http://www.opengis.net/def/crs/EPSG/0/${match[1]}`
  return crs
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is outside the safe integer range`)
  }

  return parsed
}

function parseProperties(value: string | null): string[] | undefined {
  if (!value) return undefined

  const properties = value
    .split(',')
    .map((property) => property.trim())
    .filter(Boolean)

  return properties.length > 0 ? properties : undefined
}

function pathSegmentsAfter(pathname: string, basePath: string): string[] {
  const suffix = pathname.slice(basePath.length)
  return suffix
    .split('/')
    .filter(Boolean)
}

function validateLimitConfig(defaultLimit: number, maxLimit: number): void {
  if (!Number.isInteger(defaultLimit) || defaultLimit < 1) {
    throw new Error('API defaultLimit must be a positive integer')
  }

  if (!Number.isInteger(maxLimit) || maxLimit < 1) {
    throw new Error('API maxLimit must be a positive integer')
  }

  if (defaultLimit > maxLimit) {
    throw new Error('API defaultLimit must be lower than or equal to maxLimit')
  }
}
