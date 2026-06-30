import { Gt } from '../core/geotools.js'
import type { Feature } from '../core/feature.js'
import type { RequestTimings } from '../source/source.js'


export class Reproject extends TransformStream<Feature, Feature> {
  constructor(
    inputCrs: string,
    targetCrs: string,
    timings?: RequestTimings
  ) {
    super({
      transform: (feature, controller) => {
        const startedAt = performance.now()
        try {
          const shouldTransformGeometry = inputCrs !== targetCrs && feature.geometry !== null
          const shouldTransformPointProperties = feature.layer.pointProperties.some((pointProperty) =>
            pointProperty.crs !== targetCrs
          )

          if (!shouldTransformGeometry && !shouldTransformPointProperties) {
            controller.enqueue({
              ...feature,
              crs: targetCrs
            })
            return
          }

          const geometry = shouldTransformGeometry && feature.geometry
            ? Gt.transformGeometry(feature.geometry, inputCrs, targetCrs)
            : feature.geometry
          const bbox = geometry ? Gt.bbox(geometry) ?? undefined : feature.bbox
          let properties = feature.properties
          if (properties != null) {
            for (const pointProperty of feature.layer.pointProperties) {
              if (pointProperty.crs === targetCrs) continue

              properties = Gt.transformLabelPosition(
                properties,
                pointProperty.x,
                pointProperty.y,
                pointProperty.crs,
                targetCrs
              )
            }
          }

          controller.enqueue({
            ...feature,
            geometry,
            bbox,
            crs: targetCrs,
            properties
          })
        } finally {
          if (timings) timings.reprojectionMs += performance.now() - startedAt
        }
      }
    })
  }
}
