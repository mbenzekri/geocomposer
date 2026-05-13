import type { BBox, CrsCode } from '../core/types.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import { BBoxFilterTransform } from '../transform/bbox-filter-transform.js'

export type GeoStreamOptions = {
  signal?: AbortSignal
}

export type GeoQueryOptions = GeoStreamOptions & {
  bbox?: BBox
  crs?: CrsCode
  properties?: string[]
}

export abstract class GeoSource {
  abstract readonly id: string
  abstract readonly type: string
  abstract readonly crs: CrsCode

  abstract open(): Promise<void>
  abstract close(): Promise<void>
  abstract getExtent(): Promise<BBox | null>

  abstract stream(options?: GeoStreamOptions): ReadableStream<GeoFeature>

  query(options: GeoQueryOptions): ReadableStream<GeoFeature> {
    const input = this.stream(options)

    if (!options.bbox) {
      return input
    }

    return input.pipeThrough(new BBoxFilterTransform(options.bbox))
  }
}
