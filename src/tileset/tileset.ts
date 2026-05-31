import type { CrsCode, BBox } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { StyleFn } from '../style/style-fn.js'
import { getTileMatrixSet, type TileMatrixSet } from './tile-matrix-set.js'

const DEFAULT_FORMAT = 'image/png'
const DEFAULT_TILE_SIZE = 256
const DEFAULT_MIN_ZOOM = 0
const DEFAULT_MAX_ZOOM = 22

export type TilesetOptions = {
  name: string
  title?: string
  summary?: string
  tileMatrixSet?: string
  format?: string
  tileSize?: number
  minZoom?: number
  maxZoom?: number
  cacheControl?: string
  layers: Layer[]
  styles: string[]
}

export class Tileset {
  readonly name: string
  readonly title?: string
  readonly summary?: string
  readonly tileMatrixSet: TileMatrixSet
  readonly format: string
  readonly tileSize: number
  readonly minZoom: number
  readonly maxZoom: number
  readonly cacheControl?: string
  readonly layers: Layer[]
  readonly styles: StyleFn[]

  constructor(options: TilesetOptions) {
    this.name = options.name
    this.title = options.title
    this.summary = options.summary
    this.tileMatrixSet = getTileMatrixSet(options.tileMatrixSet)
    this.format = options.format ?? DEFAULT_FORMAT
    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE
    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM
    this.cacheControl = options.cacheControl
    this.layers = options.layers
    this.styles = options.styles.map((stylename,index) => this.layers[index].resolveStyle(stylename))
    this.validate()
  }

  get crs(): CrsCode {
    return this.tileMatrixSet.crs
  }

  bbox(z: number, x: number, y: number): BBox {
    this.validateCoord(z, x, y)
    return this.tileMatrixSet.bbox(z, x, y)
  }

  validateCoord(z: number, x: number, y: number): void {
    if (z < this.minZoom || z > this.maxZoom) {
      throw new Error(`z must be between ${this.minZoom} and ${this.maxZoom}`)
    }

    const tilesPerAxis = 2 ** z
    if (x < 0 || x >= tilesPerAxis || y < 0 || y >= tilesPerAxis) {
      throw new Error(`x and y must be between 0 and ${tilesPerAxis - 1} at z=${z}`)
    }
  }

  zoomFromMatrixId(value: string): number {
    return this.tileMatrixSet.zoomFromMatrixId(value)
  }

  private validate(): void {
    if (!this.name) {
      throw new Error('Tileset name must not be empty')
    }

    if (this.format !== DEFAULT_FORMAT) {
      throw new Error(`Tileset "${this.name}" format must be ${DEFAULT_FORMAT}`)
    }

    if (!Number.isInteger(this.tileSize) || this.tileSize <= 0) {
      throw new Error(`Tileset "${this.name}" tileSize must be a positive integer`)
    }

    if (!Number.isInteger(this.minZoom) || this.minZoom < 0) {
      throw new Error(`Tileset "${this.name}" minZoom must be a non-negative integer`)
    }

    if (!Number.isInteger(this.maxZoom) || this.maxZoom < this.minZoom) {
      throw new Error(`Tileset "${this.name}" maxZoom must be an integer greater than or equal to minZoom`)
    }

    if (this.layers.length === 0) {
      throw new Error(`Tileset "${this.name}" must reference at least one configured layer`)
    }
  }
}
