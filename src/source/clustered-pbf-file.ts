import type { PathLike } from 'node:fs'
import { mkdir, open as openFile, rm, stat, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Feature, FileRef, SourceRef } from '../core/feature.js'
import { Crs } from '../core/crs.js'
import type { BBox, Geometry, Position } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { Layer } from '../layer/layer.js'
import { Props } from '../core/tools.js'
import type { SourceFile, StreamOptions } from './source.js'
import { AbortSignalGuard, FileByteReader } from './source-utils.js'

const HILBERT_LEVEL = 20
const HILBERT_GRID_SIZE = 2 ** HILBERT_LEVEL
const WEB_MERCATOR_EXTENT = 20037508.342789244
const DEFAULT_HIGH_WATER_MARK = 64 * 1024
const SORT_RUN_FEATURE_LIMIT = 250_000
const SORT_RUN_MERGE_LIMIT = 64
const SORT_RECORD_HEADER_LENGTH = 20
const SORT_WRITE_BUFFER_BYTES = 32 * 1024 * 1024
const CLUSTERED_PBF_MAGIC = 'GEOC-PDF'
const CLUSTERED_PBF_MAGIC_BUFFER = Buffer.from(CLUSTERED_PBF_MAGIC, 'ascii')

const FEATURE_ID_STRING = 1
const FEATURE_ID_NUMBER = 2
const FEATURE_BBOX = 3
const FEATURE_PROPERTIES = 4
const FEATURE_GEOMETRY = 5

const HEADER_VERSION = 1
const HEADER_FEATURE_COUNT = 2
const HEADER_BBOX = 3
const HEADER_DICTIONARY = 4
const HEADER_PROPERTY_STATS = 5
const HEADER_PROPERTY_NAMES = 6

const GEOMETRY_TYPE = 1
const GEOMETRY_PRECISION = 2
const GEOMETRY_DIMENSIONS = 3
const GEOMETRY_COORDS_INT = 4
const GEOMETRY_COORDS_DOUBLE = 5
const GEOMETRY_NESTING = 6

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH_DELIMITED = 2

type SortRecord = {
  hilbert: number
  index: number
  record: Buffer
}

type GeometryTypeCode = 1 | 2 | 3 | 4 | 5 | 6

type FlatGeometry = {
  type: GeometryTypeCode
  positions: Position[]
  nesting: number[]
}

type DecodedGeometry = {
  type?: GeometryTypeCode
  precision?: number
  dimensions?: number
  intCoordinates?: bigint[]
  doubleCoordinates?: number[]
  nesting: number[]
}

type GeometryWithBbox = {
  geometry: Geometry
  bbox?: BBox
}

type PropertyValue = string | number | boolean
type PropertyType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'time' | 'timestamp' | 'mixed'

type PropertyStat = {
  type: PropertyType
  present: number
  min?: PropertyValue
  max?: PropertyValue
}

type ClusteredPbfHeader = {
  version: 1
  featureCount: number
  bbox?: BBox
  propertyNames: string[]
  dictionary: Record<string, PropertyValue[]>
  propertyStats: Record<string, PropertyStat>
}

type PropertySummary = {
  dictionaryValues: PropertyValue[]
  type: PropertyType
  present: number
  min?: PropertyValue
  max?: PropertyValue
}

export class ClusteredPbfFile {
  private readonly codec = new FeaturePbfCodec()
  private header: ClusteredPbfHeader | null = null

  constructor(
    private readonly sourceId: string,
    private readonly filePath: string,
    private readonly highWaterMark = DEFAULT_HIGH_WATER_MARK
  ) {}

  get path(): string {
    return this.filePath
  }

  get file(): SourceFile {
    return {
      role: 'data',
      path: this.filePath
    }
  }

