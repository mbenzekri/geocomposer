import type { BBox } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { Feature } from '../core/feature.js'

export class BboxFilter extends TransformStream<Feature, Feature> {
  constructor(bbox: BBox) {
    super({
      transform(feature, controller) {
        const featureBBox = feature.bbox ?? Gt.bbox(feature.geometry)

        if (!featureBBox || Gt.intersects(featureBBox, bbox)) {
          controller.enqueue(feature)
        }
      }
    })
  }
}
