import type { BBox, CrsCode } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { DescInfo, Feature, MemRef, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { Source, hasSourceConfigType, type StreamOptions } from './source-base.js'

export type MemFeatureProvider = (layer: Layer) => Feature[] | Promise<Feature[]>

export type MemSourceJson = DescInfo & {
  type: 'mem'
  source: string
}

export class MemSource extends Source {
  readonly type = 'mem'
  readonly storage = 'mem' as const
  private readonly source: Source | null
  private readonly featureProvider: MemFeatureProvider | null
  private readonly initialFeatures: Feature[] | null
  private readonly memoryCrs: CrsCode
  private readonly featuresByLayer = new Map<Layer, Feature[]>()
  private readonly openings = new Map<Layer, Promise<void>>()

  static acceptsConfig(entry: unknown): entry is MemSourceJson {
    return hasSourceConfigType(entry, 'mem')
  }

  static fromConfig(id: string, entry: MemSourceJson): MemSource {
    return new MemSource(id, Source.registry.get(entry.source))
  }

  constructor(id: string, source: Source)
  constructor(id: string, crs: CrsCode, features: Feature[] | MemFeatureProvider)
  constructor(
    readonly id: string,
    sourceOrCrs: Source | CrsCode,
    features: Feature[] | MemFeatureProvider = []
  ) {
    super()

    if (isSource(sourceOrCrs)) {
      this.source = sourceOrCrs
      this.featureProvider = null
      this.initialFeatures = null
      this.memoryCrs = sourceOrCrs.crs
    } else {
      this.source = null
      this.featureProvider = typeof features === 'function' ? features : null
      this.initialFeatures = typeof features === 'function' ? null : features
      this.memoryCrs = sourceOrCrs
    }
  }

  get crs(): CrsCode {
    return this.source?.crs ?? this.memoryCrs
  }

  async close(): Promise<void> {
    if (this.openings.size > 0) {
      await Promise.all(this.openings.values())
    }

    await this.source?.close()
    this.featuresByLayer.clear()
    this.openings.clear()
  }

  async getExtent(layer: Layer): Promise<BBox | null> {
    const features = await this.ensureLoaded(layer)

    let extent: BBox | null = null

    for (const feature of features) {
      const bbox = feature.bbox ?? Gt.bbox(feature.geometry)
      if (bbox) extent = extent ? Gt.expand(extent, bbox) : bbox
    }

    return extent
  }

  stream(options: StreamOptions): ReadableStream<Feature> {
    let index = 0

    return new ReadableStream<Feature>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason)
          return
        }

        let features: Feature[]
        try {
          features = await this.ensureLoaded(options.layer, options.signal)
        } catch (error) {
          controller.error(error)
          return
        }

        if (index >= features.length) {
          controller.close()
          return
        }

        controller.enqueue(this.withSourceRef(features[index], index, options.layer))
        index += 1
      }
    })
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const ref = this.toMemRef(sourceRef)
    const features = await this.ensureLoaded(options.layer, options.signal)
    const feature = features[ref.featureIndex]
    if (!feature) return null
    return this.withSourceRef(feature, ref.featureIndex, options.layer)
  }

  private async ensureLoaded(layer: Layer, signal?: AbortSignal): Promise<Feature[]> {
    const loaded = this.featuresByLayer.get(layer)
    if (loaded) return loaded

    let opening = this.openings.get(layer)
    if (!opening) {
      opening = this.load(layer, signal)
      this.openings.set(layer, opening)
    }

    try {
      await opening
    } finally {
      this.openings.delete(layer)
    }

    return this.featuresByLayer.get(layer) ?? []
  }

  private async load(layer: Layer, signal?: AbortSignal): Promise<void> {
    const features: Feature[] = []

    if (!this.source) {
      const loaded = this.featureProvider
        ? await this.featureProvider(layer)
        : this.initialFeatures ?? []

      this.featuresByLayer.set(layer, loaded.map((feature) => ({
        ...feature,
        layer
      })))
      return
    }

    await this.source.open()

    await this.source.stream({ layer, signal }).pipeTo(new WritableStream<Feature>({
      write(feature) {
        features.push(feature)
      }
    }))

    this.featuresByLayer.set(layer, features.map((feature) => ({
      ...feature,
      layer
    })))
  }

  private withSourceRef(feature: Feature, index: number, layer: Layer): Feature {
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
      layer,
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
