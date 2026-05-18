import type { BBox } from '../core/types.js'
import type { Geometry, Position } from './geometry.js'

export class Geom {
  private constructor() {}

  static intersects(a: BBox, b: BBox): boolean {
    return a[0] <= b[2]
      && a[2] >= b[0]
      && a[1] <= b[3]
      && a[3] >= b[1]
  }

  static expand(a: BBox, b: BBox): BBox {
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3])
    ]
  }

  static bbox(geometry: Geometry | null): BBox | null {
    if (!geometry) return null

    switch (geometry.type) {
      case 'Point': {
        const [x, y] = geometry.coordinates
        return [x, y, x, y]
      }

      case 'LineString':
        return Geom.of(geometry.coordinates)

      case 'Polygon':
        return Geom.ofMany(geometry.coordinates)

      case 'MultiPoint':
        return Geom.of(geometry.coordinates)

      case 'MultiLineString':
        return Geom.ofMany(geometry.coordinates)

      case 'MultiPolygon': {
        let bbox: BBox | null = null

        for (const polygon of geometry.coordinates) {
          const polygonBBox = Geom.ofMany(polygon)
          if (polygonBBox) bbox = bbox ? Geom.expand(bbox, polygonBBox) : polygonBBox
        }

        return bbox
      }
    }
  }

  private static ofMany(items: Position[][]): BBox | null {
    let bbox: BBox | null = null

    for (const item of items) {
      const itemBBox = Geom.of(item)
      if (itemBBox) bbox = bbox ? Geom.expand(bbox, itemBBox) : itemBBox
    }

    return bbox
  }

  private static of(coordinates: Position[]): BBox | null {
    if (coordinates.length === 0) return null

    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    for (const position of coordinates) {
      const x = position[0]
      const y = position[1]

      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }

    return [minX, minY, maxX, maxY]
  }
}
