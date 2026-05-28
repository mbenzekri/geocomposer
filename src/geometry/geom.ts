import type { BBox } from '../core/types.js'
import type { Geometry, Position } from './geometry.js'

export class Geom {
    private constructor() { }

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
    
    static normalize(extent: BBox | undefined, layerName: string): BBox | undefined {
        if (extent === undefined) return undefined

        if (!Array.isArray(extent) || extent.length !== 4 || extent.some((value) => !Number.isFinite(value))) {
            throw new Error(`Layer "${layerName}" extent must be a bbox [minx,miny,maxx,maxy]`)
        }

        const bbox: BBox = [extent[0], extent[1], extent[2], extent[3]]
        if (!(bbox[0] < bbox[2]) || !(bbox[1] < bbox[3])) {
            throw new Error(`Layer "${layerName}" extent bbox minimum bounds must be lower than maximum bounds`)
        }

        return bbox
    }

    static distance(a: Position, b: Position): number {
        return Math.hypot(a[0] - b[0], a[1] - b[1])
    }

    static distanceToSegment(point: Position, start: Position, end: Position): number {
        const dx = end[0] - start[0]
        const dy = end[1] - start[1]

        if (dx === 0 && dy === 0) {
            return Geom.distance(point, start)
        }

        const t = Geom.clamp(
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy),
            0,
            1
        )
        const projected: Position = [
            start[0] + t * dx,
            start[1] + t * dy
        ]

        return Geom.distance(point, projected)
    }

    static pointInRing(point: Position, ring: Position[]): boolean {
        let inside = false

        for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
            const currentPosition = ring[index]
            const previousPosition = ring[previous]
            const intersects = (currentPosition[1] > point[1]) !== (previousPosition[1] > point[1])
                && point[0] < ((previousPosition[0] - currentPosition[0]) * (point[1] - currentPosition[1]))
                / (previousPosition[1] - currentPosition[1]) + currentPosition[0]

            if (intersects) inside = !inside
        }

        return inside
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

    private static clamp(value: number, min: number, max: number): number {
        return Math.min(max, Math.max(min, value))
    }
}
