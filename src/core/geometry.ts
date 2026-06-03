import { get as getProjection, getPointResolution } from 'ol/proj.js'

export type BBox = [number, number, number, number]

export type CrsCode = string

export const DEFAULT_DPI = 25.4 / 0.28
export const INCHES_PER_METER = 1000 / 25.4
export const METERS_PER_DEGREE = 111319.49079327358

export type Geometry =
  | Point
  | LineString
  | Polygon
  | MultiPoint
  | MultiLineString
  | MultiPolygon

export type Position = [number, number, ...number[]]

export type Point = {
  type: 'Point'
  coordinates: Position
}

export type LineString = {
  type: 'LineString'
  coordinates: Position[]
}

export type Polygon = {
  type: 'Polygon'
  coordinates: Position[][]
}

export type MultiPoint = {
  type: 'MultiPoint'
  coordinates: Position[]
}

export type MultiLineString = {
  type: 'MultiLineString'
  coordinates: Position[][]
}

export type MultiPolygon = {
  type: 'MultiPolygon'
  coordinates: Position[][][]
}

export type HitContext = {
  point: Position
  bbox: BBox
  tolerance: number
  toleranceX: number
  toleranceY: number
}

export function getGroundResolutionMeters(crs: CrsCode, bbox: BBox, resolution: number): number {
  const projection = getProjection(crs)
  if (projection) {
    const center: [number, number] = [
      (bbox[0] + bbox[2]) / 2,
      (bbox[1] + bbox[3]) / 2
    ]
    return getPointResolution(projection, resolution, center, 'm')
  }

  return crs.toUpperCase() === 'EPSG:4326'
    ? resolution * METERS_PER_DEGREE
    : resolution
}
