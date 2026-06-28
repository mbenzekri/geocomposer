import { open, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import RBush from 'rbush'
import type { Feature, SourceRef } from '../core/feature.js'
import type { BBox } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { Layer } from '../layer/layer.js'
import { Index } from '../layer/layer-index.js'
import { FileSource, type SourceFile } from './source.js'

export const FILE_INDEX_MAGIC = 'GEOC-IDX'
export const FILE_INDEX_VERSION = 1
export const RECORD_INDEX_NAME = 'record'
export const RTREE_INDEX_NAME = 'rtree'
export const RECORD_INDEX_ENTRY_SIZE = 12
export const RTREE_INDEX_ENTRY_SIZE = 36
const RTREE_CHUNK_SIZE = 100
const RTREE_LEAF_FLAG = 1

export type FileIndexDescriptor = {
  name: string
  offset: number
  byteLength: number
  recordCount: number
  entrySize: number
}

export class LayerFileIndexer {
  constructor(private readonly layer: Layer) {}

  static async needsBuild(layer: Layer): Promise<'missing' | 'stale' | 'up-to-date'> {
    if (!(layer.source instanceof FileSource)) {
      throw new Error(`Layer "${layer.id}" source "${layer.source.id}" is not a FileSource`)
    }

    const indexPath = LayerFileIndexer.resolveIndexPath(layer)
    const files = layer.source.getFiles()
    const indexStat = await stat(indexPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })

    if (!indexStat) return 'missing'

    let sourceMtime = 0
    for (const file of files) {
      sourceMtime = Math.max(sourceMtime, (await stat(LayerFileIndexer.pathToString(file.path))).mtimeMs)
    }

    return indexStat.mtimeMs < sourceMtime ? 'stale' : 'up-to-date'
  }

  static resolveIndexPath(layer: Layer): string {
    if (!(layer.source instanceof FileSource)) {
      throw new Error(`Layer "${layer.id}" source "${layer.source.id}" is not a FileSource`)
    }

    const sourceFile = LayerFileIndexer.resolvePrimaryFile(layer.source.getFiles(), layer)
    return `${LayerFileIndexer.pathToString(sourceFile.path)}.idx`
  }

  async build(signal?: AbortSignal): Promise<IndexRecord> {
    if (!(this.layer.source instanceof FileSource)) {
      throw new Error(`Layer "${this.layer.id}" source "${this.layer.source.id}" is not a FileSource`)
    }

    const outputPath = LayerFileIndexer.resolveIndexPath(this.layer)
    const recordIndex = IndexRecord.init(this.layer)
    const rtreeIndex = IndexRtree.init(this.layer, recordIndex)
    const indexes = [recordIndex, rtreeIndex]

    await this.streamFeatures(indexes, signal)
    const buffer = createIndexBuffer(indexes.map((index) => index.finalize()))

    const handle = await open(outputPath, 'w')
    try {
      await handle.write(buffer, 0, buffer.length, 0)
    } finally {
      await handle.close()
    }

    const index = IndexRecord.fromBuffer(this.layer, outputPath, recordIndex.sourceId, buffer)
    const rtree = new IndexRtree(this.layer, index)
    this.layer.indexes.set(index.id, index)
    this.layer.indexes.set(rtree.id, rtree)
    return index
  }

  private async streamFeatures(indexes: Array<IndexRecord | IndexRtree>, signal?: AbortSignal): Promise<void> {
    const reader = this.layer.stream({ signal }).getReader()
    let completed = false
    let record = 0

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) {
          completed = true
          break
        }

        for (const index of indexes) index.add(result.value, record)
        record += 1
      }
    } finally {
      if (!completed) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the original indexing error when stream cleanup also fails.
        }
      }
      reader.releaseLock()
    }
  }

  private static resolvePrimaryFile(files: readonly SourceFile[], layer: Layer): SourceFile {
    const sourceFile = files.find((file) => file.role === 'data')
      ?? files.find((file) => file.role === 'geometry')
      ?? files[0]

    if (!sourceFile) {
      throw new Error(`FileSource "${layer.source.id}" for layer "${layer.id}" has no source files`)
    }

    return sourceFile
  }

  private static pathToString(path: SourceFile['path']): string {
    if (path instanceof URL) return fileURLToPath(path)
    return path.toString()
  }
}

