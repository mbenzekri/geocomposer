import type { PathLike } from 'node:fs'
import type { BBox, CrsCode } from '../core/geometry.js'
import type { Feature, SourceRef } from '../core/feature.js'
import { Gt } from '../core/geotools.js'
import { BboxFilter } from '../transform/bbox-filter.js'
import {Layer} from '../layer/layer.js'

export type SourceStorage = 'mem' | 'file' | 'database'

export type SourceFileRole = 'data' | 'geometry' | 'attributes' | 'index' | 'metadata'

export type SourceFile = {
  role: SourceFileRole | string
  path: PathLike
}

export type StreamOptions = {
  signal?: AbortSignal,
  layer?: Layer
}

export type QueryOptions = StreamOptions & {
  bbox?: BBox
  crs?: CrsCode
  properties?: string[]
}

export type FeatureTransform = (feature: Feature, index: number) => Feature | Promise<Feature>

export abstract class Source {
  abstract readonly id: string
  abstract readonly type: string
  abstract readonly storage: SourceStorage
  abstract readonly crs: CrsCode

  abstract open(): Promise<void>
  abstract close(): Promise<void>
  abstract getExtent(): Promise<BBox | null>

  abstract stream(options?: StreamOptions): ReadableStream<Feature>
  abstract read(sourceRef: SourceRef,options?: StreamOptions): Promise<Feature | null>

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

  async getExtent(): Promise<BBox | null> {
    let extent: BBox | null = null

    for await (const feature of this.readAll()) {
      const bbox = feature.bbox ?? Gt.bbox(feature.geometry)
      if (bbox) extent = extent ? Gt.expand(extent, bbox) : bbox
    }

    return extent
  }

  stream(options: StreamOptions = {}): ReadableStream<Feature> {
    return toStream(this.readAll(options.signal), options, (signal) => this.abortReason(signal))
  }

  async read(sourceRef: SourceRef): Promise<Feature | null> {
    const feature = await this.readFeature(sourceRef)
    if (!feature) return null
    return this.mapFeature(feature, sourceRef.recordIndex ?? 0)
  }

  protected abstract streamFeatures(signal?: AbortSignal): AsyncIterable<Feature>
  protected abstract readFeature(sourceRef: SourceRef): Promise<Feature | null>

  protected abortReason(signal: AbortSignal): unknown {
    return signal.reason
  }

  private async *readAll(signal?: AbortSignal): AsyncGenerator<Feature> {
    let index = 0

    for await (const feature of this.streamFeatures(signal)) {
      yield await this.mapFeature(feature, index)
      index += 1
    }
  }

  private async mapFeature(feature: Feature, index: number): Promise<Feature> {
    const output = this.transformFeature
      ? await this.transformFeature(feature, index)
      : feature

    return {
      ...output,
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
}

export function toStream<T>(
  items: AsyncIterable<T>,
  options: StreamOptions = {},
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
