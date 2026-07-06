import type { PathLike } from 'node:fs'
import { open as openFile, readdir, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Crs } from '../core/crs.js'
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
import { openPossiblyGzippedReadStream } from '../core/gzip-tools.js'
import { ClusteredPbfFile, clusteredPbfPath, mergeClusteredPbfFiles } from './clustered-pbf-file.js'
import { AbortSignalGuard } from './source-utils.js'

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

export type FileSourceInfo = DescInfo & {
  gzip?: boolean
  indexes?: SourceIndexConfig
}

export type ClusteredWorkerSourceConfig = {
  type: 'geojson'
  encoding: BufferEncoding
  highWaterMark?: number
}

export type RequestTimings = {
  accessMs: number
  reprojectionMs: number
  streamMs: number
  drawMs: number
  drawGeometryMs: number
  textMs: number
  renderingMs: number
  encodingMs: number
  readFeatures: number
  renderedFeatures: number
  bulkCalls: number
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
  static clusteredWorkers = readClusteredWorkers(process.env.GEOC_CLUSTER_WORKERS)

  readonly storage = 'file' as const
  readonly handles = new Map<string, FileHandle>()
  private clusteredFile: ClusteredPbfFile | null = null
  private readonly gzip: boolean
  private clusteredBuildActive = false
  private buildFiles: readonly SourceFile[] | null = null
  clusteredProgressContext = ''

  protected constructor(id: string, info: FileSourceInfo = {}, transformFeature?: FeatureTransform) {
    super(id, info, transformFeature)

    const gzip = (info as { gzip?: unknown }).gzip
    if (gzip !== undefined && typeof gzip !== 'boolean') {
      throw new Error(`FileSource "${id}" gzip option must be a boolean`)
    }
    this.gzip = gzip === true
  }

  override async getExtent(layer: Layer): Promise<BBox | null> {
    this.requireClusteredForGzip()
    return super.getExtent(layer)
  }

  override stream(options: StreamOptions): ReadableStream<Feature> {
    this.requireClusteredForGzip()
    if (!this.clusteredFile) return super.stream(options)

    return toStream(
      this.mapFeatures(this.clusteredFile.stream(options), options),
      options,
      (signal) => this.abortReason(signal)
    )
  }

  override async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    this.requireClusteredForGzip()
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

    const baseFiles = this.clusteredFile ? [this.clusteredFile.file] : this.activeSourceFiles()
    const files = this.clusteredFile ? baseFiles : await FileSource.expandSourceFiles(baseFiles)
    const opened: FileHandle[] = []
    try {
      this.validateGzipFiles(files)
      if (!this.clusteredFile && !this.buildFiles && baseFiles.length === 1 && files.length > 1) {
        await Promise.all(files.map(async (file) => {
          if (!this.isGzipPath(file.path)) return
          const handle = await openFile(file.path, 'r')
          try {
            await this.verifyGzipHeader(handle, file.path)
          } finally {
            await handle.close()
          }
        }))
        return
      }
      for (const file of files) {
        const handle = await openFile(file.path, 'r')
        opened.push(handle)
        if (!this.clusteredFile && this.isGzipPath(file.path)) await this.verifyGzipHeader(handle, file.path)
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
    return this.clusteredFile ? [this.clusteredFile.file] : this.activeSourceFiles()
  }

  protected get clusteredSourceActive(): boolean {
    return this.clusteredFile !== null
  }

  async withClusteredBuildActive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.clusteredBuildActive
    this.clusteredBuildActive = true
    try {
      return await callback()
    } finally {
      this.clusteredBuildActive = previous
    }
  }

  async prepareClusteredIndexSource(layer: Layer, force = false, signal?: AbortSignal): Promise<void> {
    AbortSignalGuard.throwIfAborted(signal, 'Clustered index build aborted')
    const sourceFiles = this.activeSourceFiles()
    const originalFiles = await FileSource.expandSourceFiles(sourceFiles)
    const primaryFile = FileSource.resolvePrimaryFile(originalFiles, this.id)
    const primaryPattern = FileSource.resolvePrimaryFile(sourceFiles, this.id)
    const clusteredFile = new ClusteredPbfFile(this.id, clusteredPbfPath(primaryPattern), undefined, this.clusteredProgressContext)
    const wasOpen = this.handles.size > 0

    if (wasOpen) await this.close()
    this.clusteredFile = null

    try {
      this.clusteredBuildActive = true
      if (sourceFiles.length !== 1 || originalFiles.length === 1) {
        this.buildFiles = originalFiles
        await this.open()
        try {
          await clusteredFile.prepare(layer, originalFiles, () => super.stream({ layer, signal }), force, signal)
        } finally {
          await this.close()
          this.buildFiles = null
        }
      } else {
        const localFiles = await this.prepareClusteredPatternFiles(layer, originalFiles, force, signal)
        await mergeClusteredPbfFiles(layer, localFiles.map((file) => file.path), clusteredFile.path, force, signal)
      }
    } finally {
      this.buildFiles = null
      this.clusteredBuildActive = false
      await this.close().catch(() => undefined)
    }

    this.clusteredFile = clusteredFile
    if (wasOpen) await this.open()
  }

  protected clusteredWorkerConfig(): ClusteredWorkerSourceConfig | null {
    return null
  }

  private async prepareClusteredPatternFiles(
    layer: Layer,
    files: readonly SourceFile[],
    force: boolean,
    signal?: AbortSignal
  ): Promise<ClusteredPbfFile[]> {
    const workerConfig = this.clusteredWorkerConfig()
    const workers = Math.min(FileSource.clusteredWorkers, files.length)
    if (workers <= 1 || !workerConfig) return this.prepareClusteredPatternFilesSequentially(layer, files, force, signal)

    console.log(`[clustered] source=${this.id} workers=${workers} files=${files.length}`)
    const localFiles = files.map((file) => new ClusteredPbfFile(this.id, clusteredPbfPath(file)))
    let nextIndex = 0
    let done = 0
    let failed = 0
    let active = 0
    const started = Date.now()
    const logGlobal = (): void => {
      console.log(`[clustered] source=${this.id} global done=${done}/${files.length} active=${active} failed=${failed} workers=${workers} elapsed=${formatClusteredDuration((Date.now() - started) / 1000)}`)
    }
    const globalTimer = setInterval(logGlobal, 30_000)

    const run = async (workerIndex: number): Promise<void> => {
      for (;;) {
        AbortSignalGuard.throwIfAborted(signal, 'Clustered index build aborted')
        const index = nextIndex
        nextIndex += 1
        if (index >= files.length) return

        const file = files[index]
        const worker = workerIndex + 1
        active += 1
        console.log(`[clustered] source=${this.id} worker=${worker} gz=${index + 1}/${files.length} file=${String(file.path)}`)
        try {
          await runClusteredWorker({
            sourceId: this.id,
            filePath: pathToString(file.path),
            progressContext: `worker=${worker} gz=${index + 1}/${files.length}`,
            crs: clusteredWorkerCrs(layer),
            force,
            source: workerConfig
          }, signal)
          done += 1
        } catch (error) {
          failed += 1
          throw error
        } finally {
          active -= 1
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workers }, (_, workerIndex) => run(workerIndex)))
      logGlobal()
    } finally {
      clearInterval(globalTimer)
    }
    return localFiles
  }

  private async prepareClusteredPatternFilesSequentially(
    layer: Layer,
    files: readonly SourceFile[],
    force: boolean,
    signal?: AbortSignal
  ): Promise<ClusteredPbfFile[]> {
    const localFiles: ClusteredPbfFile[] = []
    for (const [index, file] of files.entries()) {
      AbortSignalGuard.throwIfAborted(signal, 'Clustered index build aborted')
      console.log(`[clustered] source=${this.id} gz=${index + 1}/${files.length} file=${String(file.path)}`)
      this.buildFiles = [file]
      const local = new ClusteredPbfFile(this.id, clusteredPbfPath(file), undefined, `worker=1 gz=${index + 1}/${files.length}`)
      await this.open()
      try {
        await local.prepareInMemory(layer, [file], () => super.stream({ layer, signal }), force, signal)
      } finally {
        await this.close()
        this.buildFiles = null
      }
      localFiles.push(local)
    }
    return localFiles
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
    const file = this.getSourceFile(role)
    if (this.gzip && this.isGzipPath(file.path)) {
      if (options.start !== undefined && options.start !== 0) {
        throw new Error(`FileSource "${this.id}" cannot stream gzip file "${String(file.path)}" from a byte offset`)
      }

      const input = openPossiblyGzippedReadStream(file.path, {
        compression: 'gzip',
        highWaterMark: options.highWaterMark
      })

      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of input.stream) {
              if (options.signal?.aborted) throw options.signal.reason
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
            }
          } finally {
            input.close()
          }
        }
      }
    }

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

  private requireClusteredForGzip(): void {
    if (!this.gzip || this.clusteredFile || this.clusteredBuildActive) return
    throw new Error(`FileSource "${this.id}" gzip source requires a clustered PBF source`)
  }

  private validateGzipFiles(files: readonly SourceFile[]): void {
    if (this.clusteredFile) return

    const gzipFiles = files.filter((file) => this.isGzipPath(file.path))
    if (gzipFiles.length === 0) {
      if (this.gzip) throw new Error(`FileSource "${this.id}" gzip option is enabled but no source file ends with .gz`)
      return
    }

    if (!this.gzip) {
      throw new Error(`FileSource "${this.id}" file "${String(gzipFiles[0].path)}" ends with .gz but gzip option is not enabled`)
    }

    if (gzipFiles.length !== files.length) {
      throw new Error(`FileSource "${this.id}" gzip source requires every source file to end with .gz`)
    }

    if (!FileSource.rtreeClustered(this.indexes)) {
      throw new Error(`FileSource "${this.id}" gzip source requires indexes.rtree.clustered: true`)
    }
  }

  private async verifyGzipHeader(handle: FileHandle, path: PathLike): Promise<void> {
    const header = Buffer.alloc(3)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 3 || header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 0x08) {
      throw new Error(`FileSource "${this.id}" gzip file "${String(path)}" is invalid: missing gzip magic`)
    }
  }

  private getSourceFile(role: SourceFileRole | string): SourceFile {
    const file = this.files.find((item) => item.role === role)
    if (!file) {
      throw new Error(`FileSource "${this.id}" file role "${role}" is not open`)
    }
    return file
  }

  private isGzipPath(path: PathLike): boolean {
    return extname(String(path)).toLowerCase() === '.gz'
  }

  private activeSourceFiles(): readonly SourceFile[] {
    return this.buildFiles ?? this.getFiles()
  }

  private static rtreeClustered(indexes: SourceIndexConfig | undefined): boolean {
    if (!indexes || indexes === true) return false
    const rtree = indexes.rtree
    return typeof rtree === 'object'
      && rtree !== null
      && !Array.isArray(rtree)
      && rtree.clustered === true
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

  private static async expandSourceFiles(files: readonly SourceFile[]): Promise<readonly SourceFile[]> {
    if (files.length !== 1) return files
    const file = files[0]
    const path = pathToString(file.path)
    if (!path.includes('*')) return files

    const dir = dirname(path)
    const pattern = basename(path)
    const regex = globRegex(pattern)
    const names = (await readdir(dir))
      .filter((name) => regex.test(name))
      .sort()

    if (names.length === 0) {
      throw new Error(`FileSource glob "${path}" did not match any file`)
    }

    return names.map((name) => ({
      ...file,
      path: join(dir, name)
    }))
  }
}

