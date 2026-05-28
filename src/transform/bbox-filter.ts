import type { BBox } from '../core/types.js'
import { Geom } from '../core/geo-tools.js'
import type { Feature } from '../core/feature.js'

export class BboxFilter extends TransformStream<Feature, Feature> {
  constructor(bbox: BBox) {
    super({
      transform(feature, controller) {
        const featureBBox = feature.bbox ?? Geom.bbox(feature.geometry)

        if (!featureBBox || Geom.intersects(featureBBox, bbox)) {
          controller.enqueue(feature)
        }
      }
    })
  }
}
