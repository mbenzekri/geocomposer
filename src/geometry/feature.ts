import type { BBox, CrsCode, Props } from '../core/types.js'
import type { Geometry } from './geometry.js'

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
  tableName: string
  rowId: string | number
  primaryKey?: string
  geometryColumn?: string
}

export type SourceLoc = FileRef | DbRef

export type SourceRef = SourceLoc & {
  recordIndex?: number
  related?: Record<string, SourceLoc>
}

export type Feature = {
  type: 'Feature'
  id?: string | number
  properties: Props | null
  geometry: Geometry | null
  bbox?: BBox
  crs?: CrsCode
  sourceRef?: SourceRef
}

export type FeatureCollection = {
  type: 'FeatureCollection'
  features: Feature[]
  bbox?: BBox
  crs?: CrsCode
}