  async prepare(
    layer: Layer,
    originalFiles: readonly SourceFile[],
    streamOriginal: () => ReadableStream<Feature>,
    force = false,
    signal?: AbortSignal
  ): Promise<void> {
    AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
    if (!force && !await this.needsBuild(originalFiles)) return

    const precision = clusteredCoordinatePrecision(layer)
    const tempDir = `${this.filePath}.tmp-sort-${process.pid}-${Date.now()}`
    const progress = new Progress(this.sourceId)
    progress.log('start', 0, `file=${this.filePath}`)

    try {
      const header = await this.buildHeader(streamOriginal, precision, progress, signal)
      await mkdir(tempDir, { recursive: true })
      const runs = await this.writeSortRuns(layer, streamOriginal, header, precision, tempDir, progress, signal)
      const sortedRuns = await this.mergeRuns(runs, tempDir, progress, signal)
      await this.writeSortedRuns(sortedRuns, header, progress, signal)
      progress.log('done', header.featureCount, `runs=${runs.length}`)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  stream(options: StreamOptions): AsyncIterable<Feature> {
    return this.streamFile(options)
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const ref = this.toFileRef(sourceRef)
    const handle = await openFile(this.filePath, 'r')
    const buffer = Buffer.alloc(ref.byteLength)

    try {
      const header = await this.loadHeader(handle)
      const bytesRead = await FileByteReader.readFully(handle, buffer, ref.offset)
      if (bytesRead < ref.byteLength) {
        throw new Error('Invalid clustered PBF sourceRef: byte range exceeds file length')
      }

      return this.withSourceRef(this.codec.decodeRecord(buffer, options.layer, header), {
        storage: 'file',
        sourceId: this.sourceId,
        offset: ref.offset,
        byteLength: ref.byteLength,
        recordIndex: ref.recordIndex
      }, options.layer)
    } finally {
      await handle.close()
    }
  }

  private async buildHeader(
    streamOriginal: () => ReadableStream<Feature>,
    precision: number | undefined,
    progress: Progress,
    signal?: AbortSignal
  ): Promise<ClusteredPbfHeader> {
    const builder = new ClusteredPbfHeaderBuilder()
    let count = 0
    progress.log('header', count)
    await this.readOriginal(streamOriginal, (feature) => {
      builder.add(toWritableFeature(feature, precision))
      count += 1
      progress.tick('header', count)
    }, signal)
    const header = builder.build()
    progress.log('header:done', header.featureCount, `properties=${header.propertyNames.length}`)
    return header
  }

  private async writeSortRuns(
    layer: Layer,
    streamOriginal: () => ReadableStream<Feature>,
    header: ClusteredPbfHeader,
    precision: number | undefined,
    tempDir: string,
    progress: Progress,
    signal?: AbortSignal
  ): Promise<SortRun[]> {
    const runs: SortRun[] = []
    let records: SortRecord[] = []
    let runIndex = 0
    let featureIndex = 0

    const flush = async (): Promise<void> => {
      if (records.length === 0) return
      AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
      records.sort(compareSortRecord)
      runs.push(await writeSortRun(`${tempDir}/run-${runIndex}.bin`, records, signal))
      progress.log('run', featureIndex, `runs=${runs.length} last=${records.length}`)
      runIndex += 1
      records = []
    }

    progress.log('runs', featureIndex)
    await this.readOriginal(streamOriginal, async (feature) => {
      AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
      const writable = toWritableFeature(feature, precision)
      records.push({
        hilbert: hilbertKey(writable, layer),
        index: featureIndex,
        record: this.codec.encodeRecord(writable, precision, header)
      })
      featureIndex += 1
      progress.tick('runs', featureIndex, `runs=${runs.length}`)

      if (records.length >= SORT_RUN_FEATURE_LIMIT) await flush()
    }, signal)

    await flush()
    progress.log('runs:done', featureIndex, `runs=${runs.length}`)
    return runs
  }

  private async mergeRuns(runs: SortRun[], tempDir: string, progress: Progress, signal?: AbortSignal): Promise<SortRun[]> {
    let current = runs
    let pass = 0
    progress.log('merge', 0, `runs=${current.length}`)

    while (current.length > SORT_RUN_MERGE_LIMIT) {
      const next: SortRun[] = []
      for (let index = 0; index < current.length; index += SORT_RUN_MERGE_LIMIT) {
        AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
        const group = current.slice(index, index + SORT_RUN_MERGE_LIMIT)
        next.push(await mergeSortRuns(group, `${tempDir}/merge-${pass}-${next.length}.bin`, signal))
        progress.log('merge', 0, `pass=${pass} group=${next.length} input=${group.length} output=${next[next.length - 1].count}`)
        await Promise.all(group.map((run) => rm(run.path, { force: true })))
      }
      current = next
      pass += 1
    }

    progress.log('merge:done', 0, `runs=${current.length}`)
    return current
  }

  private async writeSortedRuns(runs: readonly SortRun[], header: ClusteredPbfHeader, progress: Progress, signal?: AbortSignal): Promise<void> {
    const handle = await openFile(this.filePath, 'w')
    const writer = new BufferedFileWriter(handle)
    const headerRecord = this.codec.encodeHeaderRecord(header)
    let count = 0

    try {
      progress.log('write', count, `runs=${runs.length}`)
      await writer.write(CLUSTERED_PBF_MAGIC_BUFFER)
      await writer.write(headerRecord)

      const cursors = await Promise.all(runs.map((run) => SortRunCursor.open(run)))
      const heap = new SortRecordHeap()
      try {
        for (const cursor of cursors) {
          const record = await cursor.next()
          if (record) heap.push({ cursor, record })
      }

      for (;;) {
        const item = heap.pop()
        if (!item) break
        AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
        await writer.write(item.record.record)
          count += 1
          progress.tick('write', count, `runs=${runs.length}`)

          const next = await item.cursor.next()
          if (next) heap.push({ cursor: item.cursor, record: next })
        }
      } finally {
        await Promise.allSettled(cursors.map((cursor) => cursor.close()))
      }

      await writer.flush()
      this.header = header
      progress.log('write:done', count)
    } finally {
      await handle.close()
    }
  }

  private async readOriginal(
    streamOriginal: () => ReadableStream<Feature>,
    onFeature: (feature: Feature) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    const reader = streamOriginal().getReader()

    try {
      for (;;) {
        AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
        const result = await reader.read()
        if (result.done) break
        await onFeature(result.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private async *streamFile(options: StreamOptions): AsyncGenerator<Feature> {
    const handle = await openFile(this.filePath, 'r')
    const parser = new DelimitedPbfParser(CLUSTERED_PBF_MAGIC_BUFFER.length)
    let header: ClusteredPbfHeader | null = this.header
    let headerRead = false
    let position = CLUSTERED_PBF_MAGIC_BUFFER.length

    try {
      await assertMagic(handle)
      for (;;) {
        AbortSignalGuard.throwIfAborted(options.signal, 'Clustered PBF stream aborted')
        const buffer = Buffer.allocUnsafe(this.highWaterMark)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break

        parser.push(buffer.subarray(0, bytesRead))
        position += bytesRead

        for (;;) {
          const record = parser.read()
          if (!record) break

          if (!headerRead) {
            header = this.codec.decodeHeaderMessage(record.message)
            headerRead = true
            this.header = header
            continue
          }

          if (!header) throw new Error('Invalid clustered PBF: missing header')
          yield this.withSourceRef(this.codec.decodeMessage(record.message, options.layer, header), {
            storage: 'file',
            sourceId: this.sourceId,
            offset: record.offset,
            byteLength: record.byteLength
          }, options.layer)
        }
      }

      parser.finish()
    } finally {
      await handle.close()
    }
  }

  private async loadHeader(handle: FileHandle): Promise<ClusteredPbfHeader> {
    if (this.header) return this.header

    await assertMagic(handle)
    const firstRecord = await readDelimitedRecordAt(handle, CLUSTERED_PBF_MAGIC_BUFFER.length)
    const header = this.codec.decodeHeaderRecord(firstRecord)
    this.header = header
    return this.header
  }

  private withSourceRef(feature: Feature, sourceRef: SourceRef, layer: Layer): Feature {
    return {
      ...feature,
      layer,
      sourceRef
    }
  }

  private toFileRef(sourceRef: SourceRef): FileRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.sourceId) {
      throw new Error(`Clustered PBF sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (typeof (sourceRef as Partial<FileRef>).offset !== 'number' || typeof (sourceRef as Partial<FileRef>).byteLength !== 'number') {
      throw new Error('Clustered PBF sourceRef must include offset and byteLength')
    }

    return sourceRef as FileRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }

  private async needsBuild(originalFiles: readonly SourceFile[]): Promise<boolean> {
    const clusteredStat = await stat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })

    if (!clusteredStat) return true

    for (const file of originalFiles) {
      if (clusteredStat.mtimeMs < (await stat(pathToString(file.path))).mtimeMs) return true
    }

    return false
  }
}

export async function mergeClusteredPbfFiles(
  layer: Layer,
  inputPaths: readonly string[],
  outputPath: string,
  force = false,
  signal?: AbortSignal
): Promise<void> {
  AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF merge aborted')
  if (inputPaths.length === 0) throw new Error('Cannot merge clustered PBF files: no input files')

  const outputStat = await stat(outputPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!force && outputStat) {
    let newestInput = 0
    for (const inputPath of inputPaths) newestInput = Math.max(newestInput, (await stat(inputPath)).mtimeMs)
    if (outputStat.mtimeMs >= newestInput) return
  }

  const codec = new FeaturePbfCodec()
  const precision = clusteredCoordinatePrecision(layer)
  const headers = await Promise.all(inputPaths.map((path) => readClusteredHeader(path, codec)))
  const header = mergeClusteredHeaders(headers)
  const handle = await openFile(outputPath, 'w')
  const writer = new BufferedFileWriter(handle)
  const progress = new Progress(`merge:${layer.source.id}`)
  let count = 0

  try {
    progress.log('start', count, `files=${inputPaths.length} output=${outputPath}`)
    await writer.write(CLUSTERED_PBF_MAGIC_BUFFER)
    await writer.write(codec.encodeHeaderRecord(header))

    const cursors = await Promise.all(inputPaths.map((path, index) => ClusteredPbfCursor.open(path, index, layer, codec)))
    const heap = new MergeFeatureHeap()
    try {
      progress.log('write', count, `files=${inputPaths.length}`)
      for (const cursor of cursors) {
        const record = await cursor.next()
        if (record) heap.push({ cursor, record })
      }

      for (;;) {
        const item = heap.pop()
        if (!item) break
        AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF merge aborted')
        await writer.write(codec.encodeRecord(item.record.feature, precision, header))
        count += 1
        progress.tick('write', count, `files=${inputPaths.length}`)
        const next = await item.cursor.next()
        if (next) heap.push({ cursor: item.cursor, record: next })
      }
    } finally {
      await Promise.allSettled(cursors.map((cursor) => cursor.close()))
    }

    await writer.flush()
    progress.log('done', count, `files=${inputPaths.length}`)
  } finally {
    await handle.close()
  }
}

type SortRun = {
  path: string
  count: number
}

type HeapItem = {
  cursor: SortRunCursor
  record: SortRecord
}

type MergeRecord = {
  feature: Feature
  hilbert: number
  source: number
  index: number
}

type MergeHeapItem = {
  cursor: ClusteredPbfCursor
  record: MergeRecord
}

async function readClusteredHeader(path: string, codec: FeaturePbfCodec): Promise<ClusteredPbfHeader> {
  const handle = await openFile(path, 'r')
  try {
    await assertMagic(handle)
    return codec.decodeHeaderRecord(await readDelimitedRecordAt(handle, CLUSTERED_PBF_MAGIC_BUFFER.length))
  } finally {
    await handle.close()
  }
}

function mergeClusteredHeaders(headers: readonly ClusteredPbfHeader[]): ClusteredPbfHeader {
  const propertyNames: string[] = []
  const propertySeen = new Set<string>()
  const propertyStats: Record<string, PropertyStat> = {}
  const dictionaryCandidates = new Map<string, Map<string, PropertyValue>>()
  const dictionaryRejected = new Set<string>()
  let featureCount = 0
  let bbox: BBox | undefined

  for (const header of headers) {
    featureCount += header.featureCount
    if (header.bbox) bbox = bbox ? Gt.expand(bbox, header.bbox) : header.bbox

    for (const name of header.propertyNames) {
      if (!propertySeen.has(name)) {
        propertySeen.add(name)
        propertyNames.push(name)
      }

      const stat = header.propertyStats[name]
      if (stat) propertyStats[name] = mergePropertyStat(propertyStats[name], stat)

      const values = header.dictionary[name]
      if (!values && stat?.present) {
        dictionaryRejected.add(name)
        dictionaryCandidates.delete(name)
        continue
      }
      if (!values || dictionaryRejected.has(name)) continue

      const candidate = dictionaryCandidates.get(name) ?? new Map<string, PropertyValue>()
      for (const value of values) {
        candidate.set(`${typeof value}:${String(value)}`, value)
        if (candidate.size > 100) {
          dictionaryRejected.add(name)
          dictionaryCandidates.delete(name)
          break
        }
      }
      if (!dictionaryRejected.has(name)) dictionaryCandidates.set(name, candidate)
    }
  }

  const dictionary: Record<string, PropertyValue[]> = {}
  for (const [name, values] of dictionaryCandidates) {
    if (!dictionaryRejected.has(name) && values.size > 0 && propertyStats[name]?.type !== 'mixed') {
      dictionary[name] = [...values.values()]
    }
  }

  return {
    version: 1,
    featureCount,
    ...(bbox ? { bbox } : {}),
    propertyNames,
    dictionary,
    propertyStats
  }
}

function mergePropertyStat(left: PropertyStat | undefined, right: PropertyStat): PropertyStat {
  if (!left) return { ...right }
  const type = mergePropertyType(left.type, right.type)
  return {
    type,
    present: left.present + right.present,
    ...(type === 'mixed' ? {} : mergeMinMax(left, right, type))
  }
}

function mergePropertyType(left: PropertyType, right: PropertyType): PropertyType {
  if (left === right) return left
  if ((left === 'integer' || left === 'number') && (right === 'integer' || right === 'number')) return 'number'
  if (isStringType(left) && isStringType(right)) return 'string'
  return 'mixed'
}

function mergeMinMax(left: PropertyStat, right: PropertyStat, type: PropertyType): { min?: PropertyValue, max?: PropertyValue } {
  const values = [left.min, left.max, right.min, right.max].filter((value): value is PropertyValue => value !== undefined)
  if (values.length === 0) return {}
  let min = values[0]
  let max = values[0]
  for (const value of values.slice(1)) {
    if (comparePropertyValues(value, min, type) < 0) min = value
    if (comparePropertyValues(value, max, type) > 0) max = value
  }
  return { min, max }
}

class ClusteredPbfCursor {
  private readonly parser = new DelimitedPbfParser(CLUSTERED_PBF_MAGIC_BUFFER.length)
  private position = CLUSTERED_PBF_MAGIC_BUFFER.length
  private headerRead = false
  private index = 0
  private pending: { message: Buffer }[] = []

  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
    private readonly source: number,
    private readonly layer: Layer,
    private readonly codec: FeaturePbfCodec,
    private readonly header: ClusteredPbfHeader
  ) {}

  static async open(path: string, source: number, layer: Layer, codec: FeaturePbfCodec): Promise<ClusteredPbfCursor> {
    const handle = await openFile(path, 'r')
    try {
      await assertMagic(handle)
      const header = codec.decodeHeaderRecord(await readDelimitedRecordAt(handle, CLUSTERED_PBF_MAGIC_BUFFER.length))
      return new ClusteredPbfCursor(handle, path, source, layer, codec, header)
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async next(): Promise<MergeRecord | null> {
    for (;;) {
      const pending = this.pending.shift()
      if (pending) return this.toMergeRecord(pending.message)

      const buffer = Buffer.allocUnsafe(DEFAULT_HIGH_WATER_MARK)
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, this.position)
      if (bytesRead === 0) return null
      this.position += bytesRead
      this.parser.push(buffer.subarray(0, bytesRead))

      for (;;) {
        const record = this.parser.read()
        if (!record) break
        if (!this.headerRead) {
          this.headerRead = true
          continue
        }
        this.pending.push({ message: record.message })
      }
    }
  }

  close(): Promise<void> {
    return this.handle.close()
  }

  private toMergeRecord(message: Buffer): MergeRecord {
    const feature = this.codec.decodeMessage(message, this.layer, this.header)
    const record = {
      feature,
      hilbert: hilbertKey(feature, this.layer),
      source: this.source,
      index: this.index
    }
    this.index += 1
    return record
  }
}

class MergeFeatureHeap {
  private readonly items: MergeHeapItem[] = []

  push(item: MergeHeapItem): void {
    this.items.push(item)
    this.up(this.items.length - 1)
  }

  pop(): MergeHeapItem | null {
    if (this.items.length === 0) return null
    const first = this.items[0]
    const last = this.items.pop()
    if (last && this.items.length > 0) {
      this.items[0] = last
      this.down(0)
    }
    return first
  }

  private up(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareMergeRecord(this.items[parent].record, this.items[index].record) <= 0) return
      this.swap(parent, index)
      index = parent
    }
  }

  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index

      if (left < this.items.length && compareMergeRecord(this.items[left].record, this.items[smallest].record) < 0) smallest = left
      if (right < this.items.length && compareMergeRecord(this.items[right].record, this.items[smallest].record) < 0) smallest = right
      if (smallest === index) return
      this.swap(index, smallest)
      index = smallest
    }
  }

  private swap(a: number, b: number): void {
    const item = this.items[a]
    this.items[a] = this.items[b]
    this.items[b] = item
  }
}

function compareMergeRecord(left: MergeRecord, right: MergeRecord): number {
  return left.hilbert - right.hilbert || left.source - right.source || left.index - right.index
}

class Progress {
  private readonly start = Date.now()
  private stageStart = this.start
  private stageStartCount = 0
  private last = this.start
  private lastCount = 0
  private lastStage = ''

  constructor(private readonly sourceId: string) {}

  tick(stage: string, count: number, extra = ''): void {
    const now = Date.now()
    if (now - this.last < 5_000) return
    this.write(stage, count, extra, now)
  }

  log(stage: string, count: number, extra = ''): void {
    this.write(stage, count, extra, Date.now())
  }

  private write(stage: string, count: number, extra: string, now: number): void {
    const rateStage = stage === 'run' ? 'runs' : stage.split(':', 1)[0] ?? stage
    if (rateStage !== this.lastStage) {
      this.stageStart = now
      this.stageStartCount = count
      this.last = now
      this.lastCount = count
      this.lastStage = rateStage
    }

    const elapsedTotal = Math.max(0.001, (now - this.start) / 1000)
    const elapsedStage = Math.max(0.001, (now - this.stageStart) / 1000)
    const recent = Math.max(0.001, (now - this.last) / 1000)
    const stageFeatures = count - this.stageStartCount
    const avgStage = stageFeatures / elapsedStage
    const recentRate = (count - this.lastCount) / recent
    const recentText = stage.endsWith(':done') && count === this.lastCount ? '' : ` recent=${formatFeatureRate(recentRate)}`
    const suffix = extra ? ` ${extra}` : ''
    console.log(`[clustered] source=${this.sourceId} stage=${stage} features=${count} elapsed=${formatDuration(elapsedTotal)} stageElapsed=${formatDuration(elapsedStage)} avg=${formatFeatureRate(avgStage)}${recentText}${suffix}`)
    this.last = now
    this.lastCount = count
    this.lastStage = rateStage
  }
}

async function writeSortRun(path: string, records: readonly SortRecord[], signal?: AbortSignal): Promise<SortRun> {
  const handle = await openFile(path, 'w')
  const writer = new BufferedFileWriter(handle)

  try {
    for (const record of records) {
      AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
      await writer.write(encodeSortRecord(record))
    }
    await writer.flush()
  } finally {
    await handle.close()
  }

  return { path, count: records.length }
}

async function mergeSortRuns(runs: readonly SortRun[], outputPath: string, signal?: AbortSignal): Promise<SortRun> {
  const output = await openFile(outputPath, 'w')
  const writer = new BufferedFileWriter(output)
  const cursors = await Promise.all(runs.map((run) => SortRunCursor.open(run)))
  const heap = new SortRecordHeap()
  let count = 0

  try {
    for (const cursor of cursors) {
      AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
      const record = await cursor.next()
      if (record) heap.push({ cursor, record })
    }

    for (;;) {
      const item = heap.pop()
      if (!item) break
      AbortSignalGuard.throwIfAborted(signal, 'Clustered PBF build aborted')
      await writer.write(encodeSortRecord(item.record))
      count += 1

      const next = await item.cursor.next()
      if (next) heap.push({ cursor: item.cursor, record: next })
    }
    await writer.flush()
  } finally {
    await Promise.allSettled(cursors.map((cursor) => cursor.close()))
    await output.close()
  }

  return { path: outputPath, count }
}

class BufferedFileWriter {
  private readonly buffers: Buffer[] = []
  private byteLength = 0
  private position = 0

  constructor(private readonly handle: FileHandle) {}

  async write(buffer: Buffer): Promise<void> {
    this.buffers.push(buffer)
    this.byteLength += buffer.length
    if (this.byteLength >= SORT_WRITE_BUFFER_BYTES) await this.flush()
  }

  async flush(): Promise<void> {
    if (this.byteLength === 0) return
    const buffer = this.buffers.length === 1 ? this.buffers[0] : Buffer.concat(this.buffers, this.byteLength)
    await this.handle.write(buffer, 0, buffer.length, this.position)
    this.position += buffer.length
    this.buffers.length = 0
    this.byteLength = 0
  }
}

function encodeSortRecord(record: SortRecord): Buffer {
  const buffer = Buffer.allocUnsafe(SORT_RECORD_HEADER_LENGTH + record.record.length)
  buffer.writeBigUInt64LE(BigInt(record.hilbert), 0)
  buffer.writeBigUInt64LE(BigInt(record.index), 8)
  buffer.writeUInt32LE(record.record.length, 16)
  record.record.copy(buffer, SORT_RECORD_HEADER_LENGTH)
  return buffer
}

function compareSortRecord(a: SortRecord, b: SortRecord): number {
  return a.hilbert - b.hilbert || a.index - b.index
}

function formatFeatureRate(value: number): string {
  if (!Number.isFinite(value)) return '0 features/s'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M features/s`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k features/s`
  return `${value.toFixed(0)} features/s`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}m${String(rest).padStart(2, '0')}s`
}

class SortRunCursor {
  private position = 0
  private remaining: number

  private constructor(
    private readonly handle: FileHandle,
    private readonly run: SortRun
  ) {
    this.remaining = run.count
  }

  static async open(run: SortRun): Promise<SortRunCursor> {
    return new SortRunCursor(await openFile(run.path, 'r'), run)
  }

  async next(): Promise<SortRecord | null> {
    if (this.remaining === 0) return null

    const header = Buffer.allocUnsafe(SORT_RECORD_HEADER_LENGTH)
    const headerRead = await FileByteReader.readFully(this.handle, header, this.position)
    if (headerRead < header.length) throw new Error(`Invalid clustered sort run "${this.run.path}": truncated record header`)

    const hilbert = Number(header.readBigUInt64LE(0))
    const index = Number(header.readBigUInt64LE(8))
    const byteLength = header.readUInt32LE(16)
    const record = Buffer.allocUnsafe(byteLength)
    const recordRead = await FileByteReader.readFully(this.handle, record, this.position + SORT_RECORD_HEADER_LENGTH)
    if (recordRead < record.length) throw new Error(`Invalid clustered sort run "${this.run.path}": truncated record`)

    this.position += SORT_RECORD_HEADER_LENGTH + byteLength
    this.remaining -= 1
    return { hilbert, index, record }
  }

  close(): Promise<void> {
    return this.handle.close()
  }
}

class SortRecordHeap {
  private readonly items: HeapItem[] = []

  push(item: HeapItem): void {
    this.items.push(item)
    this.up(this.items.length - 1)
  }

  pop(): HeapItem | null {
    if (this.items.length === 0) return null
    const first = this.items[0]
    const last = this.items.pop()
    if (last && this.items.length > 0) {
      this.items[0] = last
      this.down(0)
    }
    return first
  }

  private up(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareSortRecord(this.items[parent].record, this.items[index].record) <= 0) return
      this.swap(parent, index)
      index = parent
    }
  }

  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index

      if (left < this.items.length && compareSortRecord(this.items[left].record, this.items[smallest].record) < 0) {
        smallest = left
      }
      if (right < this.items.length && compareSortRecord(this.items[right].record, this.items[smallest].record) < 0) {
        smallest = right
      }
      if (smallest === index) return
      this.swap(index, smallest)
      index = smallest
    }
  }

  private swap(a: number, b: number): void {
    const item = this.items[a]
    this.items[a] = this.items[b]
    this.items[b] = item
  }
}

export function clusteredPbfPath(sourceFile: SourceFile): string {
  return `${pathToString(sourceFile.path)}.clustered.pbf`
}

function pathToString(path: PathLike): string {
  if (path instanceof URL) return fileURLToPath(path)
  return path.toString()
}

async function assertMagic(handle: FileHandle): Promise<void> {
  const buffer = Buffer.alloc(CLUSTERED_PBF_MAGIC_BUFFER.length)
  const bytesRead = await FileByteReader.readFully(handle, buffer, 0)
  if (bytesRead < buffer.length || !buffer.equals(CLUSTERED_PBF_MAGIC_BUFFER)) {
    throw new Error(`Invalid clustered PBF magic, expected "${CLUSTERED_PBF_MAGIC}"`)
  }
}

async function readDelimitedRecordAt(handle: FileHandle, offset: number): Promise<Buffer> {
  const prefix = Buffer.alloc(10)
  let prefixLength = 0

  for (;;) {
    const byte = Buffer.alloc(1)
    const { bytesRead } = await handle.read(byte, 0, 1, offset + prefixLength)
    if (bytesRead === 0) throw new Error('Invalid clustered PBF: missing header record')
    prefix[prefixLength] = byte[0]
    prefixLength += 1
    if ((byte[0] & 0x80) === 0) break
    if (prefixLength === prefix.length) throw new Error('Invalid clustered PBF: header length varint is too long')
  }

  const length = readVarint(prefix.subarray(0, prefixLength), 0)
  const byteLength = prefixLength + Number(length.value)
  const record = Buffer.alloc(byteLength)
  prefix.copy(record, 0, 0, prefixLength)
  const bytesRead = await FileByteReader.readFully(handle, record.subarray(prefixLength), offset + prefixLength)
  if (bytesRead < byteLength - prefixLength) throw new Error('Invalid clustered PBF: truncated header record')
  return record
}

class ClusteredPbfHeaderBuilder {
  private featureCount = 0
  private bbox: BBox | undefined
  private readonly properties = new Map<string, PropertySummaryBuilder>()

  add(feature: Feature): void {
    this.featureCount += 1
    if (feature.bbox) this.bbox = this.bbox ? Gt.expand(this.bbox, feature.bbox) : feature.bbox

    for (const [name, value] of Object.entries(normalizeProperties(feature.properties))) {
      const propertyValue = toPropertyValue(value)
      if (propertyValue === undefined) continue
      let summary = this.properties.get(name)
      if (!summary) {
        summary = new PropertySummaryBuilder()
        this.properties.set(name, summary)
      }
      summary.add(propertyValue)
    }
  }

  build(): ClusteredPbfHeader {
    const dictionary: Record<string, PropertyValue[]> = {}
    const propertyStats: Record<string, PropertyStat> = {}

    for (const [name, builder] of this.properties) {
      const summary = builder.build()
      if (summary.dictionaryValues.length > 0 && summary.dictionaryValues.length <= 100) {
        dictionary[name] = summary.dictionaryValues
      }

      propertyStats[name] = {
        type: summary.type,
        present: summary.present,
        ...(summary.min === undefined ? {} : { min: summary.min }),
        ...(summary.max === undefined ? {} : { max: summary.max })
      }
    }

    return {
      version: 1,
      featureCount: this.featureCount,
      ...(this.bbox ? { bbox: this.bbox } : {}),
      propertyNames: [...this.properties.keys()],
      dictionary,
      propertyStats
    }
  }
}

class PropertySummaryBuilder {
  private type: PropertyType | undefined
  private present = 0
  private min: PropertyValue | undefined
  private max: PropertyValue | undefined
  private readonly distinctKeys = new Set<string>()
  private readonly distinctValues: PropertyValue[] = []
  private dictionaryOverflow = false
  private stringDate = true
  private stringTime = true
  private stringTimestamp = true

  add(value: PropertyValue): void {
    this.present += 1
    this.updateType(value)
    if (this.type !== 'mixed') {
      this.updateMinMax(value)
      this.updateDictionary(value)
    }
  }

  build(): PropertySummary {
    const type = this.type ?? 'mixed'
    return {
      dictionaryValues: type === 'mixed' || this.dictionaryOverflow ? [] : this.distinctValues,
      type,
      present: this.present,
      ...(type === 'mixed' || this.min === undefined ? {} : { min: this.min }),
      ...(type === 'mixed' || this.max === undefined ? {} : { max: this.max })
    }
  }

  private updateType(value: PropertyValue): void {
    const valueType = propertyValueType(value)
    if (this.type === undefined) {
      this.type = valueType
      this.updateStringSubType(value)
      return
    }

    if (this.type === 'mixed') return

    if ((this.type === 'integer' || this.type === 'number') && (valueType === 'integer' || valueType === 'number')) {
      this.type = this.type === 'number' || valueType === 'number' ? 'number' : 'integer'
      return
    }

    if (isStringType(this.type) && valueType === 'string') {
      this.updateStringSubType(value)
      this.type = this.stringDate ? 'date' : this.stringTime ? 'time' : this.stringTimestamp ? 'timestamp' : 'string'
      return
    }

    if (this.type !== valueType) this.type = 'mixed'
  }

  private updateStringSubType(value: PropertyValue): void {
    if (typeof value !== 'string') return
    this.stringDate &&= isIsoDate(value)
    this.stringTime &&= isIsoTime(value)
    this.stringTimestamp &&= isIsoTimestamp(value)
    if (this.type === 'string') this.type = this.stringDate ? 'date' : this.stringTime ? 'time' : this.stringTimestamp ? 'timestamp' : 'string'
  }

  private updateMinMax(value: PropertyValue): void {
    const type = this.type ?? propertyValueType(value)
    if (this.min === undefined || comparePropertyValues(value, this.min, type) < 0) this.min = value
    if (this.max === undefined || comparePropertyValues(value, this.max, type) > 0) this.max = value
  }

  private updateDictionary(value: PropertyValue): void {
    if (this.dictionaryOverflow) return
    const key = `${typeof value}:${String(value)}`
    if (this.distinctKeys.has(key)) return
    this.distinctKeys.add(key)
    this.distinctValues.push(value)
    if (this.distinctValues.length > 100) {
      this.dictionaryOverflow = true
      this.distinctValues.length = 0
      this.distinctKeys.clear()
    }
  }
}

function normalizeProperties(properties: Props | null | undefined): Props {
  const output: Props = {}
  if (!properties) return output

  for (const [name, value] of Object.entries(properties)) {
    if (value !== null && value !== undefined) output[name] = value
  }

  return output
}

function toPropertyValue(value: unknown): PropertyValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function propertyValueType(value: PropertyValue): PropertyType {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'integer' : 'number'
  return 'string'
}

function isStringType(type: PropertyType): boolean {
  return type === 'string' || type === 'date' || type === 'time' || type === 'timestamp'
}

function distinctValues(values: readonly PropertyValue[]): PropertyValue[] {
  const seen = new Set<string>()
  const distinct: PropertyValue[] = []

  for (const value of values) {
    const key = `${typeof value}:${String(value)}`
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(value)
    if (distinct.length > 100) return []
  }

  return distinct
}

function propertyType(values: readonly PropertyValue[]): PropertyType {
  if (values.every((value) => typeof value === 'boolean')) return 'boolean'
  if (values.every((value) => typeof value === 'number')) {
    return values.every((value) => Number.isSafeInteger(value)) ? 'integer' : 'number'
  }

  if (values.every((value) => typeof value === 'string')) {
    const strings = values as string[]
    if (strings.every(isIsoDate)) return 'date'
    if (strings.every(isIsoTime)) return 'time'
    if (strings.every(isIsoTimestamp)) return 'timestamp'
    return 'string'
  }

  return 'mixed'
}

function propertyMinMax(values: readonly PropertyValue[], type: PropertyType): { min: PropertyValue, max: PropertyValue } {
  let min = values[0]
  let max = values[0]

  for (const value of values.slice(1)) {
    if (comparePropertyValues(value, min, type) < 0) min = value
    if (comparePropertyValues(value, max, type) > 0) max = value
  }

  return { min, max }
}

function comparePropertyValues(a: PropertyValue, b: PropertyValue, type: PropertyType): number {
  if (type === 'boolean') return Number(a) - Number(b)
  if (type === 'integer' || type === 'number') return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isIsoTime(value: string): boolean {
  return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
}

function encodeProperties(properties: Props, header: ClusteredPbfHeader): Array<PropertyValue | null> {
  const normalized = normalizeProperties(properties)
  const output = header.propertyNames.map((name): PropertyValue | null => {
    const value = toPropertyValue(normalized[name])
    if (value === undefined) return null

    const dictionary = header.dictionary[name]
    if (!dictionary) return value

    const index = dictionary.findIndex((item) => item === value)
    if (index < 0) throw new Error(`Clustered PBF dictionary for property "${name}" does not contain value "${String(value)}"`)
    return index
  })

  while (output.length > 0 && output[output.length - 1] === null) output.pop()

  return output
}

function decodeProperties(values: unknown, header: ClusteredPbfHeader): Props {
  if (!Array.isArray(values)) throw new Error('Invalid clustered PBF properties: expected an array')
  const output: Props = {}

  for (let index = 0; index < values.length; index += 1) {
    const name = header.propertyNames[index]
    if (!name) continue
    const value = values[index]
    if (value === null || value === undefined) continue

    const dictionary = header.dictionary[name]
    if (!dictionary) {
      output[name] = value
      continue
    }

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= dictionary.length) {
      throw new Error(`Invalid clustered PBF dictionary index for property "${name}"`)
    }
    output[name] = dictionary[value]
  }

  return output
}

class FeaturePbfCodec {
  encodeHeaderRecord(header: ClusteredPbfHeader): Buffer {
    const message = Buffer.concat([
      writeUInt(HEADER_VERSION, BigInt(header.version)),
      writeUInt(HEADER_FEATURE_COUNT, BigInt(header.featureCount)),
      ...(header.bbox ? [writePackedDouble(HEADER_BBOX, header.bbox)] : []),
      writeString(HEADER_DICTIONARY, JSON.stringify(header.dictionary)),
      writeString(HEADER_PROPERTY_STATS, JSON.stringify(header.propertyStats)),
      writeString(HEADER_PROPERTY_NAMES, JSON.stringify(header.propertyNames))
    ])
    return Buffer.concat([encodeVarint(BigInt(message.length)), message])
  }

  decodeHeaderRecord(record: Buffer): ClusteredPbfHeader {
    const length = readVarint(record, 0)
    const start = length.next
    const end = start + Number(length.value)
    if (end !== record.length) throw new Error('Invalid clustered PBF record length')
    return this.decodeHeaderMessage(record.subarray(start, end))
  }

  decodeHeaderMessage(buffer: Buffer): ClusteredPbfHeader {
    const firstTag = tryReadVarint(buffer, 0)
    if (!firstTag || Number(firstTag.value >> 3n) !== HEADER_VERSION || Number(firstTag.value & 7n) !== WIRE_VARINT) {
      throw new Error('Invalid clustered PBF: missing header')
    }

    let position = 0
    let version: number | undefined
    let featureCount: number | undefined
    let bbox: BBox | undefined
    let propertyNames: string[] = []
    let dictionary: Record<string, PropertyValue[]> = {}
    let propertyStats: Record<string, PropertyStat> = {}

    while (position < buffer.length) {
      const tag = readVarint(buffer, position)
      position = tag.next
      const field = Number(tag.value >> 3n)
      const wireType = Number(tag.value & 7n)

      switch (field) {
        case HEADER_VERSION: {
          assertWireType(wireType, WIRE_VARINT)
          const value = readVarint(buffer, position)
          version = Number(value.value)
          position = value.next
          break
        }
        case HEADER_FEATURE_COUNT: {
          assertWireType(wireType, WIRE_VARINT)
          const value = readVarint(buffer, position)
          featureCount = Number(value.value)
          position = value.next
          break
        }
        case HEADER_BBOX: {
          const value = readLengthDelimited(buffer, position, wireType)
          const values = readPackedDouble(value.buffer)
          if (values.length === 4) bbox = values as BBox
          position = value.next
          break
        }
        case HEADER_DICTIONARY: {
          const value = readLengthDelimited(buffer, position, wireType)
          dictionary = JSON.parse(value.buffer.toString('utf8')) as Record<string, PropertyValue[]>
          position = value.next
          break
        }
        case HEADER_PROPERTY_STATS: {
          const value = readLengthDelimited(buffer, position, wireType)
          propertyStats = JSON.parse(value.buffer.toString('utf8')) as Record<string, PropertyStat>
          position = value.next
          break
        }
        case HEADER_PROPERTY_NAMES: {
          const value = readLengthDelimited(buffer, position, wireType)
          propertyNames = JSON.parse(value.buffer.toString('utf8')) as string[]
          position = value.next
          break
        }
        default:
          position = skipField(buffer, position, wireType)
      }
    }

    if (version !== 1 || featureCount === undefined) throw new Error('Invalid clustered PBF header')
    return {
      version,
      featureCount,
      ...(bbox ? { bbox } : {}),
      propertyNames,
      dictionary,
      propertyStats
    }
  }

  encodeRecord(feature: Feature, precision: number | undefined, header: ClusteredPbfHeader): Buffer {
    const message = this.encodeMessage(feature, precision, header)
    return Buffer.concat([encodeVarint(BigInt(message.length)), message])
  }

  decodeRecord(record: Buffer, layer: Layer, header: ClusteredPbfHeader): Feature {
    const length = readVarint(record, 0)
    const start = length.next
    const end = start + Number(length.value)
    if (end !== record.length) throw new Error('Invalid clustered PBF record length')
    return this.decodeMessage(record.subarray(start, end), layer, header)
  }

  decodeMessage(buffer: Buffer, layer: Layer, header: ClusteredPbfHeader): Feature {
    let position = 0
    let id: string | number | undefined
    let bbox: BBox | undefined
    let properties: Props | null = null
    let geometry: Geometry | null = null

    while (position < buffer.length) {
      const tag = readVarint(buffer, position)
      position = tag.next
      const field = Number(tag.value >> 3n)
      const wireType = Number(tag.value & 7n)

      switch (field) {
        case FEATURE_ID_STRING: {
          const value = readLengthDelimited(buffer, position, wireType)
          id = value.buffer.toString('utf8')
          position = value.next
          break
        }
        case FEATURE_ID_NUMBER:
          assertWireType(wireType, WIRE_FIXED64)
          id = buffer.readDoubleLE(position)
          position += 8
          break
        case FEATURE_BBOX: {
          const value = readLengthDelimited(buffer, position, wireType)
          const values = readPackedDouble(value.buffer)
          if (values.length === 4) bbox = values as BBox
          position = value.next
          break
        }
        case FEATURE_PROPERTIES: {
          const value = readLengthDelimited(buffer, position, wireType)
          properties = decodeProperties(JSON.parse(value.buffer.toString('utf8')) as unknown, header)
          position = value.next
          break
        }
        case FEATURE_GEOMETRY: {
          const value = readLengthDelimited(buffer, position, wireType)
          const decoded = this.decodeGeometry(value.buffer)
          geometry = decoded.geometry
          bbox ??= decoded.bbox
          position = value.next
          break
        }
        default:
          position = skipField(buffer, position, wireType)
      }
    }

    return {
      type: 'Feature',
      ...(id === undefined ? {} : { id }),
      properties,
      geometry,
      ...(bbox === undefined ? {} : { bbox }),
      layer
    }
  }

  private encodeMessage(feature: Feature, precision: number | undefined, header: ClusteredPbfHeader): Buffer {
    const fields: Buffer[] = []

    if (typeof feature.id === 'string') fields.push(writeString(FEATURE_ID_STRING, feature.id))
    else if (typeof feature.id === 'number') fields.push(writeDouble(FEATURE_ID_NUMBER, feature.id))

    if (feature.properties !== null) fields.push(writeString(FEATURE_PROPERTIES, JSON.stringify(encodeProperties(feature.properties, header))))
    if (feature.geometry) fields.push(writeBytes(FEATURE_GEOMETRY, this.encodeGeometry(feature.geometry, precision)))

    return Buffer.concat(fields)
  }

  private encodeGeometry(geometry: Geometry, precision: number | undefined): Buffer {
    const flat = flattenGeometry(geometry)
    const fields = [
      writeUInt(GEOMETRY_TYPE, BigInt(flat.type)),
      writeUInt(GEOMETRY_DIMENSIONS, BigInt(dimensions(flat.positions))),
      writePackedUInt(GEOMETRY_NESTING, flat.nesting.map(BigInt))
    ]

    if (precision === undefined) {
      fields.push(writePackedDouble(GEOMETRY_COORDS_DOUBLE, flattenDoubleCoordinates(flat.positions)))
    } else {
      fields.push(writeSInt(GEOMETRY_PRECISION, BigInt(precision)))
      fields.push(writePackedSInt(GEOMETRY_COORDS_INT, flattenIntegerDeltas(flat.positions, precision)))
    }

    return Buffer.concat(fields)
  }

  private decodeGeometry(buffer: Buffer): GeometryWithBbox {
    const decoded: DecodedGeometry = { nesting: [] }
    let position = 0

    while (position < buffer.length) {
      const tag = readVarint(buffer, position)
      position = tag.next
      const field = Number(tag.value >> 3n)
      const wireType = Number(tag.value & 7n)

      switch (field) {
        case GEOMETRY_TYPE: {
          assertWireType(wireType, WIRE_VARINT)
          const value = readVarint(buffer, position)
          decoded.type = Number(value.value) as GeometryTypeCode
          position = value.next
          break
        }
        case GEOMETRY_PRECISION: {
          assertWireType(wireType, WIRE_VARINT)
          const value = readVarint(buffer, position)
          decoded.precision = Number(decodeZigZag(value.value))
          position = value.next
          break
        }
        case GEOMETRY_DIMENSIONS: {
          assertWireType(wireType, WIRE_VARINT)
          const value = readVarint(buffer, position)
          decoded.dimensions = Number(value.value)
          position = value.next
          break
        }
        case GEOMETRY_COORDS_INT: {
          const value = readLengthDelimited(buffer, position, wireType)
          decoded.intCoordinates = readPackedSInt(value.buffer)
          position = value.next
          break
        }
        case GEOMETRY_COORDS_DOUBLE: {
          const value = readLengthDelimited(buffer, position, wireType)
          decoded.doubleCoordinates = readPackedDouble(value.buffer)
          position = value.next
          break
        }
        case GEOMETRY_NESTING: {
          const value = readLengthDelimited(buffer, position, wireType)
          decoded.nesting = readPackedUInt(value.buffer).map((item) => Number(item))
          position = value.next
          break
        }
        default:
          position = skipField(buffer, position, wireType)
      }
    }

    return inflateGeometry(decoded)
  }
}

class DelimitedPbfParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(private bufferOffset = 0) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
  }

  read(): { message: Buffer, offset: number, byteLength: number } | null {
    const length = tryReadVarint(this.buffer, 0)
    if (!length) return null

    const messageStart = length.next
    const messageEnd = messageStart + Number(length.value)
    if (this.buffer.length < messageEnd) return null

    const record = {
      message: this.buffer.subarray(messageStart, messageEnd),
      offset: this.bufferOffset,
      byteLength: messageEnd
    }

    this.buffer = this.buffer.subarray(messageEnd)
    this.bufferOffset += messageEnd
    return record
  }

  finish(): void {
    if (this.buffer.length > 0) throw new Error('Invalid clustered PBF: truncated record at end of file')
  }
}

function toWritableFeature(feature: Feature, precision: number | undefined): Feature {
  return {
    ...feature,
    bbox: feature.bbox ? roundBbox(feature.bbox, precision) : undefined,
    properties: normalizeProperties(feature.properties),
    geometry: roundGeometry(feature.geometry, precision)
  }
}

function clusteredCoordinatePrecision(layer: Layer): number | undefined {
  return Crs.registry.has(layer.crs)
    ? Crs.registry.get(layer.crs).coordinatePrecision
    : new Crs(layer.crs).coordinatePrecision
}

function roundBbox(bbox: BBox, precision: number | undefined): BBox {
  return precision === undefined
    ? bbox
    : [
      roundNumber(bbox[0], precision),
      roundNumber(bbox[1], precision),
      roundNumber(bbox[2], precision),
      roundNumber(bbox[3], precision)
    ]
}

function roundGeometry(geometry: Geometry | null, precision: number | undefined): Geometry | null {
  if (!geometry || precision === undefined) return geometry

  const round = (position: Position): Position => position.map((value) => roundNumber(value, precision)) as Position

  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: round(geometry.coordinates) }
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map(round) }
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => ring.map(round)) }
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geometry.coordinates.map(round) }
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geometry.coordinates.map((line) => line.map(round)) }
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(round))) }
  }
}

