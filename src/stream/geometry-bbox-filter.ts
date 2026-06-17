import bboxPolygon from '@turf/bbox-polygon'
import booleanIntersects from '@turf/boolean-intersects'
import type { Geometry as GeoJsonGeometry } from 'geojson'
import type { BBox } from '../core/geometry.js'
import type { Feature } from '../core/feature.js'
import { Gt } from '../core/geotools.js'

export class GeometryBboxFilter extends TransformStream<Feature, Feature> {
  constructor(bbox: BBox) {
    const bboxFeature = bboxPolygon(bbox)

    super({
      transform(feature, controller) {
        if (!feature.geometry) {
          controller.enqueue(feature)
          return
        }

        const featureBBox = feature.bbox ?? Gt.bbox(feature.geometry)
        if (featureBBox && !Gt.intersects(featureBBox, bbox)) return

        if (booleanIntersects(feature.geometry as GeoJsonGeometry, bboxFeature)) {
          controller.enqueue(feature)
        }
      }
    })
  }
}
