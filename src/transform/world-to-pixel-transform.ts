import type { BBox } from '../core/types.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import type { GeoGeometry } from '../geometry/geo-geometry.js'

export type PixelFeature = GeoFeature & {
  geometry: GeoGeometry | null
}

export class WorldToPixelTransform extends TransformStream<GeoFeature, PixelFeature> {
  constructor(options: {
    bbox: BBox
    width: number
    height: number
  }) {
    super({
      transform(feature, controller) {
        controller.enqueue({
          ...feature,
          geometry: transformGeometryToPixels(feature.geometry, options.bbox, options.width, options.height)
        })
      }
    })
  }
}

export function transformGeometryToPixels(
  geometry: GeoGeometry | null,
  bbox: BBox,
  width: number,
  height: number
): GeoGeometry | null {
  if (!geometry) return null

  switch (geometry.type) {
    case 'Point':
      return {
        type: 'Point',
        coordinates: worldToPixel(geometry.coordinates[0], geometry.coordinates[1], bbox, width, height)
      }

    case 'LineString':
      return {
        type: 'LineString',
        coordinates: transformFlatCoordinatesToPixels(geometry.coordinates, bbox, width, height)
      }

    case 'Polygon':
      return {
        type: 'Polygon',
        rings: geometry.rings.map((ring) => transformFlatCoordinatesToPixels(ring, bbox, width, height))
      }

    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: transformFlatCoordinatesToPixels(geometry.coordinates, bbox, width, height)
      }

    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        lines: geometry.lines.map((line) => transformFlatCoordinatesToPixels(line, bbox, width, height))
      }

    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        polygons: geometry.polygons.map((polygon) =>
          polygon.map((ring) => transformFlatCoordinatesToPixels(ring, bbox, width, height))
        )
      }
  }
}

export function worldToPixel(
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

export function transformFlatCoordinatesToPixels(
  coordinates: Float64Array,
  bbox: BBox,
  width: number,
  height: number
): Float64Array {
  const output = new Float64Array(coordinates.length)

  for (let i = 0; i < coordinates.length; i += 2) {
    const [x, y] = worldToPixel(coordinates[i], coordinates[i + 1], bbox, width, height)
    output[i] = x
    output[i + 1] = y
  }

  return output
}
