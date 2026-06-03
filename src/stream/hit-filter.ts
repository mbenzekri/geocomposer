import { Feature } from "../core/feature.js"
import { HitContext } from "../core/geometry.js"
import { Gt } from "../core/geotools.js"
import { Hit } from "../ogc/get-feature-info.js"

export class HitFilter extends TransformStream<Feature, Hit> {
  constructor(layerName: string, context: HitContext) {
    super({
      transform(feature, controller) {
        if (!Gt.featureHitsPoint(feature, context)) return

        controller.enqueue({
          layerName,
          feature
        })
      }
    })
  }
}
