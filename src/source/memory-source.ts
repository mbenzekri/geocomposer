import type { BBox, CrsCode } from '../core/types.js'
import { Geom } from '../geometry/geom.js'
import type { Feature } from '../geometry/feature.js'
import { Source, type StreamOptions } from './source.js'

export class MemorySource extends Source {
  readonly type = 'memory'
  readonly storage = 'memory' as const

  constructor(
    readonly id: string,
    readonly crs: CrsCode,
    private readonly features: Feature[]
  ) {
    super()
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async getExtent(): Promise<BBox | null> {
    let extent: BBox | null = null

    for (const feature of this.features) {
      const bbox = feature.bbox ?? Geom.bbox(feature.geometry)
      if (bbox) extent = extent ? Geom.expand(extent, bbox) : bbox
    }

    return extent
  }

  stream(options: StreamOptions = {}): ReadableStream<Feature> {
    let index = 0

    return new ReadableStream<Feature>({
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