function roundNumber(value: number, precision: number): number {
  return Number(value.toFixed(precision))
}

function hilbertKey(feature: Feature, layer: Layer): number {
  const bbox = feature.bbox ?? Gt.bbox(feature.geometry)
  if (!bbox) return Number.MAX_SAFE_INTEGER

  const center = Gt.transformPosition([
    (bbox[0] + bbox[2]) / 2,
    (bbox[1] + bbox[3]) / 2
  ], layer.crs, 'EPSG:3857')
  const x = quantizeWebMercator(center[0])
  const y = quantizeWebMercator(center[1])
  return hilbertIndex(x, y, HILBERT_LEVEL)
}

function quantizeWebMercator(value: number): number {
  const normalized = (Gt.clamp(value, -WEB_MERCATOR_EXTENT, WEB_MERCATOR_EXTENT) + WEB_MERCATOR_EXTENT)
    / (WEB_MERCATOR_EXTENT * 2)
  return Math.min(HILBERT_GRID_SIZE - 1, Math.max(0, Math.floor(normalized * HILBERT_GRID_SIZE)))
}

function hilbertIndex(x: number, y: number, level: number): number {
  let index = 0

  for (let scale = 1 << (level - 1); scale > 0; scale >>= 1) {
    const rx = (x & scale) > 0 ? 1 : 0
    const ry = (y & scale) > 0 ? 1 : 0
    index += scale * scale * ((3 * rx) ^ ry)

    if (ry === 0) {
      if (rx === 1) {
        x = HILBERT_GRID_SIZE - 1 - x
        y = HILBERT_GRID_SIZE - 1 - y
      }

      const swap = x
      x = y
      y = swap
    }
  }

  return index
}

