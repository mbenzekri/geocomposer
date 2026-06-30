import { open, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Layer } from '../layer/layer.js'
import { FileSource, type SourceFile } from '../source/source.js'
import { IndexRecord, IndexRecordBuilder } from './index-record.js'
import { DEFAULT_RTREE_CHUNK_SIZE, IndexRtree, IndexRtreeBuilder } from './index-rtree.js'
import { IndexProperty, IndexPropertyBuilder } from './index-property.js'

const FILE_INDEX_MAGIC = 'GEOC-IDX'
const FILE_INDEX_VERSION = 1

export type HeaderEntry = {
  name: string
  offset: number
  byteLength: number
  recordCount: number
  entrySize: number
}

type BuiltIndex = {
  name: string
  buffer: Buffer
  recordCount: number
  entrySize: number
}

export class Indexer {
  constructor(private readonly layer: Layer) {}

  static async needsBuild(layer: Layer): Promise<'missing' | 'stale' | 'up-to-date'> {
    if (!(layer.source instanceof FileSource)) {
      throw new Error(`Layer "${layer.id}" source "${layer.source.id}" is not a FileSource`)
    }

    await Indexer.prepareClusteredIndexSource(layer)
    const indexPath = Indexer.resolveIndexPath(layer)
    const files = layer.source.files
    const indexStat = await stat(indexPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })

    if (!indexStat) return 'missing'

    let sourceMtime = 0
    for (const file of files) {
      sourceMtime = Math.max(sourceMtime, (await stat(Indexer.pathToString(file.path))).mtimeMs)
    }

