import type { BBox, CrsCode, Position } from '../core/geometry.js'
import { Dict, Registry } from '../core/tools.js'

const WEB_MERCATOR_HALF_WORLD = 20037508.342789244
const WMTS_PIXEL_SIZE_METERS = 0.00028
const WEB_MERCATOR_MAX_ZOOM = 30
const CRS84_METERS_PER_DEGREE = 6378137 * 2 * Math.PI / 360
const CRS84_MAX_ZOOM = 30

export type TileMatrixJson = {
  id?: string
  scaleDenominator: number
  cellSize?: number
  topLeftCorner: Position
  tileWidth: number
  tileHeight: number
  matrixWidth: number
  matrixHeight: number
}

export type TileMatrixSetJson = {
  title?: string
  crs: CrsCode
  supportedCrs?: string
  tileMatrices: TileMatrixJson[]
}

export type TileMatrix = {
  id: string
  zoom: number
  scaleDenominator: number
  cellSize: number
  topLeftCorner: readonly [number, number]
  tileWidth: number
  tileHeight: number
  matrixWidth: number
  matrixHeight: number
}

export class TileMatrixSet {
  static readonly registry = new Registry<TileMatrixSet>('TILE_MATRIX_SET')

  readonly id: string
  readonly title: string
  readonly crs: CrsCode
  readonly supportedCrs: string
  readonly matrices: readonly TileMatrix[]
  private readonly matrixByZoom = new Map<number, TileMatrix>()
  private readonly zoomByMatrixId = new Map<string, number>()

  constructor(id: string, entry: TileMatrixSetJson) {
    this.id = id
    this.title = entry.title ?? id
    this.crs = entry.crs
    this.supportedCrs = entry.supportedCrs ?? supportedCrsUri(entry.crs)
    this.matrices = entry.tileMatrices.map((matrix, index) => normalizeMatrix(matrix, index))
    this.validate()

    for (const matrix of this.matrices) {
      this.matrixByZoom.set(matrix.zoom, matrix)
      this.zoomByMatrixId.set(matrix.id, matrix.zoom)
      this.zoomByMatrixId.set(`${this.id}:${matrix.id}`, matrix.zoom)
    }
  }

  static build(entries: Dict<TileMatrixSetJson>): Registry<TileMatrixSet> {
    TileMatrixSet.registry.clear()
    for (const tileMatrixSet of builtinTileMatrixSets()) {
      TileMatrixSet.registry.set(tileMatrixSet.id, tileMatrixSet)
    }

    for (const [id, entry] of Object.entries(entries)) {
      TileMatrixSet.registry.set(id, new TileMatrixSet(id, entry))
    }

    return TileMatrixSet.registry
  }

  bbox(z: number, x: number, y: number): BBox {
    const matrix = this.matrix(z)
    const tileSpanX = matrix.tileWidth * matrix.cellSize
    const tileSpanY = matrix.tileHeight * matrix.cellSize
    const minX = matrix.topLeftCorner[0] + x * tileSpanX
    const maxX = minX + tileSpanX
    const maxY = matrix.topLeftCorner[1] - y * tileSpanY
    const minY = maxY - tileSpanY

    return [minX, minY, maxX, maxY]
  }

  matrix(z: number): TileMatrix {
    const matrix = this.matrixByZoom.get(z)
    if (!matrix) {
      throw new Error(`TileMatrixSet "${this.id}" has no matrix for zoom ${z}`)
    }

    return matrix
  }

  matrixId(z: number): string {
    return this.matrix(z).id
  }

  zoomFromMatrixId(value: string): number {
    const zoom = this.zoomByMatrixId.get(value)
    if (zoom === undefined) {
      throw new Error(`Unknown TILEMATRIX "${value}" for tileMatrixSet "${this.id}"`)
    }

    return zoom
  }

  validateCoord(z: number, x: number, y: number): void {
    const matrix = this.matrix(z)
    if (x < 0 || x >= matrix.matrixWidth || y < 0 || y >= matrix.matrixHeight) {
      throw new Error(`x and y must be within matrix "${matrix.id}" bounds: columns 0..${matrix.matrixWidth - 1}, rows 0..${matrix.matrixHeight - 1}`)
    }
  }

  private validate(): void {
    if (!this.id) {
      throw new Error('TileMatrixSet id must not be empty')
    }

    if (!this.crs) {
      throw new Error(`TileMatrixSet "${this.id}" must define crs`)
    }

    if (this.matrices.length === 0) {
      throw new Error(`TileMatrixSet "${this.id}" must define at least one tile matrix`)
    }

    const ids = new Set<string>()
    const zooms = new Set<number>()
    for (const matrix of this.matrices) {
      if (ids.has(matrix.id)) {
        throw new Error(`TileMatrixSet "${this.id}" has duplicate tile matrix id "${matrix.id}"`)
      }
      ids.add(matrix.id)

      if (zooms.has(matrix.zoom)) {
        throw new Error(`TileMatrixSet "${this.id}" has duplicate tile matrix zoom ${matrix.zoom}`)
      }
      zooms.add(matrix.zoom)
    }
  }
}