function flattenGeometry(geometry: Geometry): FlatGeometry {
  switch (geometry.type) {
    case 'Point':
      return { type: 1, positions: [geometry.coordinates], nesting: [] }
    case 'LineString':
      return { type: 2, positions: geometry.coordinates, nesting: [geometry.coordinates.length] }
    case 'Polygon':
      return {
        type: 3,
        positions: geometry.coordinates.flat(),
        nesting: [geometry.coordinates.length, ...geometry.coordinates.map((ring) => ring.length)]
      }
    case 'MultiPoint':
      return { type: 4, positions: geometry.coordinates, nesting: [geometry.coordinates.length] }
    case 'MultiLineString':
      return {
        type: 5,
        positions: geometry.coordinates.flat(),
        nesting: [geometry.coordinates.length, ...geometry.coordinates.map((line) => line.length)]
      }
    case 'MultiPolygon':
      return {
        type: 6,
        positions: geometry.coordinates.flat(2),
        nesting: [
          geometry.coordinates.length,
          ...geometry.coordinates.flatMap((polygon) => [polygon.length, ...polygon.map((ring) => ring.length)])
        ]
      }
  }
}

function inflateGeometry(decoded: DecodedGeometry): GeometryWithBbox {
  if (!decoded.type || !decoded.dimensions) throw new Error('Invalid clustered PBF geometry')
  const positions = inflatePositions(decoded)
  const bbox = positionsBbox(positions)
  let offset = 0

  const take = (count: number): Position[] => {
    const items = positions.slice(offset, offset + count)
    offset += count
    return items
  }

  switch (decoded.type) {
    case 1:
      return { geometry: { type: 'Point', coordinates: positions[0] }, bbox }
    case 2:
      return { geometry: { type: 'LineString', coordinates: take(decoded.nesting[0] ?? positions.length) }, bbox }
    case 3: {
      const ringCount = decoded.nesting[0] ?? 0
      const rings: Position[][] = []
      for (let index = 0; index < ringCount; index += 1) rings.push(take(decoded.nesting[index + 1] ?? 0))
      return { geometry: { type: 'Polygon', coordinates: rings }, bbox }
    }
    case 4:
      return { geometry: { type: 'MultiPoint', coordinates: take(decoded.nesting[0] ?? positions.length) }, bbox }
    case 5: {
      const lineCount = decoded.nesting[0] ?? 0
      const lines: Position[][] = []
      for (let index = 0; index < lineCount; index += 1) lines.push(take(decoded.nesting[index + 1] ?? 0))
      return { geometry: { type: 'MultiLineString', coordinates: lines }, bbox }
    }
    case 6: {
      const polygonCount = decoded.nesting[0] ?? 0
      const polygons: Position[][][] = []
      let nestingOffset = 1
      for (let polygonIndex = 0; polygonIndex < polygonCount; polygonIndex += 1) {
        const ringCount = decoded.nesting[nestingOffset] ?? 0
        nestingOffset += 1
        const rings: Position[][] = []
        for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
          rings.push(take(decoded.nesting[nestingOffset] ?? 0))
          nestingOffset += 1
        }
        polygons.push(rings)
      }
      return { geometry: { type: 'MultiPolygon', coordinates: polygons }, bbox }
    }
  }
}

