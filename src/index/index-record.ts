import type { Feature, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { Index } from './index.js'
import type { HeaderEntry } from './indexer.js'

const MAX_INDEX_BUFFER_SIZE = 0x7fffffff

export class IndexRecord extends Index<number | readonly number[]> {
  static readonly NAME = 'record'
  static readonly ENTRY_SIZE = 12

  constructor(
    layer: Layer,
    readonly path: string,
    private readonly sourceIdValue: string,
    private readonly buffer: Buffer,
    readonly entry: HeaderEntry
  ) {
    super(IndexRecord.NAME, layer)
  }

  get recordCount(): number {
    return this.entry.recordCount
  }

  get sourceId(): string {
    return this.sourceIdValue
  }

  static fromBuffer(layer: Layer, path: string, sourceId: string, buffer: Buffer, entry: HeaderEntry): IndexRecord {
    return new IndexRecord(
      layer,
      path,
      sourceId,
      buffer.subarray(entry.offset, entry.offset + entry.byteLength),
      entry
    )
  }

  static fromSegment(layer: Layer, path: string, sourceId: string, buffer: Buffer, entry: HeaderEntry): IndexRecord {
    return new IndexRecord(layer, path, sourceId, buffer, entry)
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

  streamRange(minRecord: number, maxRecord: number): ReadableStream<Feature> {
    let record = minRecord

    return new ReadableStream({
      pull: async (controller) => {
        while (record <= maxRecord) {
          const feature = await this.layer.source.read(this.sourceRef(record), { layer: this.layer })
          record += 1
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
    if (!Number.isSafeInteger(record) || record < 0 || record >= this.recordCount) {
      throw new Error(`Record index ${record} is out of bounds`)
    }

    const entryOffset = record * this.entry.entrySize
    if (this.entry.entrySize !== IndexRecord.ENTRY_SIZE || entryOffset + IndexRecord.ENTRY_SIZE > this.buffer.length) {
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

export class IndexRecordBuilder {
  private buffer = resizableBuffer(IndexRecord.ENTRY_SIZE * 1024)
  private count = 0
  private sourceIdValue: string | null = null

  constructor(private readonly layer: Layer) {}

  get sourceId(): string {
    return this.sourceIdValue ?? this.layer.source.id
  }

  add(feature: Feature, _record: number): void {
    const sourceRef = toRecordRef(feature.sourceRef, this.layer)
    this.sourceIdValue ??= sourceRef.sourceId
    if (sourceRef.sourceId !== this.sourceIdValue) {
      throw new Error(`Layer "${this.layer.id}" streamed features from multiple file sources`)
    }

    this.ensureCapacity(IndexRecord.ENTRY_SIZE)
    const offset = this.count * IndexRecord.ENTRY_SIZE
    this.buffer.writeBigUInt64LE(BigInt(sourceRef.offset), offset)
    this.buffer.writeUInt32LE(sourceRef.byteLength, offset + 8)
    this.count += 1
  }

  finalize() {
    return {
      name: IndexRecord.NAME,
      buffer: this.buffer.subarray(0, this.count * IndexRecord.ENTRY_SIZE),
      recordCount: this.count,
      entrySize: IndexRecord.ENTRY_SIZE
    }
  }

  private ensureCapacity(byteLength: number): void {
    const needed = this.count * IndexRecord.ENTRY_SIZE + byteLength
    if (needed <= this.buffer.length) return

    let capacity = this.buffer.length
    while (capacity < needed) capacity *= 2
    resizeBuffer(this.buffer, capacity)
  }
}

function resizableBuffer(byteLength: number): Buffer {
  const ResizableArrayBuffer = ArrayBuffer as unknown as {
    new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer
  }
  return Buffer.from(new ResizableArrayBuffer(byteLength, { maxByteLength: MAX_INDEX_BUFFER_SIZE }))
}

function resizeBuffer(buffer: Buffer, byteLength: number): void {
  (buffer.buffer as ArrayBuffer & { resize(byteLength: number): void }).resize(byteLength)
}

function toRecordRef(sourceRef: SourceRef | undefined, layer: Layer): SourceRef & {
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