function createIndexBuffer(contents: Array<{ name: string, buffer: Buffer, recordCount: number, entrySize: number }>): Buffer {
  const headerLength = 16 + contents.reduce((length, index) => length + descriptorHeaderLength(index.name), 0)
  let offset = headerLength
  const descriptors = contents.map((index): FileIndexDescriptor => {
    const descriptor = {
      name: index.name,
      offset,
      byteLength: index.buffer.length,
      recordCount: index.recordCount,
      entrySize: index.entrySize
    }
    offset += index.buffer.length
    return descriptor
  })

  return Buffer.concat([createHeader(descriptors), ...contents.map((index) => index.buffer)])
}

function createHeader(indexes: readonly FileIndexDescriptor[]): Buffer {
  const header = Buffer.alloc(16 + indexes.reduce((length, index) => length + descriptorHeaderLength(index.name), 0))
  let position = 0
  header.write(FILE_INDEX_MAGIC, position, 'ascii')
  position += 8
  header.writeUInt16LE(FILE_INDEX_VERSION, position)
  position += 2
  header.writeUInt32LE(header.length, position)
  position += 4
  header.writeUInt16LE(indexes.length, position)
  position += 2
  for (const index of indexes) position = writeDescriptor(header, position, index)
  return header
}

function descriptorHeaderLength(name: string): number {
  return 1 + name.length + 8 + 8 + 4 + 2
}

function emptyIndexDescriptor(name: string, entrySize: number): FileIndexDescriptor {
  return { name, offset: 0, byteLength: 0, recordCount: 0, entrySize }
}

function writeDescriptor(buffer: Buffer, position: number, descriptor: FileIndexDescriptor): number {
  buffer.writeUInt8(descriptor.name.length, position)
  position += 1
  buffer.write(descriptor.name, position, 'ascii')
  position += descriptor.name.length
  buffer.writeBigUInt64LE(BigInt(descriptor.offset), position)
  position += 8
  buffer.writeBigUInt64LE(BigInt(descriptor.byteLength), position)
  position += 8
  buffer.writeUInt32LE(descriptor.recordCount, position)
  position += 4
  buffer.writeUInt16LE(descriptor.entrySize, position)
  return position + 2
}

type RtreeItem = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  recordStart: number
  recordEnd: number
}

type RtreeNode = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  children: Array<RtreeNode | RtreeItem>
  leaf: boolean
}

class RtreeChunk {
  private bbox: BBox | null = null
  count = 0

  constructor(private readonly recordStart: number) {}

  add(feature: Feature, record: number): void {
    const bbox = feature.bbox
    this.count = record - this.recordStart + 1
    if (!bbox) return

    this.bbox = this.bbox ? Gt.expand(this.bbox, bbox) : bbox
  }

  get hasBbox(): boolean {
    return this.bbox !== null
  }

  toItem(): RtreeItem {
    if (!this.bbox || this.count === 0) {
      throw new Error('Cannot index an empty R-tree chunk')
    }

    return {
      minX: this.bbox[0],
      minY: this.bbox[1],
      maxX: this.bbox[2],
      maxY: this.bbox[3],
      recordStart: this.recordStart,
      recordEnd: this.recordStart + this.count - 1
    }
  }
}

function createRtreeBuffer(items: RtreeItem[]): Buffer {
  if (items.length === 0) return Buffer.alloc(0)

  const tree = new RBush<RtreeItem>()
  tree.load(items)
  const entries: Buffer[] = []
  appendRtreeEntry(tree.toJSON() as RtreeNode, entries)
  return Buffer.concat(entries)
}

function appendRtreeEntry(node: RtreeNode | RtreeItem, entries: Buffer[]): number {
  const index = entries.length
  entries.push(Buffer.alloc(RTREE_INDEX_ENTRY_SIZE))
  writeRtreeEntryAt(index, node, entries)
  return index
}

function writeRtreeEntryAt(index: number, node: RtreeNode | RtreeItem, entries: Buffer[]): void {
  const entry = entries[index]

  const children = isRtreeNode(node) ? node.children : []
  const firstChild = children.length > 0 ? entries.length : -1
  for (const _child of children) entries.push(Buffer.alloc(RTREE_INDEX_ENTRY_SIZE))
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    writeRtreeEntryAt(firstChild + childIndex, children[childIndex], entries)
  }

  writeRtreeEntry(entry, node, firstChild, children.length, isRtreeNode(node) ? 0 : RTREE_LEAF_FLAG)
}

