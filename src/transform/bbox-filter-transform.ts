import type { BBox } from '../core/types.js'
import { computeGeometryBBox, intersectsBBox } from '../geometry/bbox.js'
import type { GeoFeature } from '../geometry/geo-feature.js'

export class BBoxFilterTransform extends TransformStream<GeoFeature, GeoFeature> {
  constructor(bbox: BBox) {
    super({
      transform(feature, controller) {
        const featureBBox = feature.bbox ?? computeGeometryBBox(feature.geometry)

        if (!featureBBox || intersectsBBox(featureBBox, bbox)) {
          controller.enqueue(feature)
        }
      }
    })
  }
}
