import { Gt } from '../core/geotools.js'
import type { Feature } from '../core/feature.js'
import type { RequestTimings } from '../source/source.js'


export class Reproject extends TransformStream<Feature, Feature> {
  constructor(
    inputCrs: string,
    targetCrs: string,
    timings?: RequestTimings
  ) {
    const geometryTransformer = inputCrs !== targetCrs
      ? Gt.createCoordinateTransformer(inputCrs, targetCrs)
      : undefined
    const pointPropertyTransformers = new Map<string, ReturnType<typeof Gt.createCoordinateTransformer>>()

    super({
      transform: (feature, controller) => {
        const startedAt = performance.now()
        try {
          const shouldTransformGeometry = geometryTransformer !== undefined && feature.geometry !== null
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
            ? geometryTransformer.transformGeometry(feature.geometry)
            : feature.geometry
          const bbox = geometry ? Gt.bbox(geometry) ?? undefined : feature.bbox
          let properties = feature.properties
          if (properties != null) {
            for (const pointProperty of feature.layer.pointProperties) {
              if (pointProperty.crs === targetCrs) continue

              let pointPropertyTransformer = pointPropertyTransformers.get(pointProperty.crs)
              if (!pointPropertyTransformer) {
                pointPropertyTransformer = Gt.createCoordinateTransformer(pointProperty.crs, targetCrs)
                pointPropertyTransformers.set(pointProperty.crs, pointPropertyTransformer)
              }
              properties = pointPropertyTransformer.transformLabelPosition(properties, pointProperty.x, pointProperty.y)
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
