import type { Feature } from "../core/feature.js"
import type { HitContext } from "../core/geometry.js"
import { Gt } from "../core/geotools.js"

export class HitFilter extends TransformStream<Feature, Feature> {
  constructor(context: HitContext) {
    super({
      transform(feature, controller) {
        if (!Gt.featureHitsPoint(feature, context)) return

        controller.enqueue(feature)
      }
    })
  }
}
