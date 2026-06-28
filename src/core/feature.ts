import type { Layer } from '../layer/layer.js'
import type { BBox, CrsCode } from './geometry.js'
import type { Geometry, Position } from './geometry.js'
import { Dict, Props } from './tools.js'

export type DescInfo = {
    title?: string
    abstract?: string
}

export abstract class RegistryEntry {
    readonly id: string
    readonly title?: string
    readonly abstract?: string

    protected constructor(id: string, info: DescInfo = {}) {
        this.id = id
        this.title = info.title
        this.abstract = info.abstract
    }
}

export type ServiceInfo = {
    path?: string
    onlineResource?: string
}

export type FileRef = {
    storage?: 'file'
    sourceId: string
    offset: number
    byteLength: number
}

export type ByteRange = FileRef

export type DbRef = {
    storage: 'database'
    sourceId: string
    schemaName?: string
    tableName: string
    rowId: string | number
    primaryKey?: string
    geometryColumn?: string
}

export type MemRef = {
    storage: 'mem'
    sourceId: string
    featureIndex: number
}

export type SourceLoc = FileRef | DbRef | MemRef

export type SourceRef = SourceLoc & {
    recordIndex?: number
    related?: Dict<SourceLoc>
}

export type Feature = {
    type: 'Feature'
    id?: string | number
    properties: Props | null
    geometry: Geometry | null
    bbox?: BBox
    crs?: CrsCode
    layer: Layer
    sourceRef?: SourceRef
}

export type FeatureCollection = {
    type: 'FeatureCollection'
    features: Feature[]
    bbox?: BBox
    crs?: CrsCode
}

export function IdFromFeature(feature: Feature): string | undefined {
    if (feature.id !== undefined) return String(feature.id)

    const sourceRef = feature.sourceRef
    if (!sourceRef) return undefined

    if (sourceRef.storage === 'database') return String(sourceRef.rowId)
    if (sourceRef.storage === 'mem') return String(sourceRef.featureIndex)
    if (sourceRef.recordIndex !== undefined) return String(sourceRef.recordIndex)

    return undefined
  }

export function withLazyBbox<T extends Feature>(feature: T): T {
    if (feature.bbox !== undefined) return feature

    let computed = false
    let bbox: BBox | undefined

    Object.defineProperty(feature, 'bbox', {
        configurable: true,
        get() {
            if (!computed) {
                bbox = bboxFromGeometry(feature.geometry) ?? undefined
                computed = true
                Object.defineProperty(feature, 'bbox', {
                    configurable: true,
                    enumerable: bbox !== undefined,
                    writable: true,
                    value: bbox
                })
            }

            return bbox
        }
    })

    return feature
}

function bboxFromGeometry(geometry: Geometry | null): BBox | null {
    if (!geometry) return null

    switch (geometry.type) {
        case 'Point': {
            const [x, y] = geometry.coordinates
            return [x, y, x, y]
        }

        case 'LineString':
        case 'MultiPoint':
            return bboxFromPositions(geometry.coordinates)

        case 'Polygon':
        case 'MultiLineString':
            return bboxFromPositionGroups(geometry.coordinates)

        case 'MultiPolygon': {
            let bbox: BBox | null = null

            for (const polygon of geometry.coordinates) {
                const polygonBBox = bboxFromPositionGroups(polygon)
                if (polygonBBox) bbox = expandBBox(bbox, polygonBBox)
            }

            return bbox
        }
    }
}

function bboxFromPositionGroups(groups: Position[][]): BBox | null {
    let bbox: BBox | null = null

    for (const group of groups) {
        const groupBBox = bboxFromPositions(group)
        if (groupBBox) bbox = expandBBox(bbox, groupBBox)
    }

    return bbox
}

function bboxFromPositions(positions: Position[]): BBox | null {
    let bbox: BBox | null = null

    for (const [x, y] of positions) {
        const pointBBox: BBox = [x, y, x, y]
        bbox = expandBBox(bbox, pointBBox)
    }

    return bbox
}

function expandBBox(current: BBox | null, next: BBox): BBox {
    if (!current) return next

    return [
        Math.min(current[0], next[0]),
        Math.min(current[1], next[1]),
        Math.max(current[2], next[2]),
        Math.max(current[3], next[3])
    ]
}
