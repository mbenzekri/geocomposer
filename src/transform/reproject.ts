import { Gt } from '../core/geotools.js'
import type { Feature } from '../core/feature.js'


export class Reproject extends TransformStream<Feature, Feature> {
  constructor(
    sourceCrs: string,
    targetCrs: string
  ) {
    super({
      transform: (feature, controller) => {
        if (sourceCrs === targetCrs || !feature.geometry) {
          controller.enqueue(feature)
          return
        }

        const geometry = Gt.transformGeometry(feature.geometry, sourceCrs, targetCrs)
        const bbox = Gt.bbox(geometry) ?? undefined
        let properties = feature.properties
        if (feature?.layer) console.log(`----- traitement de reprojection ${feature.layer.name}`)
        if (properties != null && feature.layer?.pointProperties != null) {
            for (let pp of feature.layer.pointProperties) {
                console.log(`----- traitement de reprojection ${feature.layer.name}`)
                if (sourceCrs != targetCrs) {
                    properties = Gt.transformLabelPosition(properties, pp.x, pp.y, pp.crs ?? sourceCrs, targetCrs)
                }
            }
        }

        controller.enqueue({
          ...feature,
          geometry,
          bbox,
          properties
        })
      }
    })
  }
}


