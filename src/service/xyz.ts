import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { TLSSocket } from 'node:tls'
import type { BBox } from '../core/types.js'
import type { Layer } from '../layer/layer.js'
import { renderMap, type RenderLayer } from '../ogc/render-map.js'
import { Service } from './service.js'

const WEB_MERCATOR_HALF_WORLD = 20037508.342789244
const DEFAULT_TILE_SIZE = 256
const DEFAULT_MIN_ZOOM = 0
const DEFAULT_MAX_ZOOM = 22
const DEFAULT_MAX_SCALE_FACTOR = 4

export type XyzOptions = {
  path?: string
  tilesets: Array<{
    name: string
    title?: string
    summary?: string
    layers: Array<{
      layer: Layer
      style?: string
    }>
  }>
  tileSize?: number
  minZoom?: number
  maxZoom?: number
  maxScaleFactor?: number
  cacheControl?: string
  cache?: string
}

type Tileset = {
  name: string
  title?: string
  summary?: string
  layers: RenderLayer[]
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
  private readonly tileSize: number
  private readonly minZoom: number
  private readonly maxZoom: number
  private readonly maxScaleFactor: number
  private readonly tilesets: Tileset[]
  private readonly tilesetByName: Map<string, Tileset>
  private readonly layers: Layer[]
  private nextTraceId = 1

  constructor(private readonly options: XyzOptions) {
    super('xyz', options.path ?? '/tiles')

    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE
    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM
    this.maxScaleFactor = options.maxScaleFactor ?? DEFAULT_MAX_SCALE_FACTOR
    this.tilesets = options.tilesets.map((tileset) => ({
      name: tileset.name,
      title: tileset.title,
      summary: tileset.summary,
      layers: tileset.layers.map((entry) => ({
        layer: entry.layer,
        style: entry.layer.resolveStyle(entry.style)
      }))
    }))
    this.tilesetByName = new Map(this.tilesets.map((tileset) => [tileset.name, tileset]))
    this.layers = uniqueLayers(options.tilesets)

    validateXyzOptions(this.tileSize, this.minZoom, this.maxZoom, this.maxScaleFactor)
  }

  matches(pathname: string): boolean {
    return isPathMatch(pathname, this.path)
  }

  async open(): Promise<void> {
    for (const layer of this.layers) {
      await layer.open()
    }
  }

  async close(): Promise<void> {
    for (const layer of this.layers) {
      await layer.close()
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fullUrl = getRequestUrl(req)
    let tileTrace: { id: number, startedAt: number } | null = null

    try {
      setCorsHeaders(res)

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8')
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!this.matches(url.pathname)) {
        sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8')
        return
      }

      const traceId = this.nextTraceId
      this.nextTraceId += 1
      const startedAt = Date.now()
      tileTrace = { id: traceId, startedAt }
      logTileStart(traceId, req.method ?? 'GET', fullUrl)

      const tileRequest = parseTileRequest(url, {
        path: this.path,
        tilesetByName: this.tilesetByName,
        tileSize: this.tileSize,
        minZoom: this.minZoom,
        maxZoom: this.maxZoom,
        maxScaleFactor: this.maxScaleFactor
      })
      logTileParams(traceId, tileRequest)

      const cachedImage = this.options.cache
        ? await readCachedTile(this.options.cache, tileRequest)
        : null
      const image = cachedImage ?? await renderMap({
        layers: tileRequest.tileset.layers,
        bbox: tileRequest.bbox,
        width: tileRequest.width,
        height: tileRequest.height,
        crs: 'EPSG:3857',
        pixelRatio: tileRequest.scale
      })

      if (!cachedImage && this.options.cache) {
        await writeCachedTile(this.options.cache, tileRequest, image)
      }

      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', image.byteLength)
      if (this.options.cacheControl) {
        res.setHeader('Cache-Control', this.options.cacheControl)
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
      sendText(
        res,
        400,
        error instanceof Error ? error.message : String(error),
        'text/plain; charset=utf-8'
      )
    }
  }
}

export function xyzTileBBox(z: number, x: number, y: number): BBox {
  const tilesPerAxis = 2 ** z
  const tileSpan = (WEB_MERCATOR_HALF_WORLD * 2) / tilesPerAxis
  const minX = -WEB_MERCATOR_HALF_WORLD + x * tileSpan
  const maxX = minX + tileSpan
  const maxY = WEB_MERCATOR_HALF_WORLD - y * tileSpan
  const minY = maxY - tileSpan

  return [minX, minY, maxX, maxY]
}

function parseTileRequest(
  url: URL,
  options: {
    path: string
    tilesetByName: Map<string, Tileset>
    tileSize: number
    minZoom: number
    maxZoom: number
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

  const z = parseInteger(segments[1], 'z')
  const x = parseInteger(segments[2], 'x')
  const parsedY = parseYSegment(segments[3])
  const y = parsedY.y
  const scale = parseScale(url.searchParams.get('scale'), parsedY.scale, options.maxScaleFactor)

  validateTileCoord(z, x, y, options.minZoom, options.maxZoom)

  const pixelSize = Math.round(options.tileSize * scale)
  return {
    tileset,
    z,
    x,
    y,
    bbox: xyzTileBBox(z, x, y),
    width: pixelSize,
    height: pixelSize,
    scale
  }
}

function parseYSegment(segment: string): { y: number, scale?: number } {
  const match = segment.match(/^(\d+)(?:@([1-9]\d*)x)?(?:\.png)?$/i)
  if (!match) {
    throw new Error('y must be an integer tile coordinate, optionally ending with .png or @2x.png')
  }

  return {
    y: parseInteger(match[1], 'y'),
    scale: match[2] ? parseInteger(match[2], 'scale') : undefined
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

async function readCachedTile(cacheDir: string, request: TileRequest): Promise<Buffer | null> {
  try {
    return await readFile(tileCachePath(cacheDir, request))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function writeCachedTile(cacheDir: string, request: TileRequest, image: Buffer): Promise<void> {
  const path = tileCachePath(cacheDir, request)
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`

  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmpPath, image)

  try {
    await rename(tmpPath, path)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

function tileCachePath(cacheDir: string, request: TileRequest): string {
  const fileName = request.scale === 1
    ? `${request.y}.png`
    : `${request.y}@${encodeURIComponent(String(request.scale))}x.png`

  return join(
    cacheDir,
    encodeURIComponent(request.tileset.name),
    String(request.z),
    String(request.x),
    fileName
  )
}

function validateTileCoord(
  z: number,
  x: number,
  y: number,
  minZoom: number,
  maxZoom: number
): void {
  if (z < minZoom || z > maxZoom) {
    throw new Error(`z must be between ${minZoom} and ${maxZoom}`)
  }

  const tilesPerAxis = 2 ** z
  if (x < 0 || x >= tilesPerAxis || y < 0 || y >= tilesPerAxis) {
    throw new Error(`x and y must be between 0 and ${tilesPerAxis - 1} at z=${z}`)
  }
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  const number = Number(value)
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} is outside the safe integer range`)
  }

  return number
}

function validateXyzOptions(tileSize: number, minZoom: number, maxZoom: number, maxScaleFactor: number): void {
  if (!Number.isInteger(tileSize) || tileSize <= 0) {
    throw new Error('XYZ tileSize must be a positive integer')
  }

  if (!Number.isInteger(minZoom) || minZoom < 0) {
    throw new Error('XYZ minZoom must be a non-negative integer')
  }

  if (!Number.isInteger(maxZoom) || maxZoom < minZoom) {
    throw new Error('XYZ maxZoom must be an integer greater than or equal to minZoom')
  }

  if (!Number.isFinite(maxScaleFactor) || maxScaleFactor <= 0) {
    throw new Error('XYZ maxScaleFactor must be a positive number')
  }
}

function isPathMatch(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}

function pathSegmentsAfter(pathname: string, basePath: string): string[] {
  const suffix = pathname.slice(basePath.length)
  return suffix
    .split('/')
    .filter(Boolean)
}

function uniqueLayers(tilesets: XyzOptions['tilesets']): Layer[] {
  return [...new Set(tilesets.flatMap((tileset) => tileset.layers.map((entry) => entry.layer)))]
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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string, headOnly = false): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(headOnly ? undefined : body)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
