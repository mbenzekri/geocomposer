export type Geometry =
  | Point
  | LineString
  | Polygon
  | MultiPoint
  | MultiLineString
  | MultiPolygon

export type Position = [number, number, ...number[]]

export type Point = {
  type: 'Point'
  coordinates: Position
}

export type LineString = {
  type: 'LineString'
  coordinates: Position[]
}

export type Polygon = {
  type: 'Polygon'
  coordinates: Position[][]
}

export type MultiPoint = {
  type: 'MultiPoint'
  coordinates: Position[]
}

export type MultiLineString = {
  type: 'MultiLineString'
  coordinates: Position[][]
}

export type MultiPolygon = {
  type: 'MultiPolygon'
  coordinates: Position[][][]
}