function writeRtreeEntry(buffer: Buffer, item: RtreeNode | RtreeItem, firstChild: number, childCount: number, flags: number): void {
  buffer.writeFloatLE(item.minX, 0)
  buffer.writeFloatLE(item.minY, 4)
  buffer.writeFloatLE(item.maxX, 8)
  buffer.writeFloatLE(item.maxY, 12)
  buffer.writeInt32LE(firstChild, 16)
  buffer.writeInt32LE(childCount, 20)
  buffer.writeInt32LE(isRtreeNode(item) ? -1 : item.recordStart, 24)
  buffer.writeInt32LE(isRtreeNode(item) ? -1 : item.recordEnd, 28)
  buffer.writeInt32LE(flags, 32)
}

function isRtreeNode(item: RtreeNode | RtreeItem): item is RtreeNode {
  return 'children' in item
}

export class IndexRecord extends Index<number | readonly number[]> {
  readonly recordIndex: FileIndexDescriptor
  private buildRecords: Buffer[] | null = null
  private buildSourceId: string | null = null

  constructor(
    layer: Layer,
    readonly path: string,
    private readonly sourceIdValue: string,
    readonly buffer: Buffer,
    readonly indexes: FileIndexDescriptor[]
  ) {
    super(RECORD_INDEX_NAME, layer)

    const recordIndex = indexes.find((index) => index.name === RECORD_INDEX_NAME)
    if (!recordIndex) {
      throw new Error('File index does not contain a record index')
    }

    this.recordIndex = recordIndex
  }

  get recordCount(): number {
    return this.recordIndex.recordCount
  }

  get sourceId(): string {
    return this.buildSourceId ?? this.sourceIdValue
  }

  static init(layer: Layer): IndexRecord {
    const index = new IndexRecord(layer, '', layer.source.id, Buffer.alloc(0), [emptyIndexDescriptor(RECORD_INDEX_NAME, RECORD_INDEX_ENTRY_SIZE)])
    index.init()
    return index
  }

  static fromBuffer(layer: Layer, path: string, sourceId: string, buffer: Buffer): IndexRecord {
    return new IndexRecord(layer, path, sourceId, buffer, IndexRecord.parseHeader(buffer))
  }

  static parseHeader(buffer: Buffer): FileIndexDescriptor[] {
    if (buffer.length < 16) {
      throw new Error('Invalid file index: header is shorter than the fixed header')
    }

    const magic = buffer.subarray(0, 8).toString('ascii')
    if (magic !== FILE_INDEX_MAGIC) {
      throw new Error(`Invalid file index magic "${magic}"`)
    }

    const version = buffer.readUInt16LE(8)
    if (version !== FILE_INDEX_VERSION) {
      throw new Error(`Unsupported file index version ${version}`)
    }

    const headerLength = buffer.readUInt32LE(10)
    if (headerLength > buffer.length) {
      throw new Error('Invalid file index: header length exceeds buffer length')
    }

    const indexCount = buffer.readUInt16LE(14)
    const indexes: FileIndexDescriptor[] = []
    let position = 16

    for (let index = 0; index < indexCount; index += 1) {
      if (position + 1 > headerLength) {
        throw new Error('Invalid file index: truncated index descriptor')
      }

      const nameLength = buffer.readUInt8(position)
      position += 1

      if (position + nameLength + 22 > headerLength) {
        throw new Error('Invalid file index: truncated index descriptor')
      }

      const name = buffer.subarray(position, position + nameLength).toString('ascii')
      position += nameLength
      const offset = Number(buffer.readBigUInt64LE(position))
      position += 8
      const byteLength = Number(buffer.readBigUInt64LE(position))
      position += 8
      const recordCount = buffer.readUInt32LE(position)
      position += 4
      const entrySize = buffer.readUInt16LE(position)
      position += 2
      indexes.push({ name, offset, byteLength, recordCount, entrySize })
    }

    if (position !== headerLength) {
      throw new Error('Invalid file index: header contains trailing bytes')
    }

    return indexes
  }

