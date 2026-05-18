import type { BBox, CrsCode } from '../core/types.js'
import { Geom } from '../geometry/geom.js'
import type { Feature, MemRef, SourceRef } from '../geometry/feature.js'
import { Source, type StreamOptions } from './source.js'

export class MemSource extends Source {
  readonly type = 'mem'
  readonly storage = 'mem' as const

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

        controller.enqueue(this.withSourceRef(this.features[index], index))
        index += 1
      }
    })
  }

  async read(sourceRef: SourceRef): Promise<Feature | null> {
    const ref = this.toMemRef(sourceRef)
    const feature = this.features[ref.featureIndex]
    if (!feature) return null
    return this.withSourceRef(feature, ref.featureIndex)
  }

  private withSourceRef(feature: Feature, index: number): Feature {
    return {
      ...feature,
      sourceRef: {
        storage: 'mem',
        sourceId: this.id,
        featureIndex: index,
        recordIndex: index
      }
    }
  }

  private toMemRef(sourceRef: SourceRef): MemRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.id) {
      throw new Error(`Mem sourceRef belongs to "${sourceRef.sourceId}", expected "${this.id}"`)
    }

    if (sourceRef.storage !== 'mem') {
      throw new Error('Mem sourceRef must use mem storage')
    }

    if (typeof sourceRef.featureIndex !== 'number') {
      throw new Error('Mem sourceRef must include featureIndex')
    }

    return sourceRef
  }
}
