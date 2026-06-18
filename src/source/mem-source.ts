import type { BBox } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { Feature, MemRef, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { Source, type StreamOptions } from './source.js'

export type MemFeatureProvider = (layer: Layer) => Feature[] | Promise<Feature[]>

export class MemSource extends Source {
  readonly type = 'mem'
  readonly storage = 'mem' as const
  private readonly layer: Layer | null
  private readonly featureProvider: MemFeatureProvider | null
  private readonly initialFeatures: Feature[] | null
  private features: Feature[] | null = null
  private opening: Promise<void> | null = null

  constructor(id: string, layer: Layer)
  constructor(id: string, features?: Feature[] | MemFeatureProvider)
  constructor(
    id: string,
    layerOrFeatures: Layer | Feature[] | MemFeatureProvider = []
  ) {
    super(id)

    if (isLayer(layerOrFeatures)) {
      this.layer = layerOrFeatures
      this.featureProvider = null
      this.initialFeatures = null
    } else {
      this.layer = null
      this.featureProvider = typeof layerOrFeatures === 'function' ? layerOrFeatures : null
      this.initialFeatures = typeof layerOrFeatures === 'function' ? null : layerOrFeatures
    }
  }

  async close(): Promise<void> {
    if (this.opening) await this.opening

    this.features = null
    this.opening = null
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
    if (this.features) return this.features

    if (!this.opening) {
      this.opening = this.load(layer, signal)
    }

    try {
      await this.opening
    } finally {
      this.opening = null
    }

    return this.features ?? []
  }

  private async load(layer: Layer, signal?: AbortSignal): Promise<void> {
    const features: Feature[] = []

    if (!this.layer) {
      const loaded = this.featureProvider
        ? await this.featureProvider(layer)
        : this.initialFeatures ?? []

      this.features = loaded.map((feature) => ({
        ...feature,
        layer
      }))
      return
    }

    await this.layer.stream({ signal }).pipeTo(new WritableStream<Feature>({
      write(feature) {
        features.push(feature)
      }
    }))

    this.features = features
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
      crs: layer.crs,
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

function isLayer(value: Layer | Feature[] | MemFeatureProvider): value is Layer {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Layer).id === 'string'
    && typeof (value as Layer).source === 'object'
    && typeof (value as Layer).stream === 'function'
}
