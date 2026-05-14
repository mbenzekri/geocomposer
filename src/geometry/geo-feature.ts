import type { BBox, CrsCode, GeoProperties } from '../core/types.js'
import type { GeoGeometry } from './geo-geometry.js'

export type GeoFeatureByteRange = {
  sourceId: string
  offset: number
  byteLength: number
}

export type GeoFeatureSourceRef = GeoFeatureByteRange & {
  recordIndex?: number
  related?: Record<string, GeoFeatureByteRange>
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