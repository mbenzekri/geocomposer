import type { BBox, CrsCode } from '../core/types.js'
import { Geom } from '../core/geo-tools.js'
import type { Feature, MemRef, SourceRef } from '../core/feature.js'
import { Source, type StreamOptions } from './source.js'

export class MemSource extends Source {
  readonly type = 'mem'
  readonly storage = 'mem' as const
  private readonly source: Source | null
  private readonly memoryCrs: CrsCode
  private features: Feature[]
  private loaded: boolean
  private opening: Promise<void> | null = null

  constructor(id: string, source: Source)
  constructor(id: string, crs: CrsCode, features: Feature[])
  constructor(
    readonly id: string,
    sourceOrCrs: Source | CrsCode,
    features: Feature[] = []
  ) {
    super()

    if (isSource(sourceOrCrs)) {
      this.source = sourceOrCrs
      this.memoryCrs = sourceOrCrs.crs
      this.features = []
      this.loaded = false
    } else {
      this.source = null
      this.memoryCrs = sourceOrCrs
      this.features = features
      this.loaded = true
    }
  }

  get crs(): CrsCode {
    return this.source?.crs ?? this.memoryCrs
  }

  async open(): Promise<void> {
    if (this.loaded) return

    if (!this.opening) {
      this.opening = this.load()
    }

    try {
      await this.opening
    } finally {
      this.opening = null
    }
  }

  async close(): Promise<void> {
    if (!this.source) return

    await this.source.close()
    this.features = []
    this.loaded = false
  }

  async getExtent(): Promise<BBox | null> {
    await this.open()

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
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason)
          return
        }

        try {
          await this.open()
        } catch (error) {
          controller.error(error)
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
    await this.open()

    const ref = this.toMemRef(sourceRef)
    const feature = this.features[ref.featureIndex]
    if (!feature) return null
    return this.withSourceRef(feature, ref.featureIndex)
  }

  private async load(): Promise<void> {
    if (!this.source) {
      this.loaded = true
      return
    }

    await this.source.open()

    const features: Feature[] = []

    await this.source.stream().pipeTo(new WritableStream<Feature>({
      write(feature) {
        features.push(feature)
      }
    }))

    this.features = features
    this.loaded = true
  }

  private withSourceRef(feature: Feature, index: number): Feature {
    const sourceRef: SourceRef = {
      storage: 'mem',
      sourceId: this.id,
      featureIndex: index,
      recordIndex: index
    }

    if (feature.sourceRef) {
      sourceRef.related = {
        source: feature.sourceRef
      }
    }

    return {
      ...feature,
      sourceRef
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

function isSource(value: Source | CrsCode): value is Source {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Source).stream === 'function'
    && typeof (value as Source).open === 'function'
}
