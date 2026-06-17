import type { Layer } from '../layer/layer.js'
import type { BBox, CrsCode } from './geometry.js'
import type { Geometry } from './geometry.js'
import { Dict, Props } from './tools.js'

export type DescInfo = {
    title?: string
    abstract?: string
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
