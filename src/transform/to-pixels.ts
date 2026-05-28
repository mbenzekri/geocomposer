import type { BBox } from '../core/types.js'
import type { Geometry, Position } from '../core/geometry.js'

export function toPixels(
  geometry: Geometry | null,
  bbox: BBox,
  width: number,
  height: number
): Geometry | null {
  if (!geometry) return null

  switch (geometry.type) {
    case 'Point':
      return {
        type: 'Point',
        coordinates: transformPositionToPixels(geometry.coordinates, bbox, width, height)
      }

    case 'LineString':
      return {
        type: 'LineString',
        coordinates: transformPositionsToPixels(geometry.coordinates, bbox, width, height)
      }

    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) => transformPositionsToPixels(ring, bbox, width, height))
      }

    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: transformPositionsToPixels(geometry.coordinates, bbox, width, height)
      }

    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line) => transformPositionsToPixels(line, bbox, width, height))
      }

    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => transformPositionsToPixels(ring, bbox, width, height))
        )
      }
  }
}

export function coordinateToPixel(
  x: number,
  y: number,
  bbox: BBox,
  width: number,
  height: number
): [number, number] {
  const [minX, minY, maxX, maxY] = bbox

  return [
    ((x - minX) / (maxX - minX)) * width,
    height - ((y - minY) / (maxY - minY)) * height
  ]
}

export function transformPositionToPixels(
  position: Position,
  bbox: BBox,
  width: number,
  height: number
): Position {
  const [x, y] = coordinateToPixel(position[0], position[1], bbox, width, height)
  return position.length > 2 ? [x, y, ...position.slice(2)] : [x, y]
}

export function transformPositionsToPixels(
  coordinates: Position[],
  bbox: BBox,
  width: number,
  height: number
): Position[] {
  return coordinates.map((position) => transformPositionToPixels(position, bbox, width, height))
}
