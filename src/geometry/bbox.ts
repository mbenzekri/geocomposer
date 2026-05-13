import type { BBox } from '../core/types.js'
import type { GeoGeometry } from './geo-geometry.js'

export function intersectsBBox(a: BBox, b: BBox): boolean {
  return a[0] <= b[2]
    && a[2] >= b[0]
    && a[1] <= b[3]
    && a[3] >= b[1]
}

export function expandBBox(a: BBox, b: BBox): BBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3])
  ]
}

export function computeGeometryBBox(geometry: GeoGeometry | null): BBox | null {
  if (!geometry) return null

  switch (geometry.type) {
    case 'Point': {
      const [x, y] = geometry.coordinates
      return [x, y, x, y]
    }

    case 'LineString':
      return computeFlatBBox(geometry.coordinates)

    case 'Polygon':
      return computeFlatCollectionBBox(geometry.rings)

    case 'MultiPoint':
      return computeFlatBBox(geometry.coordinates)

    case 'MultiLineString':
      return computeFlatCollectionBBox(geometry.lines)

    case 'MultiPolygon': {
      let bbox: BBox | null = null

      for (const polygon of geometry.polygons) {
        const polygonBBox = computeFlatCollectionBBox(polygon)
        if (polygonBBox) bbox = bbox ? expandBBox(bbox, polygonBBox) : polygonBBox
      }

      return bbox
    }
  }
}

export function computeFlatCollectionBBox(items: Float64Array[]): BBox | null {
  let bbox: BBox | null = null

  for (const item of items) {
    const itemBBox = computeFlatBBox(item)
    bbox = bbox ? expandBBox(bbox, itemBBox) : itemBBox
  }

  return bbox
}

export function computeFlatBBox(coordinates: Float64Array): BBox {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (let i = 0; i < coordinates.length; i += 2) {
    const x = coordinates[i]
    const y = coordinates[i + 1]

    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  return [minX, minY, maxX, maxY]
}