function positionsBbox(positions: readonly Position[]): BBox | undefined {
  let bbox: BBox | undefined

  for (const position of positions) {
    const point: BBox = [position[0], position[1], position[0], position[1]]
    bbox = bbox ? Gt.expand(bbox, point) : point
  }

  return bbox
}

function dimensions(positions: readonly Position[]): number {
  return positions.reduce((max, position) => Math.max(max, position.length), 2)
}

function flattenDoubleCoordinates(positions: readonly Position[]): number[] {
  const dimensionCount = dimensions(positions)
  return positions.flatMap((position) => Array.from({ length: dimensionCount }, (_value, index) => position[index] ?? 0))
}

function flattenIntegerDeltas(positions: readonly Position[], precision: number): bigint[] {
  const dimensionCount = dimensions(positions)
  const scale = 10 ** precision
  const previous = Array.from<bigint>({ length: dimensionCount }).fill(0n)
  const values: bigint[] = []

  for (const position of positions) {
    for (let dimension = 0; dimension < dimensionCount; dimension += 1) {
      const value = BigInt(Math.round((position[dimension] ?? 0) * scale))
      values.push(value - previous[dimension])
      previous[dimension] = value
    }
  }

  return values
}

function inflatePositions(decoded: DecodedGeometry): Position[] {
  const dimensionCount = decoded.dimensions ?? 2
  const coordinates = decoded.intCoordinates
    ? inflateIntegerCoordinates(decoded.intCoordinates, decoded.precision ?? 0, dimensionCount)
    : decoded.doubleCoordinates ?? []
  const positions: Position[] = []

  for (let offset = 0; offset < coordinates.length; offset += dimensionCount) {
    positions.push(coordinates.slice(offset, offset + dimensionCount) as Position)
  }

  return positions
}

