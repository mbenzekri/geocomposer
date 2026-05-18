import type { BBox } from '../core/types.js'
import { computeBBox, intersectsBBox } from '../geometry/bbox.js'
import type { Feature } from '../geometry/feature.js'

export class BboxFilter extends TransformStream<Feature, Feature> {
  constructor(bbox: BBox) {
    super({
      transform(feature, controller) {
        const featureBBox = feature.bbox ?? computeBBox(feature.geometry)

        if (!featureBBox || intersectsBBox(featureBBox, bbox)) {
          controller.enqueue(feature)
        }
      }
    })
  }
}