function pathToString(path: PathLike): string {
  return path instanceof URL ? fileURLToPath(path) : path.toString()
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function readClusteredWorkers(value: string | undefined): number {
  if (value === undefined || value === '') return 1
  const workers = Number(value)
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error('GEOC_CLUSTER_WORKERS must be a positive integer')
  }
  return workers
}

type ClusteredWorkerMessage = {
  sourceId: string
  filePath: string
  progressContext: string
  crs: {
    code: string
    name?: string
    title: string
    proj4?: string
    precision?: number
  }
  force: boolean
  source: ClusteredWorkerSourceConfig
}

function formatClusteredDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60)
  return `${minutes}m${String(remaining).padStart(2, '0')}s`
}

async function runClusteredWorker(message: ClusteredWorkerMessage, signal?: AbortSignal): Promise<void> {
  const worker = new Worker(new URL('./clustered-pbf-worker.js', import.meta.url), {
    workerData: message
  })

  const abort = () => worker.terminate().catch(() => undefined)
  signal?.addEventListener('abort', abort, { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (value: unknown) => {
        if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === true) resolve()
        else reject(new Error(`Clustered worker failed: ${JSON.stringify(value)}`))
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Clustered worker exited with code ${code}`))
      })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

function clusteredWorkerCrs(layer: Layer): ClusteredWorkerMessage['crs'] {
  if (!Crs.registry.has(layer.crs)) return { code: layer.crs, title: layer.crs }
  const crs = Crs.registry.get(layer.crs)
  const proj4 = (crs.proj as { projStr?: unknown }).projStr
  return {
    code: crs.code,
    name: crs.name,
    title: crs.title,
    ...(typeof proj4 === 'string' ? { proj4 } : {}),
    ...(crs.precision === undefined ? {} : { precision: crs.precision })
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
