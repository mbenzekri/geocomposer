import Point from 'ol/geom/Point.js'
import LineString from 'ol/geom/LineString.js'
import Polygon from 'ol/geom/Polygon.js'
import MultiPoint from 'ol/geom/MultiPoint.js'
import MultiLineString from 'ol/geom/MultiLineString.js'
import MultiPolygon from 'ol/geom/MultiPolygon.js'
import type OlGeometry from 'ol/geom/Geometry.js'
import type { Geometry } from '../core/geometry.js'

export class OlGeometryAdapter {
  private readonly point = new Point([0, 0])
  private readonly line = new LineString([])
  private readonly polygon = new Polygon([])
  private readonly multiPoint = new MultiPoint([])
  private readonly multiLine = new MultiLineString([])
  private readonly multiPolygon = new MultiPolygon([])

  toGeometry(geometry: Geometry): OlGeometry {
    switch (geometry.type) {
      case 'Point':
        this.point.setCoordinates(geometry.coordinates)
        return this.point

      case 'LineString':
        this.line.setCoordinates(geometry.coordinates)
        return this.line

      case 'Polygon':
        this.polygon.setCoordinates(geometry.coordinates)
        return this.polygon

      case 'MultiPoint':
        this.multiPoint.setCoordinates(geometry.coordinates)
        return this.multiPoint

      case 'MultiLineString':
        this.multiLine.setCoordinates(geometry.coordinates)
        return this.multiLine

      case 'MultiPolygon':
        this.multiPolygon.setCoordinates(geometry.coordinates)
        return this.multiPolygon
    }
  }
}
