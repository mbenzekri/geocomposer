export type GeoGeometry =
  | GeoPoint
  | GeoLineString
  | GeoPolygon
  | GeoMultiPoint
  | GeoMultiLineString
  | GeoMultiPolygon

export type GeoPoint = {
  type: 'Point'
  coordinates: [number, number]
}

export type GeoLineString = {
  type: 'LineString'
  coordinates: Float64Array
}

export type GeoPolygon = {
  type: 'Polygon'
  rings: Float64Array[]
}

export type GeoMultiPoint = {
  type: 'MultiPoint'
  coordinates: Float64Array
}

export type GeoMultiLineString = {
  type: 'MultiLineString'
  lines: Float64Array[]
}

export type GeoMultiPolygon = {
  type: 'MultiPolygon'
  polygons: Float64Array[][]
}