function inflateIntegerCoordinates(deltas: readonly bigint[], precision: number, dimensionCount: number): number[] {
  const scale = 10 ** precision
  const previous = Array.from<bigint>({ length: dimensionCount }).fill(0n)
  const values: number[] = []

  for (let index = 0; index < deltas.length; index += 1) {
    const dimension = index % dimensionCount
    const value = previous[dimension] + deltas[index]
    values.push(Number(value) / scale)
    previous[dimension] = value
  }

  return values
}

function writeUInt(field: number, value: bigint): Buffer {
  return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value)])
}

function writeSInt(field: number, value: bigint): Buffer {
  return writeUInt(field, encodeZigZag(value))
}

function writeDouble(field: number, value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeDoubleLE(value)
  return Buffer.concat([encodeTag(field, WIRE_FIXED64), buffer])
}

function writeString(field: number, value: string): Buffer {
  return writeBytes(field, Buffer.from(value, 'utf8'))
}

function writeBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([encodeTag(field, WIRE_LENGTH_DELIMITED), encodeVarint(BigInt(value.length)), value])
}

function writePackedUInt(field: number, values: readonly bigint[]): Buffer {
  return writeBytes(field, Buffer.concat(values.map((value) => encodeVarint(value))))
}

function writePackedSInt(field: number, values: readonly bigint[]): Buffer {
  return writeBytes(field, Buffer.concat(values.map((value) => encodeVarint(encodeZigZag(value)))))
}