  init(): void {
    this.buildRecords = []
    this.buildSourceId = null
  }

  add(feature: Feature, _record: number): void {
    const records = this.buildRecords
    if (!records) throw new Error('IndexRecord has not been initialized for build')

    const sourceRef = IndexRecord.toRecordRef(feature.sourceRef, this.layer)
    this.buildSourceId ??= sourceRef.sourceId
    if (sourceRef.sourceId !== this.buildSourceId) {
      throw new Error(`Layer "${this.layer.id}" streamed features from multiple file sources`)
    }

    const record = Buffer.alloc(RECORD_INDEX_ENTRY_SIZE)
    record.writeBigUInt64LE(BigInt(sourceRef.offset), 0)
    record.writeUInt32LE(sourceRef.byteLength, 8)
    records.push(record)
  }

  finalize() {
    const records = this.buildRecords
    if (!records) throw new Error('IndexRecord has not been initialized for build')

    return {
      name: RECORD_INDEX_NAME,
      buffer: Buffer.concat(records),
      recordCount: records.length,
      entrySize: RECORD_INDEX_ENTRY_SIZE
    }
  }

  stream(criteria?: number | readonly number[]): ReadableStream<Feature> {
    const records = this.records(criteria)
    let position = 0

    return new ReadableStream({
      pull: async (controller) => {
        while (position < records.length) {
          const feature = await this.layer.source.read(this.sourceRef(records[position]), { layer: this.layer })
          position += 1
          if (feature) {
            controller.enqueue(feature)
            return
          }
        }

        controller.close()
      }
    })
  }

  sourceRef(record: number): SourceRef {
    if (!Number.isSafeInteger(record) || record < 0 || record >= this.recordIndex.recordCount) {
      throw new Error(`Record index ${record} is out of bounds`)
    }

    const entryOffset = this.recordIndex.offset + record * this.recordIndex.entrySize
    if (this.recordIndex.entrySize !== RECORD_INDEX_ENTRY_SIZE || entryOffset + RECORD_INDEX_ENTRY_SIZE > this.buffer.length) {
      throw new Error('Invalid record index: entry exceeds buffer length')
    }

    return {
      storage: 'file',
      sourceId: this.sourceId,
      offset: Number(this.buffer.readBigUInt64LE(entryOffset)),
      byteLength: this.buffer.readUInt32LE(entryOffset + 8),
      recordIndex: record
    }
  }

  private records(criteria: number | readonly number[] | undefined): number[] {
    if (criteria === undefined) {
      return Array.from({ length: this.recordCount }, (_value, index) => index)
    }

    return typeof criteria === 'number' ? [criteria] : [...criteria]
  }

  private static toRecordRef(sourceRef: SourceRef | undefined, layer: Layer): SourceRef & {
    offset: number
    byteLength: number
  } {
    if (!sourceRef) {
      throw new Error(`Layer "${layer.id}" streamed a feature without sourceRef`)
    }

    if (sourceRef.storage !== 'file') {
      throw new Error(`Layer "${layer.id}" streamed a feature with non-file sourceRef storage "${sourceRef.storage}"`)
    }

    if (!Number.isSafeInteger(sourceRef.offset) || sourceRef.offset < 0) {
      throw new Error(`Layer "${layer.id}" streamed a feature with invalid sourceRef offset`)
    }

    if (!Number.isSafeInteger(sourceRef.byteLength) || sourceRef.byteLength < 0 || sourceRef.byteLength > 0xffffffff) {
      throw new Error(`Layer "${layer.id}" streamed a feature with invalid sourceRef byteLength`)
    }

    return sourceRef as SourceRef & { offset: number, byteLength: number }
  }
}

export class IndexRtree extends Index<BBox> {
  readonly rtreeIndex: FileIndexDescriptor
  private buildChunk: RtreeChunk | null = null
  private buildChunks: RtreeItem[] | null = null

  constructor(
    layer: Layer,
    private readonly recordIndex: IndexRecord,
    building = false
  ) {
    super(RTREE_INDEX_NAME, layer)

    const rtreeIndex = recordIndex.indexes.find((index) => index.name === RTREE_INDEX_NAME)
    if (!rtreeIndex && !building) {
      throw new Error('File index does not contain an rtree index')
    }

    this.rtreeIndex = rtreeIndex ?? emptyIndexDescriptor(RTREE_INDEX_NAME, RTREE_INDEX_ENTRY_SIZE)
  }

