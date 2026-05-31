import proj4 from 'proj4'
import type { BBox, Geometry, HitContext, Position } from './geometry.js'
import { Feature } from './feature.js'

const WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066

export class Gt {
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
            return Gt.distance(point, start)
        }

        const t = Gt.clamp(
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy),
            0,
            1
        )
        const projected: Position = [
            start[0] + t * dx,
            start[1] + t * dy
        ]

        return Gt.distance(point, projected)
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
                return Gt.of(geometry.coordinates)

            case 'Polygon':
                return Gt.ofMany(geometry.coordinates)

            case 'MultiPoint':
                return Gt.of(geometry.coordinates)

            case 'MultiLineString':
                return Gt.ofMany(geometry.coordinates)

            case 'MultiPolygon': {
                let bbox: BBox | null = null

                for (const polygon of geometry.coordinates) {
                    const polygonBBox = Gt.ofMany(polygon)
                    if (polygonBBox) bbox = bbox ? Gt.expand(bbox, polygonBBox) : polygonBBox
                }

                return bbox
            }
        }
    }

    private static ofMany(items: Position[][]): BBox | null {
        let bbox: BBox | null = null

        for (const item of items) {
            const itemBBox = Gt.of(item)
            if (itemBBox) bbox = bbox ? Gt.expand(bbox, itemBBox) : itemBBox
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

    static clamp(value: number, min: number, max: number): number {
        return Math.min(max, Math.max(min, value))
    }

    static featureHitsPoint(feature: Feature, context: HitContext): boolean {
        if (!feature.geometry) return false

        const bbox = feature.bbox ?? Gt.bbox(feature.geometry)
        if (bbox && !Gt.intersects(bbox, context.bbox)) return false

        return Gt.geometryHitsPoint(feature.geometry, context)
    }

    static geometryHitsPoint(geometry: Geometry, context: HitContext): boolean {
        switch (geometry.type) {
            case 'Point':
                return Gt.positionHitsPoint(geometry.coordinates, context)

            case 'MultiPoint':
                return geometry.coordinates.some((position) => Gt.positionHitsPoint(position, context))

            case 'LineString':
                return Gt.lineHitsPoint(geometry.coordinates, context)

            case 'MultiLineString':
                return geometry.coordinates.some((line) => Gt.lineHitsPoint(line, context))

            case 'Polygon':
                return Gt.polygonHitsPoint(geometry.coordinates, context)

            case 'MultiPolygon':
                return geometry.coordinates.some((polygon) => Gt.polygonHitsPoint(polygon, context))
        }
    }

    static positionHitsPoint(position: Position, context: HitContext): boolean {
        return Math.abs(position[0] - context.point[0]) <= context.toleranceX
            && Math.abs(position[1] - context.point[1]) <= context.toleranceY
    }

    static lineHitsPoint(line: Position[], context: HitContext): boolean {
        if (line.length === 0) return false
        if (line.length === 1) return Gt.positionHitsPoint(line[0], context)

        for (let index = 1; index < line.length; index += 1) {
            if (Gt.distanceToSegment(context.point, line[index - 1], line[index]) <= context.tolerance) {
                return true
            }
        }

        return false
    }

    static polygonHitsPoint(polygon: Position[][], context: HitContext): boolean {
        if (polygon.length === 0) return false

        if (Gt.lineHitsPoint(polygon[0], context)) return true
        if (!Gt.pointInRing(context.point, polygon[0])) return false

        for (const hole of polygon.slice(1)) {
            if (Gt.lineHitsPoint(hole, context)) return true
            if (Gt.pointInRing(context.point, hole)) return false
        }

        return true
    }

    static transformGeometry(geometry: Geometry, sourceCrs: string, targetCrs: string): Geometry {
        switch (geometry.type) {
            case 'Point':
                return {
                    type: 'Point',
                    coordinates: Gt.transformPosition(geometry.coordinates, sourceCrs, targetCrs)
                }

            case 'LineString':
                return {
                    type: 'LineString',
                    coordinates: geometry.coordinates.map((position) =>
                        Gt.transformPosition(position, sourceCrs, targetCrs)
                    )
                }

            case 'Polygon':
                return {
                    type: 'Polygon',
                    coordinates: geometry.coordinates.map((ring) =>
                        ring.map((position) => Gt.transformPosition(position, sourceCrs, targetCrs))
                    )
                }

            case 'MultiPoint':
                return {
                    type: 'MultiPoint',
                    coordinates: geometry.coordinates.map((position) =>
                        Gt.transformPosition(position, sourceCrs, targetCrs)
                    )
                }

            case 'MultiLineString':
                return {
                    type: 'MultiLineString',
                    coordinates: geometry.coordinates.map((line) =>
                        line.map((position) => Gt.transformPosition(position, sourceCrs, targetCrs))
                    )
                }

            case 'MultiPolygon':
                return {
                    type: 'MultiPolygon',
                    coordinates: geometry.coordinates.map((polygon) =>
                        polygon.map((ring) =>
                            ring.map((position) => Gt.transformPosition(position, sourceCrs, targetCrs))
                        )
                    )
                }
        }
    }

    static transformPosition(position: Position, sourceCrs: string, targetCrs: string): Position {
        const x = position[0]
        const y = position[1]
        const [fromX, fromY] = sourceCrs === 'EPSG:4326' && targetCrs === 'EPSG:3857'
            ? [x, Gt.clamp(y, -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT)]
            : [x, y]

        let projected: [number, number]

        try {
            projected = proj4(sourceCrs, targetCrs, [fromX, fromY]) as [number, number]
        } catch (error) {
            throw new Error(`Unable to transform coordinates from ${sourceCrs} to ${targetCrs}: ${String(error)}`)
        }

        return position.length > 2 ? [projected[0], projected[1], ...position.slice(2)] : projected
    }
    static transformLabelPosition(
        properties: Feature['properties'],
        label_x: string,
        label_y: string,
        sourceCrs: string,
        targetCrs: string
    ): Feature['properties'] {
    if (!properties) return properties

    const x_src = Number(properties[label_x])
    const y_src = Number(properties[label_y])
    if (!Number.isFinite(x_src) || !Number.isFinite(y_src)) return properties

    const [x, y] = Gt.transformPosition([x_src, y_src], sourceCrs, targetCrs)
    const projected = { ...properties }
    projected[label_x] = x
    projected[label_y] = y
    return projected
}

}