TileMatrixSet.build({})

export function getTileMatrixSet(name = 'WebMercatorQuad'): TileMatrixSet {
  if (!TileMatrixSet.registry.has(name)) {
    throw new Error(`Unknown tile matrix set "${name}"`)
  }

  return TileMatrixSet.registry.get(name)
}

export function tileMatrixSets(): TileMatrixSet[] {
  return TileMatrixSet.registry.all
}

function normalizeMatrix(entry: TileMatrixJson, zoom: number): TileMatrix {
  const topLeftCorner = normalizeTopLeftCorner(entry.topLeftCorner, zoom)
  const matrix: TileMatrix = {
    id: entry.id ?? String(zoom),
    zoom,
    scaleDenominator: entry.scaleDenominator,
    cellSize: entry.cellSize ?? entry.scaleDenominator * WMTS_PIXEL_SIZE_METERS,
    topLeftCorner,
    tileWidth: entry.tileWidth,
    tileHeight: entry.tileHeight,
    matrixWidth: entry.matrixWidth,
    matrixHeight: entry.matrixHeight
  }

  validatePositiveFinite(matrix.scaleDenominator, `TileMatrix "${matrix.id}" scaleDenominator`)
  validatePositiveFinite(matrix.cellSize, `TileMatrix "${matrix.id}" cellSize`)
  validatePositiveInteger(matrix.tileWidth, `TileMatrix "${matrix.id}" tileWidth`)
  validatePositiveInteger(matrix.tileHeight, `TileMatrix "${matrix.id}" tileHeight`)
  validatePositiveInteger(matrix.matrixWidth, `TileMatrix "${matrix.id}" matrixWidth`)
  validatePositiveInteger(matrix.matrixHeight, `TileMatrix "${matrix.id}" matrixHeight`)

  return matrix
}

function normalizeTopLeftCorner(value: Position, zoom: number): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`TileMatrix at zoom ${zoom} topLeftCorner must contain exactly two numbers`)
  }

  const [x, y] = value
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`TileMatrix at zoom ${zoom} topLeftCorner must contain finite numbers`)
  }

  return [x, y]
}

function validatePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function builtinTileMatrixSets(): TileMatrixSet[] {
  const webMercatorQuad = {
      title: 'Web Mercator Quad',
      crs: 'EPSG:3857',
      supportedCrs: 'urn:ogc:def:crs:EPSG::3857',
      tileMatrices: webMercatorQuadMatrices(WEB_MERCATOR_MAX_ZOOM)
    }

  return [
    new TileMatrixSet('WebMercatorQuad', webMercatorQuad),
    new TileMatrixSet('GoogleMapsCompatible', {
      ...webMercatorQuad,
      title: 'Google Maps Compatible'
    }),
    new TileMatrixSet('WorldCRS84Quad', {
      title: 'World CRS84 Quad',
      crs: 'CRS:84',
      supportedCrs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      tileMatrices: worldCrs84QuadMatrices(CRS84_MAX_ZOOM)
    })
  ]
}

function webMercatorQuadMatrices(maxZoom: number): TileMatrixJson[] {
  const matrices: TileMatrixJson[] = []
  const tileSize = 256

  for (let z = 0; z <= maxZoom; z += 1) {
    const matrixSize = 2 ** z
    const resolution = (WEB_MERCATOR_HALF_WORLD * 2) / (tileSize * matrixSize)
    matrices.push({
      id: String(z),
      scaleDenominator: resolution / WMTS_PIXEL_SIZE_METERS,
      cellSize: resolution,
      topLeftCorner: [-WEB_MERCATOR_HALF_WORLD, WEB_MERCATOR_HALF_WORLD],
      tileWidth: tileSize,
      tileHeight: tileSize,
      matrixWidth: matrixSize,
      matrixHeight: matrixSize
    })
  }

  return matrices
}

function worldCrs84QuadMatrices(maxZoom: number): TileMatrixJson[] {
  const matrices: TileMatrixJson[] = []
  const tileSize = 256

  for (let z = 0; z <= maxZoom; z += 1) {
    const matrixWidth = 2 ** (z + 1)
    const matrixHeight = 2 ** z
    const cellSize = 360 / (tileSize * matrixWidth)
    matrices.push({
      id: String(z),
      scaleDenominator: (cellSize * CRS84_METERS_PER_DEGREE) / WMTS_PIXEL_SIZE_METERS,
      cellSize,
      topLeftCorner: [-180, 90],
      tileWidth: tileSize,
      tileHeight: tileSize,
      matrixWidth,
      matrixHeight
    })
  }

  return matrices
}

function supportedCrsUri(crs: CrsCode): string {
  const match = crs.match(/^EPSG:(\d+)$/i)
  if (match) return `urn:ogc:def:crs:EPSG::${match[1]}`
  return crs
}
