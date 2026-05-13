import type { BBox, CrsCode, GeoProperties } from '../core/types.js'
import type { GeoGeometry } from './geo-geometry.js'

export type GeoFeature = {
  id?: string | number
  properties: GeoProperties
  geometry: GeoGeometry | null
  bbox?: BBox
  crs?: CrsCode
}
