import type { BBox, CrsCode } from '../../core/geometry.js'
import type { Feature } from '../../core/feature.js'
import { Gt } from '../../core/geotools.js'
import type { Layer } from '../../layer/layer.js'
import { GeometryBboxFilter } from '../../stream/geometry-bbox-filter.js'
import { PageFilter } from '../../stream/page-filter.js'
import { Reproject } from '../../stream/reproject.js'

export type FeaturePage = {
  features: Feature[]
  numberReturned: number
  hasNext: boolean
  nextOffset?: number
}

export type FeaturePageQuery = {
  bbox?: BBox
  bboxCrs: CrsCode
  crs: CrsCode
  properties?: string[]
  limit: number
  offset: number
  signal?: AbortSignal
}

export type FeatureReadQuery = {
  crs: CrsCode
  signal?: AbortSignal
}

export class LayerFeatureRepository {
  async queryPage(layer: Layer, query: FeaturePageQuery): Promise<FeaturePage> {
    const pageSize = query.limit + 1
    const queryCrs = query.bbox ? query.bboxCrs : query.crs
    let stream = layer.query({
      bbox: query.bbox,
      crs: queryCrs,
      properties: query.properties,
      limit: query.bbox ? undefined : pageSize,
      offset: query.bbox ? undefined : query.offset,
      signal: query.signal
    })

    if (query.bbox) {
      stream = stream
        .pipeThrough(new GeometryBboxFilter(query.bbox))
        .pipeThrough(new PageFilter({
          offset: query.offset,
          limit: pageSize
        }))
    }

    if (queryCrs !== query.crs) {
      stream = stream.pipeThrough(new Reproject(queryCrs, query.crs))
    }

    const features = await this.readAtMost(stream, pageSize)
    const hasNext = features.length > query.limit
    if (hasNext) features.pop()

    return {
      features,
      numberReturned: features.length,
      hasNext,
      nextOffset: hasNext ? query.offset + query.limit : undefined
    }
  }

  async readById(layer: Layer, featureId: string, query: FeatureReadQuery): Promise<Feature | null> {
    const feature = await layer.source.readById(featureId, {
      layer,
      signal: query.signal
    })

    if (!feature) return null
    return this.projectFeature(feature, layer.crs, query.crs)
  }

  private async readAtMost(stream: ReadableStream<Feature>, count: number): Promise<Feature[]> {
    const reader = stream.getReader()
    const features: Feature[] = []

    try {
      while (features.length < count) {
        const result = await reader.read()
        if (result.done) break
        features.push(result.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    return features
  }

  private projectFeature(feature: Feature, sourceCrs: CrsCode, targetCrs: CrsCode): Feature {
    if (sourceCrs === targetCrs) {
      return {
        ...feature,
        crs: targetCrs
      }
    }

    const geometry = feature.geometry
      ? Gt.transformGeometry(feature.geometry, sourceCrs, targetCrs)
      : feature.geometry
    let properties = feature.properties

    if (properties) {
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

    return {
      ...feature,
      geometry,
      bbox: geometry ? Gt.bbox(geometry) ?? undefined : feature.bbox,
      crs: targetCrs,
      properties
    }
  }
}
