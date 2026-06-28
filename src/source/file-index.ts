import { open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Feature, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { Index } from '../layer/layer-index.js'
import { FileSource, type SourceFile } from './source.js'

export const FILE_INDEX_MAGIC = 'GEOC-IDX'
export const FILE_INDEX_VERSION = 1
export const RECORD_INDEX_NAME = 'record'
export const RECORD_INDEX_ENTRY_SIZE = 12
const HEADER_LENGTH = 16 + 1 + RECORD_INDEX_NAME.length + 8 + 8 + 4 + 2

export type FileIndexDescriptor = {
  name: string
  offset: number
  byteLength: number
  recordCount: number
  entrySize: number
}

export class LayerFileIndexer {
  constructor(private readonly layer: Layer) {}

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
    const handle = await open(outputPath, 'w')
    let recordCount = 0
    let sourceId: string | undefined
    let position = HEADER_LENGTH

    try {
      await handle.write(createHeader(0), 0, HEADER_LENGTH, 0)
      const reader = this.layer.stream({ signal }).getReader()
      let completed = false

      try {
        for (;;) {
          const result = await reader.read()
          if (result.done) {
            completed = true
            break
          }

          const sourceRef = LayerFileIndexer.toRecordRef(result.value.sourceRef, this.layer)
          sourceId ??= sourceRef.sourceId
          if (sourceRef.sourceId !== sourceId) {
            throw new Error(`Layer "${this.layer.id}" streamed features from multiple file sources`)
          }
          const record = Buffer.alloc(RECORD_INDEX_ENTRY_SIZE)
          record.writeBigUInt64LE(BigInt(sourceRef.offset), 0)
          record.writeUInt32LE(sourceRef.byteLength, 8)
          await handle.write(record, 0, record.length, position)
          position += record.length
          recordCount += 1
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

      await handle.write(createHeader(recordCount), 0, HEADER_LENGTH, 0)
    } finally {
      await handle.close()
    }

    const index = IndexRecord.fromBuffer(
      this.layer,
      outputPath,
      sourceId ?? this.layer.source.id,
      await readFile(outputPath)
    )
    this.layer.indexes.set(index.id, index)
    return index
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

function createHeader(recordCount: number): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH)
  let position = 0
  header.write(FILE_INDEX_MAGIC, position, 'ascii')
  position += 8
  header.writeUInt16LE(FILE_INDEX_VERSION, position)
  position += 2
  header.writeUInt32LE(header.length, position)
  position += 4
  header.writeUInt16LE(1, position)
  position += 2
  header.writeUInt8(RECORD_INDEX_NAME.length, position)
  position += 1
  header.write(RECORD_INDEX_NAME, position, 'ascii')
  position += RECORD_INDEX_NAME.length
  header.writeBigUInt64LE(BigInt(HEADER_LENGTH), position)
  position += 8
  header.writeBigUInt64LE(BigInt(recordCount * RECORD_INDEX_ENTRY_SIZE), position)
  position += 8
  header.writeUInt32LE(recordCount, position)
  position += 4
  header.writeUInt16LE(RECORD_INDEX_ENTRY_SIZE, position)
  return header
}

export class IndexRecord extends Index<number | readonly number[]> {
  readonly recordIndex: FileIndexDescriptor

  constructor(
    layer: Layer,
    readonly path: string,
    readonly sourceId: string,
    private readonly buffer: Buffer,
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
}
