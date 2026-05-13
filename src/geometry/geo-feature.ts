import type { BBox, CrsCode, GeoProperties } from '../core/types.js'
import type { GeoGeometry } from './geo-geometry.js'

export type GeoFeatureSourceRef = {
  sourceId: string
  /** Byte offset of the opening { of the serialized feature object. */
  offset: number
  /** Byte length through the closing }, so the byte slice is JSON.parse-able. */
  byteLength: number
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