import type { PathLike } from 'node:fs'
import { open as openFile, type FileHandle } from 'node:fs/promises'
import type { BBox } from '../core/geometry.js'
import type { DescInfo, Feature, SourceRef } from '../core/feature.js'
import { IdFromFeature } from '../core/feature.js'
import { RegistryEntry } from '../core/feature.js'
import { withLazyBbox } from '../core/feature.js'
import { Gt } from '../core/geotools.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import { PageFilter } from '../stream/page-filter.js'
import { PropertyFilter, type PropertyFilterCriteria } from '../stream/property-filter.js'
import type { Layer } from '../layer/layer.js'
import { isPlainObject, Registry } from '../core/tools.js'
import { ClusteredGeoJsonFile, clusteredGeoJsonPath } from './geojson-file.js'

export type SourceStorage = 'mem' | 'file' | 'database'

export type SourceFileRole = 'data' | 'geometry' | 'attributes' | 'index' | 'metadata'

export type SourceFile = {
  role: SourceFileRole | string
  path: PathLike
}

export type SourceIndexConfig = true | {
  rtree?: true | {
    chunkSize?: number
    clustered?: boolean
  }
  properties?: string[]
  [key: string]: unknown
}

export type RequestTimings = {
  accessMs: number
  renderingMs: number
  readFeatures: number
  renderedFeatures: number
}

export type StreamOptions = {
  signal?: AbortSignal
  layer: Layer
  timings?: RequestTimings
}

export type QueryOptions = StreamOptions & {
  bbox?: BBox
  propertyFilter?: PropertyFilterCriteria
  properties?: string[]
  limit?: number
  offset?: number
}

export type FeatureTransform = (feature: Feature, index: number) => Feature | Promise<Feature>

export abstract class Source extends RegistryEntry {
  static readonly registry = new Registry<Source>('SOURCE')

  abstract readonly type: string
  abstract readonly storage: SourceStorage
  readonly indexes?: SourceIndexConfig

  protected constructor(id: string, info: DescInfo = {}) {
    super(id, info)
    const indexes = (info as DescInfo & { indexes?: unknown }).indexes
    if (indexes === true || isPlainObject(indexes)) this.indexes = indexes
  }

  static build(_sourceEntries: Record<string, unknown>): Registry<Source>{
    throw new Error('Source.build is not initialized')
  }