  static init(layer: Layer, recordIndex: IndexRecord): IndexRtree {
    const index = new IndexRtree(layer, recordIndex, true)
    index.init()
    return index
  }

  init(): void {
    this.buildChunk = new RtreeChunk(0)
    this.buildChunks = []
  }

  add(feature: Feature, record: number): void {
    if (!this.buildChunk || !this.buildChunks) throw new Error('IndexRtree has not been initialized for build')

    this.buildChunk.add(feature, record)
    if (this.buildChunk.count === RTREE_CHUNK_SIZE) {
      if (this.buildChunk.hasBbox) this.buildChunks.push(this.buildChunk.toItem())
      this.buildChunk = new RtreeChunk(record + 1)
    }
  }

  finalize() {
    if (!this.buildChunk || !this.buildChunks) throw new Error('IndexRtree has not been initialized for build')

    if (this.buildChunk.hasBbox) this.buildChunks.push(this.buildChunk.toItem())
    const buffer = createRtreeBuffer(this.buildChunks)

    return {
      name: RTREE_INDEX_NAME,
      buffer,
      recordCount: buffer.length / RTREE_INDEX_ENTRY_SIZE,
      entrySize: RTREE_INDEX_ENTRY_SIZE
    }
  }

  stream(bbox?: BBox): ReadableStream<Feature> {
    if (!bbox) {
      throw new Error('IndexRtree.stream requires a bbox')
    }

    const records = this.records(bbox)
    let position = 0

    return new ReadableStream({
      pull: async (controller) => {
        while (position < records.length) {
          const feature = await this.recordIndex.get(records[position])
          position += 1
          if (feature?.bbox && Gt.intersects(feature.bbox, bbox)) {
            controller.enqueue(feature)
            return
          }
        }

        controller.close()
      }
    })
  }

  records(bbox: BBox): number[] {
    if (this.rtreeIndex.byteLength === 0) return []

    const records: number[] = []
    const stack = [0]

    while (stack.length > 0) {
      const entry = stack.pop()!
      if (!this.entryIntersects(entry, bbox)) continue

      if (this.entryFlags(entry) === RTREE_LEAF_FLAG) {
        for (let record = this.entryRecordStart(entry); record <= this.entryRecordEnd(entry); record += 1) {
          records.push(record)
        }
        continue
      }

      const firstChild = this.entryFirstChild(entry)
      const childCount = this.entryChildCount(entry)
      for (let offset = childCount - 1; offset >= 0; offset -= 1) {
        stack.push(firstChild + offset)
      }
    }

    return records
  }

  private entryIntersects(entry: number, bbox: BBox): boolean {
    return Gt.intersects(this.entryBbox(entry), bbox)
  }

  private entryBbox(entry: number): BBox {
    const offset = this.entryOffset(entry)
    return [
      this.recordIndexBuffer.readFloatLE(offset),
      this.recordIndexBuffer.readFloatLE(offset + 4),
      this.recordIndexBuffer.readFloatLE(offset + 8),
      this.recordIndexBuffer.readFloatLE(offset + 12)
    ]
  }

  private entryFirstChild(entry: number): number {
    return this.recordIndexBuffer.readInt32LE(this.entryOffset(entry) + 16)
  }

  private entryChildCount(entry: number): number {
    return this.recordIndexBuffer.readInt32LE(this.entryOffset(entry) + 20)
  }

  private entryRecordStart(entry: number): number {
    return this.recordIndexBuffer.readInt32LE(this.entryOffset(entry) + 24)
  }

  private entryRecordEnd(entry: number): number {
    return this.recordIndexBuffer.readInt32LE(this.entryOffset(entry) + 28)
  }

  private entryFlags(entry: number): number {
    return this.recordIndexBuffer.readInt32LE(this.entryOffset(entry) + 32)
  }

  private entryOffset(entry: number): number {
    return this.rtreeIndex.offset + entry * RTREE_INDEX_ENTRY_SIZE
  }

  private get recordIndexBuffer(): Buffer {
    return this.recordIndex.buffer
  }
}