function writePackedDouble(field: number, values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 8)
  for (let index = 0; index < values.length; index += 1) buffer.writeDoubleLE(values[index], index * 8)
  return writeBytes(field, buffer)
}

function encodeTag(field: number, wireType: number): Buffer {
  return encodeVarint(BigInt((field << 3) | wireType))
}

function encodeVarint(value: bigint): Buffer {
  const bytes: number[] = []
  let remaining = value

  do {
    let byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    if (remaining !== 0n) byte |= 0x80
    bytes.push(byte)
  } while (remaining !== 0n)

  return Buffer.from(bytes)
}

function readVarint(buffer: Buffer, position: number): { value: bigint, next: number } {
  const value = tryReadVarint(buffer, position)
  if (!value) throw new Error('Invalid clustered PBF: truncated varint')
  return value
}

function tryReadVarint(buffer: Buffer, position: number): { value: bigint, next: number } | null {
  let value = 0n
  let shift = 0n

  for (let index = position; index < buffer.length; index += 1) {
    const byte = buffer[index]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: index + 1 }
    shift += 7n
    if (shift > 63n) throw new Error('Invalid clustered PBF: varint is too long')
  }

  return null
}

function readLengthDelimited(buffer: Buffer, position: number, wireType: number): { buffer: Buffer, next: number } {
  assertWireType(wireType, WIRE_LENGTH_DELIMITED)
  const length = readVarint(buffer, position)
  const start = length.next
  const end = start + Number(length.value)
  if (end > buffer.length) throw new Error('Invalid clustered PBF: length-delimited field exceeds buffer')
  return { buffer: buffer.subarray(start, end), next: end }
}

