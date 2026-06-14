import type { PathLike } from 'node:fs'
import type { BBox } from '../core/geometry.js'
import type { Feature, SourceRef } from '../core/feature.js'
import { Gt } from '../core/geotools.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import type { Layer } from '../layer/layer.js'
import { Registry } from '../core/tools.js'

export type SourceStorage = 'mem' | 'file' | 'database'

export type SourceFileRole = 'data' | 'geometry' | 'attributes' | 'index' | 'metadata'

export type SourceFile = {
  role: SourceFileRole | string
  path: PathLike
}

export type StreamOptions = {
  signal?: AbortSignal
  layer: Layer
}

export type QueryOptions = StreamOptions & {
  bbox?: BBox
  properties?: string[]
}

export type FeatureTransform = (feature: Feature, index: number) => Feature | Promise<Feature>

export abstract class Source {
  static readonly registry = new Registry<Source>('SOURCE')

  abstract readonly id: string
  abstract readonly type: string
  abstract readonly storage: SourceStorage

  static build(
    _sourceEntries: Record<string, unknown>,
    _baseDir: string,
  ): Registry<Source>{
    throw new Error('Source.build is not initialized')
  }

  static create(
    _name: string,
    _entry: unknown,
    _baseDir: string,
  ): Source {
    throw new Error('Source.create is not initialized')
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  abstract getExtent(layer: Layer): Promise<BBox | null>

  abstract stream(options: StreamOptions): ReadableStream<Feature>
  abstract read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null>

  query(options: QueryOptions): ReadableStream<Feature> {
    const input = this.stream(options)

    if (!options.bbox) {
      return input
    }

    return input.pipeThrough(new BboxFilter(options.bbox))
  }
}

export abstract class FeatureSource extends Source {
  protected constructor(private readonly transformFeature?: FeatureTransform) {
    super()
  }

  async getExtent(layer: Layer): Promise<BBox | null> {
    let extent: BBox | null = null

    for await (const feature of this.mapFeatures(this.streamFeatures({ layer }), { layer })) {
      const bbox = feature.bbox ?? Gt.bbox(feature.geometry)
      if (bbox) extent = extent ? Gt.expand(extent, bbox) : bbox
    }

    return extent
  }

  stream(options: StreamOptions): ReadableStream<Feature> {
    return toStream(this.mapFeatures(this.streamFeatures(options), options), options, (signal) => this.abortReason(signal))
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const feature = await this.readFeature(sourceRef, options)
    if (!feature) return null
    return this.mapFeature(feature, sourceRef.recordIndex ?? 0, options.layer)
  }

  protected abstract streamFeatures(options: StreamOptions): AsyncIterable<Feature>
  protected abstract readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null>

  protected abortReason(signal: AbortSignal): unknown {
    return signal.reason
  }

  protected async *mapFeatures(features: AsyncIterable<Feature>, options: StreamOptions): AsyncGenerator<Feature> {
    let index = 0

    for await (const feature of features) {
      yield await this.mapFeature(feature, index, options.layer)
      index += 1
    }
  }

  protected async mapFeature(feature: Feature, index: number, layer: Layer): Promise<Feature> {
    const output = this.transformFeature
      ? await this.transformFeature(feature, index)
      : feature

    return {
      ...output,
      layer,
      crs: layer.crs,
      sourceRef: feature.sourceRef
    }
  }
}

export abstract class FileSource extends FeatureSource {
  readonly storage = 'file' as const

  protected constructor(transformFeature?: FeatureTransform) {
    super(transformFeature)
  }

  abstract getFiles(): readonly SourceFile[]
}

export abstract class DbSource extends FeatureSource {
  readonly storage = 'database' as const

  protected constructor(transformFeature?: FeatureTransform) {
    super(transformFeature)
  }

  protected resolveDatasetId(layer: Layer): string {
    return layer.dataset ?? layer.name
  }
}

export function hasSourceConfigType(entry: unknown, type: string): entry is { type: string } {
  return typeof entry === 'object'
    && entry !== null
    && !Array.isArray(entry)
    && (entry as { type?: unknown }).type === type
}

export function toStream<T>(
  items: AsyncIterable<T>,
  options: { signal?: AbortSignal } = {},
  getAbortReason?: (signal: AbortSignal) => unknown
): ReadableStream<T> {
  const iterator = items[Symbol.asyncIterator]()

  return new ReadableStream<T>({
    pull: async (controller) => {
      if (options.signal?.aborted) {
        controller.error(getAbortReason ? getAbortReason(options.signal) : options.signal.reason)
        return
      }

      try {
        const result = await iterator.next()

        if (result.done) {
          controller.close()
          return
        }

        controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
      }
    },

    cancel: async () => {
      await iterator.return?.(undefined)
    }
  })
}
