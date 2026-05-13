export type GeoGeometry =
  | GeoPoint
  | GeoLineString
  | GeoPolygon
  | GeoMultiPoint
  | GeoMultiLineString
  | GeoMultiPolygon

export type GeoPosition = [number, number, ...number[]]

export type GeoPoint = {
  type: 'Point'
  coordinates: GeoPosition
}

export type GeoLineString = {
  type: 'LineString'
  coordinates: GeoPosition[]
}

export type GeoPolygon = {
  type: 'Polygon'
  coordinates: GeoPosition[][]
}

export type GeoMultiPoint = {
  type: 'MultiPoint'
  coordinates: GeoPosition[]
}

export type GeoMultiLineString = {
  type: 'MultiLineString'
  coordinates: GeoPosition[][]
}

export type GeoMultiPolygon = {
  type: 'MultiPolygon'
  coordinates: GeoPosition[][][]
}
