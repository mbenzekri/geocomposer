import type { BBox, CrsCode, GeoProperties } from '../core/types.js'
import type { GeoGeometry } from './geo-geometry.js'

export type GeoFeatureFileSourceRef = {
  storage?: 'file'
  sourceId: string
  offset: number
  byteLength: number
}

export type GeoFeatureByteRange = GeoFeatureFileSourceRef

export type GeoFeatureDatabaseSourceRef = {
  storage: 'database'
  sourceId: string
  tableName: string
  rowId: string | number
  primaryKey?: string
  geometryColumn?: string
}

export type GeoFeatureSourceLocation = GeoFeatureFileSourceRef | GeoFeatureDatabaseSourceRef

export type GeoFeatureSourceRef = GeoFeatureSourceLocation & {
  recordIndex?: number
  related?: Record<string, GeoFeatureSourceLocation>
}

export type GeoFeature = {
  type: 'Feature'
  id?: string | number
  properties: GeoProperties | null
  geometry: GeoGeometry | null
  bbox?: BBox
  crs?: CrsCode
  sourceRef?: GeoFeatureSourceRef
}

export type GeoFeatureCollection = {
  type: 'FeatureCollection'
  features: GeoFeature[]
  bbox?: BBox
  crs?: CrsCode
}