  static create(_name: string,_entry: unknown): Source {
    throw new Error('Source.create is not initialized')
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  abstract getExtent(layer: Layer): Promise<BBox | null>

  abstract stream(options: StreamOptions): ReadableStream<Feature>
  abstract read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null>

  bulk(minRecord: number, maxRecord: number, options: StreamOptions): ReadableStream<Feature> {
    if (options.layer.indexes.has('record')) {
      const recordIndex = options.layer.indexes.get('record') as unknown as {
        streamRange(minRecord: number, maxRecord: number, timings?: RequestTimings): ReadableStream<Feature>
      }

      return recordIndex.streamRange(minRecord, maxRecord, options.timings)
    }

    return this.query({
      ...options,
      offset: minRecord,
      limit: maxRecord - minRecord + 1
    })
  }

  async readById(featureId: string, options: StreamOptions): Promise<Feature | null> {
    const reader = this.stream(options).getReader()

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) return null

        if (IdFromFeature(result.value) === featureId) {
          return result.value
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  query(options: QueryOptions): ReadableStream<Feature> {
    let input = this.stream(options)

    if (options.bbox) {
      input = input.pipeThrough(new BboxFilter(options.bbox))
    }

    if (options.propertyFilter) {
      input = input.pipeThrough(new PropertyFilter(options.propertyFilter))
    }

    if (options.offset !== undefined || options.limit !== undefined) {
      input = input.pipeThrough(new PageFilter({
        offset: options.offset,
        limit: options.limit
      }))
    }

    return input
  }
}

export abstract class FeatureSource extends Source {
  protected constructor(id: string, info: DescInfo = {}, private readonly transformFeature?: FeatureTransform) {
    super(id, info)
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
    const startedAt = performance.now()
    const feature = await this.readFeature(sourceRef, options)
    if (options.timings) options.timings.accessMs += performance.now() - startedAt
    if (!feature) return null
    if (options.timings) options.timings.readFeatures += 1
    return this.mapFeature(feature, sourceRef.recordIndex ?? 0, options.layer)
  }

  protected abstract streamFeatures(options: StreamOptions): AsyncIterable<Feature>
  protected abstract readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null>

  protected abortReason(signal: AbortSignal): unknown {
    return signal.reason
  }

  protected async *mapFeatures(features: AsyncIterable<Feature>, options: StreamOptions): AsyncGenerator<Feature> {
    let index = 0
    const iterator = features[Symbol.asyncIterator]()

    try {
      for (;;) {
        const startedAt = performance.now()
        const result = await iterator.next()
        if (options.timings) options.timings.accessMs += performance.now() - startedAt
        if (result.done) return
        if (options.timings) options.timings.readFeatures += 1

        yield await this.mapFeature(result.value, index, options.layer)
        index += 1
      }
    } finally {
      await iterator.return?.()
    }
  }

  protected async mapFeature(feature: Feature, index: number, layer: Layer): Promise<Feature> {
    const output = this.transformFeature
      ? await this.transformFeature(feature, index)
      : feature

    return withLazyBbox({
      ...output,
      layer,
      crs: layer.crs,
      sourceRef: feature.sourceRef
        ? {
          ...feature.sourceRef,
          recordIndex: feature.sourceRef.recordIndex ?? index
        }
        : undefined
    })
  }
}

export abstract class FileSource extends FeatureSource {
  readonly storage = 'file' as const
  readonly handles = new Map<string, FileHandle>()
  private clusteredFile: ClusteredGeoJsonFile | null = null

  protected constructor(id: string, info: DescInfo = {}, transformFeature?: FeatureTransform) {
    super(id, info, transformFeature)
  }

  override stream(options: StreamOptions): ReadableStream<Feature> {
    if (!this.clusteredFile) return super.stream(options)

    return toStream(
      this.mapFeatures(this.clusteredFile.stream(options), options),
      options,
      (signal) => this.abortReason(signal)
    )
  }

  override async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    if (!this.clusteredFile) return super.read(sourceRef, options)

    const startedAt = performance.now()
    const feature = await this.clusteredFile.read(sourceRef, options)
    if (options.timings) options.timings.accessMs += performance.now() - startedAt
    if (!feature) return null
    if (options.timings) options.timings.readFeatures += 1
    return this.mapFeature(feature, sourceRef.recordIndex ?? 0, options.layer)
  }

  override async open(): Promise<void> {
    if (this.handles.size > 0) return

    const opened: FileHandle[] = []
    try {
      for (const file of this.files) {
        const handle = await openFile(file.path, 'r')
        opened.push(handle)
        this.handles.set(file.role, handle)
      }
    } catch (error) {
      await Promise.allSettled(opened.map((handle) => handle.close()))
      this.handles.clear()
      throw error
    }
  }

  override async close(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.all(handles.map((handle) => handle.close()))
  }

  abstract getFiles(): readonly SourceFile[]

  get files(): readonly SourceFile[] {
    return this.clusteredFile ? [this.clusteredFile.file] : this.getFiles()
  }

  async prepareClusteredIndexSource(layer: Layer): Promise<void> {
    const originalFiles = this.getFiles()
    const primaryFile = FileSource.resolvePrimaryFile(originalFiles, this.id)
    const clusteredFile = new ClusteredGeoJsonFile(this.id, clusteredGeoJsonPath(primaryFile))
    const wasOpen = this.handles.size > 0

    if (wasOpen) await this.close()
    this.clusteredFile = null

    try {
      await this.open()
      await clusteredFile.prepare(layer, originalFiles, () => super.stream({ layer }))
    } finally {
      await this.close()
    }

    this.clusteredFile = clusteredFile
    if (wasOpen) await this.open()
  }

  protected fileHandle(role: SourceFileRole | string = 'data'): FileHandle {
    const handle = this.handles.get(role)
    if (!handle) {
      throw new Error(`FileSource "${this.id}" file role "${role}" is not open`)
    }

    return handle
  }

  protected fileStream(role: SourceFileRole | string = 'data', options: {
    start?: number
    highWaterMark?: number
    signal?: AbortSignal
  } = {}): AsyncIterable<Buffer> {
    const handle = this.fileHandle(role)
    const highWaterMark = options.highWaterMark ?? 64 * 1024
    let position = options.start ?? 0

    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (options.signal?.aborted) throw options.signal.reason

          const buffer = Buffer.allocUnsafe(highWaterMark)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) return

          position += bytesRead
          yield buffer.subarray(0, bytesRead)
        }
      }
    }
  }

  private static resolvePrimaryFile(files: readonly SourceFile[], sourceId: string): SourceFile {
    const sourceFile = files.find((file) => file.role === 'data')
      ?? files.find((file) => file.role === 'geometry')
      ?? files[0]

    if (!sourceFile) {
      throw new Error(`FileSource "${sourceId}" has no source files`)
    }

    return sourceFile
  }
}

export abstract class DbSource extends FeatureSource {
  readonly storage = 'database' as const

  protected constructor(id: string, info: DescInfo = {}, transformFeature?: FeatureTransform) {
    super(id, info, transformFeature)
  }

  override async readById(_featureId: string, _options: StreamOptions): Promise<Feature | null> {
    throw new Error(`${this.type} source must implement readById without a full scan`)
  }

  protected resolveDatasetId(layer: Layer): string {
    return layer.dataset ?? layer.id
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
