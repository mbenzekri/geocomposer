import type { BBox, CrsCode } from '../core/geometry.js'

const WEB_MERCATOR_HALF_WORLD = 20037508.342789244
const WMTS_PIXEL_SIZE_METERS = 0.00028

export type TileMatrix = {
  id: string
  zoom: number
  scaleDenominator: number
  topLeftCorner: readonly [number, number]
  tileWidth: number
  tileHeight: number
  matrixWidth: number
  matrixHeight: number
}

export type TileMatrixSetOptions = {
  id: string
  title: string
  crs: CrsCode
  supportedCrs: string
  halfWorld: number
}

export class TileMatrixSet {
  readonly topLeftCorner: readonly [number, number]

  constructor(private readonly options: TileMatrixSetOptions) {
    this.topLeftCorner = [-options.halfWorld, options.halfWorld]
  }

  get id(): string {
    return this.options.id
  }

  get title(): string {
    return this.options.title
  }

  get crs(): CrsCode {
    return this.options.crs
  }

  get supportedCrs(): string {
    return this.options.supportedCrs
  }

  bbox(z: number, x: number, y: number): BBox {
    const tilesPerAxis = 2 ** z
    const tileSpan = (this.options.halfWorld * 2) / tilesPerAxis
    const minX = -this.options.halfWorld + x * tileSpan
    const maxX = minX + tileSpan
    const maxY = this.options.halfWorld - y * tileSpan
    const minY = maxY - tileSpan

    return [minX, minY, maxX, maxY]
  }

  matrix(z: number, tileSize: number): TileMatrix {
    const matrixSize = 2 ** z
    const resolution = (this.options.halfWorld * 2) / (tileSize * matrixSize)

    return {
      id: this.matrixId(z),
      zoom: z,
      scaleDenominator: resolution / WMTS_PIXEL_SIZE_METERS,
      topLeftCorner: this.topLeftCorner,
      tileWidth: tileSize,
      tileHeight: tileSize,
      matrixWidth: matrixSize,
      matrixHeight: matrixSize
    }
  }

  matrixId(z: number): string {
    return String(z)
  }

  zoomFromMatrixId(value: string): number {
    const raw = value.startsWith(`${this.id}:`)
      ? value.slice(this.id.length + 1)
      : value

    return parseInteger(raw, 'TILEMATRIX')
  }
}

const TILE_MATRIX_SETS = new Map<string, TileMatrixSet>([
  [
    'WebMercatorQuad',
    new TileMatrixSet({
      id: 'WebMercatorQuad',
      title: 'Web Mercator Quad',
      crs: 'EPSG:3857',
      supportedCrs: 'urn:ogc:def:crs:EPSG::3857',
      halfWorld: WEB_MERCATOR_HALF_WORLD
    })
  ]
])

export function getTileMatrixSet(name = 'WebMercatorQuad'): TileMatrixSet {
  const tileMatrixSet = TILE_MATRIX_SETS.get(name)
  if (!tileMatrixSet) {
    throw new Error(`Unknown tile matrix set "${name}"`)
  }

  return tileMatrixSet
}

export function tileMatrixSets(): TileMatrixSet[] {
  return [...TILE_MATRIX_SETS.values()]
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
