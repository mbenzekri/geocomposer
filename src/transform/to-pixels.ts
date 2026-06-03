import { type Geometry, type Position, type BBox, transformPositionToPixels, transformPositionsToPixels } from '../core/geometry.js'

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

