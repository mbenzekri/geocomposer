import type { BBox, CrsCode } from '../core/types.js'
import { computeGeometryBBox, expandBBox } from '../geometry/bbox.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import { GeoSource, type GeoStreamOptions } from './geo-source.js'

export class MemoryGeoSource extends GeoSource {
  readonly type = 'memory'

  constructor(
    readonly id: string,
    readonly crs: CrsCode,
    private readonly features: GeoFeature[]
  ) {
    super()
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async getExtent(): Promise<BBox | null> {
    let extent: BBox | null = null

    for (const feature of this.features) {
      const bbox = feature.bbox ?? computeGeometryBBox(feature.geometry)
      if (bbox) extent = extent ? expandBBox(extent, bbox) : bbox
    }

    return extent
  }

  stream(options: GeoStreamOptions = {}): ReadableStream<GeoFeature> {
    let index = 0

    return new ReadableStream<GeoFeature>({
      pull: (controller) => {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason)
          return
        }

        if (index >= this.features.length) {
          controller.close()
          return
        }

        controller.enqueue(this.features[index])
        index += 1
      }
    })
  }
}