function readPackedUInt(buffer: Buffer): bigint[] {
  const values: bigint[] = []
  let position = 0
  while (position < buffer.length) {
    const value = readVarint(buffer, position)
    values.push(value.value)
    position = value.next
  }
  return values
}

function readPackedSInt(buffer: Buffer): bigint[] {
  return readPackedUInt(buffer).map(decodeZigZag)
}

function readPackedDouble(buffer: Buffer): number[] {
  if (buffer.length % 8 !== 0) throw new Error('Invalid clustered PBF: packed double length is invalid')
  const values: number[] = []
  for (let position = 0; position < buffer.length; position += 8) values.push(buffer.readDoubleLE(position))
  return values
}

function skipField(buffer: Buffer, position: number, wireType: number): number {
  switch (wireType) {
    case WIRE_VARINT:
      return readVarint(buffer, position).next
    case WIRE_FIXED64:
      return position + 8
    case WIRE_LENGTH_DELIMITED:
      return readLengthDelimited(buffer, position, wireType).next
    default:
      throw new Error(`Invalid clustered PBF wire type ${wireType}`)
  }
}

function assertWireType(actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`Invalid clustered PBF wire type ${actual}, expected ${expected}`)
}

function encodeZigZag(value: bigint): bigint {
  return value >= 0n ? value << 1n : ((-value) << 1n) - 1n
}

function decodeZigZag(value: bigint): bigint {
  return (value & 1n) === 0n ? value >> 1n : -((value >> 1n) + 1n)
}
