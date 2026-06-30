import proj4 from 'proj4'
import type { Converter } from 'proj4'
import { get as getProjection } from 'ol/proj.js'
import type { BBox, CrsCode, Geometry, HitContext, Position } from './geometry.js'
import { Feature } from './feature.js'

type ProjectionDomain = {
    extent: BBox
    wrapsX: boolean
}

export class CoordinateTransformer {
    private readonly converter: Converter
    private readonly constrainX: boolean
    private readonly constrainY: boolean
    private readonly targetDomain: BBox | null

    constructor(
        private readonly sourceCrs: string,
        private readonly targetCrs: string,
        sourceDomain: ProjectionDomain | null,
        targetDomain: BBox | null
    ) {
        try {
            this.converter = proj4(sourceCrs, targetCrs)
        } catch (error) {
            throw new Error(`Unable to transform coordinates from ${sourceCrs} to ${targetCrs}: ${String(error)}`)
        }

        this.targetDomain = sourceDomain && targetDomain ? targetDomain : null
        this.constrainX = false
        this.constrainY = false

        if (sourceDomain && targetDomain) {
            const sourceWidth = sourceDomain.extent[2] - sourceDomain.extent[0]
            const sourceHeight = sourceDomain.extent[3] - sourceDomain.extent[1]
            const targetWidth = targetDomain[2] - targetDomain[0]
            const targetHeight = targetDomain[3] - targetDomain[1]
            this.constrainX = targetWidth < sourceWidth
            this.constrainY = targetHeight < sourceHeight
        }
    }

    transformPosition(position: Position): Position {
        const [fromX, fromY] = this.constrainPosition(position)
        const projected = this.transformRaw([fromX, fromY])

        return position.length > 2 ? [projected[0], projected[1], ...position.slice(2)] : projected
    }

    transformGeometry(geometry: Geometry): Geometry {
        switch (geometry.type) {
            case 'Point':
                return {
                    type: 'Point',
                    coordinates: this.transformPosition(geometry.coordinates)
                }

            case 'LineString':
                return {
                    type: 'LineString',
                    coordinates: geometry.coordinates.map((position) => this.transformPosition(position))
                }

            case 'Polygon':
                return {
                    type: 'Polygon',
                    coordinates: geometry.coordinates.map((ring) =>
                        ring.map((position) => this.transformPosition(position))
                    )
                }

            case 'MultiPoint':
                return {
                    type: 'MultiPoint',
                    coordinates: geometry.coordinates.map((position) => this.transformPosition(position))
                }

            case 'MultiLineString':
                return {
                    type: 'MultiLineString',
                    coordinates: geometry.coordinates.map((line) =>
                        line.map((position) => this.transformPosition(position))
                    )
                }

            case 'MultiPolygon':
                return {
                    type: 'MultiPolygon',
                    coordinates: geometry.coordinates.map((polygon) =>
                        polygon.map((ring) =>
                            ring.map((position) => this.transformPosition(position))
                        )
                    )
                }
        }
    }

    transformLabelPosition(
        properties: Feature['properties'],
        label_x: string,
        label_y: string
    ): Feature['properties'] {
        if (!properties) return properties

        const x_src = Number(properties[label_x])
        const y_src = Number(properties[label_y])
        if (!Number.isFinite(x_src) || !Number.isFinite(y_src)) return properties

        const [x, y] = this.transformPosition([x_src, y_src])
        const projected = { ...properties }
        projected[label_x] = x
        projected[label_y] = y
        return projected
    }

    private constrainPosition(position: Position): [number, number] {
        if (!this.targetDomain) return [position[0], position[1]]

        return [
            this.constrainX ? Gt.clamp(position[0], this.targetDomain[0], this.targetDomain[2]) : position[0],
            this.constrainY ? Gt.clamp(position[1], this.targetDomain[1], this.targetDomain[3]) : position[1]
        ]
    }

    private transformRaw(position: [number, number]): [number, number] {
        try {
            return this.converter.forward(position) as [number, number]
        } catch (error) {
            throw new Error(`Unable to transform coordinates from ${this.sourceCrs} to ${this.targetCrs}: ${String(error)}`)
        }
    }
}