    return indexStat.mtimeMs < sourceMtime ? 'stale' : 'up-to-date'
  }

  static resolveIndexPath(layer: Layer): string {
    if (!(layer.source instanceof FileSource)) {
      throw new Error(`Layer "${layer.id}" source "${layer.source.id}" is not a FileSource`)
    }

    const sourceFile = Indexer.resolvePrimaryFile(layer.source.files, layer)
    return `${Indexer.pathToString(sourceFile.path)}.idx`
  }

  async build(signal?: AbortSignal, force = false): Promise<IndexRecord> {
    if (!(this.layer.source instanceof FileSource)) {
      throw new Error(`Layer "${this.layer.id}" source "${this.layer.source.id}" is not a FileSource`)
    }

    await Indexer.prepareClusteredIndexSource(this.layer, force)
    const outputPath = Indexer.resolveIndexPath(this.layer)
    const record = new IndexRecordBuilder(this.layer)
    const rtree = new IndexRtreeBuilder(record, this.rtreeChunkSize())
    const propertyBuilders = this.propertyIndexNames().map((property) => new IndexPropertyBuilder(property))
    const builders = [record, rtree, ...propertyBuilders]

    await this.streamFeatures(builders, signal)
    const contents = builders.map((builder) => builder.finalize())
    const header = createHeaderEntries(contents)
    await this.write(outputPath, header, contents)

    return this.registerBuiltIndexes(outputPath, record.sourceId, header, contents)
  }

  async load(): Promise<IndexRecord> {
    if (!(this.layer.source instanceof FileSource)) {
      throw new Error(`Layer "${this.layer.id}" source "${this.layer.source.id}" is not a FileSource`)
    }

    await Indexer.prepareClusteredIndexSource(this.layer)
    const path = Indexer.resolveIndexPath(this.layer)
    let buffer: Buffer
    try {
      buffer = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Layer "${this.layer.id}" expects index file "${path}" but it does not exist`)
      }
      throw error
    }

    return this.registerIndexes(path, this.layer.source.id, buffer)
  }

  private registerIndexes(path: string, sourceId: string, buffer: Buffer): IndexRecord {
    const header = parseFileIndexHeader(buffer)
    const recordEntry = findHeaderEntry(header, IndexRecord.NAME, 'File index does not contain a record index')
    const rtreeEntry = findHeaderEntry(header, IndexRtree.NAME, 'File index does not contain an rtree index')
    const record = IndexRecord.fromBuffer(this.layer, path, sourceId, buffer, recordEntry)
    const rtree = IndexRtree.fromBuffer(this.layer, record, buffer, rtreeEntry)
    this.layer.indexes.set(record.id, record)
    this.layer.indexes.set(rtree.id, rtree)
    for (const entry of header.filter((item) => IndexProperty.isIndexName(item.name))) {
      const property = IndexProperty.fromBuffer(this.layer, record, buffer, entry)
      this.layer.indexes.set(property.id, property)
    }
    return record
  }

  private registerBuiltIndexes(path: string, sourceId: string, header: readonly HeaderEntry[], contents: readonly BuiltIndex[]): IndexRecord {
    const recordEntry = findHeaderEntry(header, IndexRecord.NAME, 'File index does not contain a record index')
    const rtreeEntry = findHeaderEntry(header, IndexRtree.NAME, 'File index does not contain an rtree index')
    const recordContent = findBuiltIndex(contents, IndexRecord.NAME)
    const rtreeContent = findBuiltIndex(contents, IndexRtree.NAME)
    const record = IndexRecord.fromSegment(this.layer, path, sourceId, recordContent.buffer, recordEntry)
    const rtree = IndexRtree.fromSegment(this.layer, record, rtreeContent.buffer, rtreeEntry)
    this.layer.indexes.set(record.id, record)
    this.layer.indexes.set(rtree.id, rtree)
    for (const entry of header.filter((item) => IndexProperty.isIndexName(item.name))) {
      const content = findBuiltIndex(contents, entry.name)
      const property = IndexProperty.fromSegment(this.layer, record, content.buffer, entry)
      this.layer.indexes.set(property.id, property)
    }
    return record
  }

  private async write(path: string, header: readonly HeaderEntry[], contents: readonly BuiltIndex[]): Promise<void> {
    const headerBuffer = createHeader(header)
    const handle = await open(path, 'w')
    let position = 0

    try {
      await handle.write(headerBuffer, 0, headerBuffer.length, position)
      position += headerBuffer.length

      for (const index of contents) {
        await handle.write(index.buffer, 0, index.buffer.length, position)
        position += index.buffer.length
      }
    } finally {
      await handle.close()
    }
  }

  private async streamFeatures(
    builders: Array<IndexRecordBuilder | IndexRtreeBuilder | IndexPropertyBuilder>,
    signal?: AbortSignal
  ): Promise<void> {
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

        for (const builder of builders) builder.add(result.value, record)
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

  private propertyIndexNames(): string[] {
    const indexes = this.layer.source.indexes
    if (!indexes || indexes === true) return []

    const properties = indexes.properties
    if (properties === undefined) return []
    if (!Array.isArray(properties) || !properties.every((property) => typeof property === 'string' && property.length > 0)) {
      throw new Error(`Source "${this.layer.source.id}" property indexes must be a non-empty string array`)
    }

    return [...new Set(properties)]
  }

  private rtreeChunkSize(): number {
    const indexes = this.layer.source.indexes
    if (!indexes || indexes === true) return DEFAULT_RTREE_CHUNK_SIZE

    const rtree = this.rtreeConfig()
    if (rtree === undefined || rtree === true) return DEFAULT_RTREE_CHUNK_SIZE

    const chunkSize = rtree.chunkSize
    if (chunkSize === undefined) return DEFAULT_RTREE_CHUNK_SIZE
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error(`Source "${this.layer.source.id}" rtree chunkSize must be a positive integer`)
    }

    return chunkSize
  }

  private rtreeConfig(): true | { chunkSize?: number, clustered?: boolean } | undefined {
    const indexes = this.layer.source.indexes
    if (!indexes || indexes === true) return undefined

    const rtree = indexes.rtree
    if (rtree === undefined || rtree === true) return rtree
    if (!rtree || typeof rtree !== 'object' || Array.isArray(rtree)) {
      throw new Error(`Source "${this.layer.source.id}" rtree index configuration must be an object`)
    }

    const clustered = rtree.clustered
    if (clustered !== undefined && typeof clustered !== 'boolean') {
      throw new Error(`Source "${this.layer.source.id}" rtree clustered must be a boolean`)
    }

    return rtree
  }

  private static rtreeClustered(layer: Layer): boolean {
    const indexes = layer.source.indexes
    if (!indexes || indexes === true) return false

    const rtree = indexes.rtree
    if (rtree === undefined || rtree === true) return false
    if (!rtree || typeof rtree !== 'object' || Array.isArray(rtree)) {
      throw new Error(`Source "${layer.source.id}" rtree index configuration must be an object`)
    }

    const clustered = rtree.clustered
    if (clustered !== undefined && typeof clustered !== 'boolean') {
      throw new Error(`Source "${layer.source.id}" rtree clustered must be a boolean`)
    }

    return clustered === true
  }

  private static async prepareClusteredIndexSource(layer: Layer, force = false): Promise<void> {
    if (!Indexer.rtreeClustered(layer)) return
    if (!(layer.source instanceof FileSource)) {
      throw new Error(`Layer "${layer.id}" source "${layer.source.id}" is not a FileSource`)
    }
    await layer.source.prepareClusteredIndexSource(layer, force)
  }
}

function createHeaderEntries(contents: readonly BuiltIndex[]): HeaderEntry[] {
  const headerLength = 16 + contents.reduce((length, index) => length + headerEntryLength(index.name), 0)
  let offset = headerLength
  return contents.map((index): HeaderEntry => {
    const entry = {
      name: index.name,
      offset,
      byteLength: index.buffer.length,
      recordCount: index.recordCount,
      entrySize: index.entrySize
    }
    offset += index.buffer.length
    return entry
  })
}

export function parseFileIndexHeader(buffer: Buffer): HeaderEntry[] {
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
  const header: HeaderEntry[] = []
  let position = 16

  for (let index = 0; index < indexCount; index += 1) {
    if (position + 1 > headerLength) {
      throw new Error('Invalid file index: truncated header entry')
    }

    const nameLength = buffer.readUInt8(position)
    position += 1

    if (position + nameLength + 22 > headerLength) {
      throw new Error('Invalid file index: truncated header entry')
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
    header.push({ name, offset, byteLength, recordCount, entrySize })
  }

  if (position !== headerLength) {
    throw new Error('Invalid file index: header contains trailing bytes')
  }

  return header
}

export function findHeaderEntry(header: readonly HeaderEntry[], name: string, missingMessage: string): HeaderEntry {
  const entry = header.find((item) => item.name === name)
  if (!entry) throw new Error(missingMessage)
  return entry
}

function createHeader(entries: readonly HeaderEntry[]): Buffer {
  const header = Buffer.alloc(16 + entries.reduce((length, entry) => length + headerEntryLength(entry.name), 0))
  let position = 0
  header.write(FILE_INDEX_MAGIC, position, 'ascii')
  position += 8
  header.writeUInt16LE(FILE_INDEX_VERSION, position)
  position += 2
  header.writeUInt32LE(header.length, position)
  position += 4
  header.writeUInt16LE(entries.length, position)
  position += 2
  for (const entry of entries) position = writeHeaderEntry(header, position, entry)
  return header
}

function headerEntryLength(name: string): number {
  return 1 + name.length + 8 + 8 + 4 + 2
}

function writeHeaderEntry(buffer: Buffer, position: number, entry: HeaderEntry): number {
  buffer.writeUInt8(entry.name.length, position)
  position += 1
  buffer.write(entry.name, position, 'ascii')
  position += entry.name.length
  buffer.writeBigUInt64LE(BigInt(entry.offset), position)
  position += 8
  buffer.writeBigUInt64LE(BigInt(entry.byteLength), position)
  position += 8
  buffer.writeUInt32LE(entry.recordCount, position)
  position += 4
  buffer.writeUInt16LE(entry.entrySize, position)
  return position + 2
}

function findBuiltIndex(contents: readonly BuiltIndex[], name: string): BuiltIndex {
  const index = contents.find((item) => item.name === name)
  if (!index) throw new Error(`Built index "${name}" is missing`)
  return index
}