export abstract class Gt {
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

    static transformBBox(bbox: BBox, sourceCrs: string, targetCrs: string): BBox {
        const sourceConstrained = Gt.constrainBBoxToProjectionDomain(bbox, sourceCrs)
        const targetConstrained = Gt.constrainBBoxToTargetDomain(sourceConstrained, sourceCrs, targetCrs)
        return Gt.transformBBoxRaw(targetConstrained, sourceCrs, targetCrs)
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
        return Gt.createCoordinateTransformer(sourceCrs, targetCrs).transformGeometry(geometry)
    }

    static transformPosition(position: Position, sourceCrs: string, targetCrs: string): Position {
        return Gt.createCoordinateTransformer(sourceCrs, targetCrs).transformPosition(position)
    }

    static createCoordinateTransformer(sourceCrs: string, targetCrs: string): CoordinateTransformer {
        return new CoordinateTransformer(
            sourceCrs,
            targetCrs,
            Gt.projectionDomain(sourceCrs),
            Gt.targetDomainInSourceCrs(sourceCrs, targetCrs)
        )
    }

    private static transformBBoxRaw(bbox: BBox, sourceCrs: string, targetCrs: string): BBox {
        const positions = [
            Gt.transformPositionRaw([bbox[0], bbox[1]], sourceCrs, targetCrs),
            Gt.transformPositionRaw([bbox[0], bbox[3]], sourceCrs, targetCrs),
            Gt.transformPositionRaw([bbox[2], bbox[1]], sourceCrs, targetCrs),
            Gt.transformPositionRaw([bbox[2], bbox[3]], sourceCrs, targetCrs)
        ]
        const xs = positions.map((position) => position[0])
        const ys = positions.map((position) => position[1])

        return [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys)
        ]
    }

    private static transformPositionRaw(position: [number, number], sourceCrs: string, targetCrs: string): [number, number] {
        try {
            return proj4(sourceCrs, targetCrs, position) as [number, number]
        } catch (error) {
            throw new Error(`Unable to transform coordinates from ${sourceCrs} to ${targetCrs}: ${String(error)}`)
        }
    }

    private static constrainBBoxToProjectionDomain(bbox: BBox, crs: string): BBox {
        const domain = Gt.projectionDomain(crs)
        if (!domain) return bbox

        const [minX, maxX] = domain.wrapsX
            ? Gt.constrainWrappedRange(bbox[0], bbox[2], domain.extent[0], domain.extent[2])
            : [
                Gt.clamp(bbox[0], domain.extent[0], domain.extent[2]),
                Gt.clamp(bbox[2], domain.extent[0], domain.extent[2])
            ]

        return [
            minX,
            Gt.clamp(bbox[1], domain.extent[1], domain.extent[3]),
            maxX,
            Gt.clamp(bbox[3], domain.extent[1], domain.extent[3])
        ]
    }

    private static constrainBBoxToTargetDomain(bbox: BBox, sourceCrs: string, targetCrs: string): BBox {
        const sourceDomain = Gt.projectionDomain(sourceCrs)
        const targetDomain = Gt.targetDomainInSourceCrs(sourceCrs, targetCrs)
        if (!sourceDomain || !targetDomain) return bbox

        const sourceWidth = sourceDomain.extent[2] - sourceDomain.extent[0]
        const sourceHeight = sourceDomain.extent[3] - sourceDomain.extent[1]
        const targetWidth = targetDomain[2] - targetDomain[0]
        const targetHeight = targetDomain[3] - targetDomain[1]

        return [
            targetWidth < sourceWidth ? Gt.clamp(bbox[0], targetDomain[0], targetDomain[2]) : bbox[0],
            targetHeight < sourceHeight ? Gt.clamp(bbox[1], targetDomain[1], targetDomain[3]) : bbox[1],
            targetWidth < sourceWidth ? Gt.clamp(bbox[2], targetDomain[0], targetDomain[2]) : bbox[2],
            targetHeight < sourceHeight ? Gt.clamp(bbox[3], targetDomain[1], targetDomain[3]) : bbox[3]
        ]
    }

    private static constrainPositionToTargetDomain(position: Position, sourceCrs: string, targetCrs: string): [number, number] {
        const sourceDomain = Gt.projectionDomain(sourceCrs)
        const targetDomain = Gt.targetDomainInSourceCrs(sourceCrs, targetCrs)
        if (!sourceDomain || !targetDomain) return [position[0], position[1]]

        const sourceWidth = sourceDomain.extent[2] - sourceDomain.extent[0]
        const sourceHeight = sourceDomain.extent[3] - sourceDomain.extent[1]
        const targetWidth = targetDomain[2] - targetDomain[0]
        const targetHeight = targetDomain[3] - targetDomain[1]

        return [
            targetWidth < sourceWidth ? Gt.clamp(position[0], targetDomain[0], targetDomain[2]) : position[0],
            targetHeight < sourceHeight ? Gt.clamp(position[1], targetDomain[1], targetDomain[3]) : position[1]
        ]
    }

    private static constrainWrappedRange(min: number, max: number, domainMin: number, domainMax: number): [number, number] {
        const width = domainMax - domainMin
        const rangeWidth = max - min
        if (!Number.isFinite(width) || width <= 0 || rangeWidth >= width) {
            return [domainMin, domainMax]
        }

        const normalizedMin = Gt.wrapValue(min, domainMin, width)
        const normalizedMax = normalizedMin + rangeWidth
        return normalizedMax <= domainMax
            ? [normalizedMin, normalizedMax]
            : [domainMin, domainMax]
    }

    private static wrapValue(value: number, min: number, width: number): number {
        return ((((value - min) % width) + width) % width) + min
    }

    private static targetDomainInSourceCrs(sourceCrs: string, targetCrs: string): BBox | null {
        const targetDomain = Gt.projectionDomain(targetCrs)
        if (!targetDomain) return null

        return Gt.transformBBoxRaw(targetDomain.extent, targetCrs, sourceCrs)
    }

    private static projectionDomain(crs: string): ProjectionDomain | null {
        const projection = getProjection(crs)
        const extent = projection?.getExtent()
        if (!extent || extent.length !== 4 || extent.some((value) => !Number.isFinite(value))) {
            return null
        }

        return {
            extent: [extent[0], extent[1], extent[2], extent[3]],
            wrapsX: Boolean(projection?.canWrapX?.())
        }
    }
    static transformLabelPosition(
        properties: Feature['properties'],
        label_x: string,
        label_y: string,
        sourceCrs: string,
        targetCrs: string
    ): Feature['properties'] {
        return Gt.createCoordinateTransformer(sourceCrs, targetCrs)
            .transformLabelPosition(properties, label_x, label_y)
    }

    static parseBBox(value: string, crs: CrsCode, version: string): { bbox: BBox, order: 'xy' | 'yx' } {
        const parts = value.split(',').map((part) => Number(part.trim()))
        if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
            throw new Error(`Invalid BBOX: ${value}`)
        }

        if (!this.usesLatLonAxisOrder(crs, version)) {
            const bbox: BBox = [parts[0], parts[1], parts[2], parts[3]]
            this.validateBBox(bbox, crs)
            return {
                bbox,
                order: 'xy'
            }
        }

        const bbox: BBox = [parts[1], parts[0], parts[3], parts[2]]
        this.validateBBox(bbox, crs)
        return {
            bbox,
            order: 'yx'
        }


    }

    static validateBBox(bbox: BBox, crs: CrsCode): void {
        const [minX, minY, maxX, maxY] = bbox

        if (!(minX < maxX) || !(minY < maxY)) {
            throw new Error(`Invalid BBOX for ${crs}: minimum bounds must be lower than maximum bounds`)
        }
    }

    static usesLatLonAxisOrder(crs: CrsCode, version: string): boolean {
        return version === '1.3.0' && crs.toUpperCase() === 'EPSG:4326'
    }


}
