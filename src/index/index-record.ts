import type { Feature, SourceRef } from '../core/feature.js'
import type { BBox } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import type { RequestTimings } from '../source/source.js'
import { Index } from './index.js'
import type { HeaderEntry } from './indexer.js'

const MAX_INDEX_BUFFER_SIZE = 0x7fffffff
const FULL_FRAME: MiniFrame = [0, 0, 255, 255]

export type MiniFrame = [number, number, number, number]

export class IndexRecord extends Index<number | readonly number[]> {
  static readonly NAME = 'record'
  static readonly ENTRY_SIZE = 16

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

  stream(criteria?: number | readonly number[], timings?: RequestTimings): ReadableStream<Feature> {
    const records = this.records(criteria)
    let position = 0

    return new ReadableStream({
      pull: async (controller) => {
        while (position < records.length) {
          const feature = await this.layer.source.read(this.sourceRef(records[position]), { layer: this.layer, timings })
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

  streamRange(minRecord: number, maxRecord: number, timings?: RequestTimings): ReadableStream<Feature> {
    let record = minRecord

    return new ReadableStream({
      pull: async (controller) => {
        while (record <= maxRecord) {
          const feature = await this.layer.source.read(this.sourceRef(record), { layer: this.layer, timings })
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

  frame(record: number): MiniFrame {
    this.assertRecord(record)
    const entryOffset = record * this.entry.entrySize
    return [
      this.buffer.readUInt8(entryOffset + 12),
      this.buffer.readUInt8(entryOffset + 13),
      this.buffer.readUInt8(entryOffset + 14),
      this.buffer.readUInt8(entryOffset + 15)
    ]
  }

  frameIntersects(record: number, bbox: BBox, rangeBbox: BBox): boolean {
    const frame = this.frame(record)
    if (framesEqual(frame, FULL_FRAME)) return true

    const queryFrame = quantizeBbox(bbox, rangeBbox)
    return frame[0] <= queryFrame[2]
      && frame[2] >= queryFrame[0]
      && frame[1] <= queryFrame[3]
      && frame[3] >= queryFrame[1]
  }

  private records(criteria: number | readonly number[] | undefined): number[] {
    if (criteria === undefined) {
      return Array.from({ length: this.recordCount }, (_value, index) => index)
    }

    return typeof criteria === 'number' ? [criteria] : [...criteria]
  }

  private assertRecord(record: number): void {
    if (!Number.isSafeInteger(record) || record < 0 || record >= this.recordCount) {
      throw new Error(`Record index ${record} is out of bounds`)
    }

    const entryOffset = record * this.entry.entrySize
    if (this.entry.entrySize !== IndexRecord.ENTRY_SIZE || entryOffset + IndexRecord.ENTRY_SIZE > this.buffer.length) {
      throw new Error('Invalid record index: entry exceeds buffer length')
    }
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
    this.writeFrame(this.count, FULL_FRAME)
    this.count += 1
  }

  setFrame(record: number, featureBbox: BBox | null | undefined, rangeBbox: BBox | null | undefined): void {
    if (!featureBbox || !rangeBbox) {
      this.writeFrame(record, FULL_FRAME)
      return
    }

    this.writeFrame(record, quantizeBbox(featureBbox, rangeBbox))
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

  private writeFrame(record: number, frame: MiniFrame): void {
    const offset = record * IndexRecord.ENTRY_SIZE + 12
    this.buffer.writeUInt8(frame[0], offset)
    this.buffer.writeUInt8(frame[1], offset + 1)
    this.buffer.writeUInt8(frame[2], offset + 2)
    this.buffer.writeUInt8(frame[3], offset + 3)
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

function quantizeBbox(bbox: BBox, rangeBbox: BBox): MiniFrame {
  return [
    quantizeMin(bbox[0], rangeBbox[0], rangeBbox[2]),
    quantizeMin(bbox[1], rangeBbox[1], rangeBbox[3]),
    quantizeMax(bbox[2], rangeBbox[0], rangeBbox[2]),
    quantizeMax(bbox[3], rangeBbox[1], rangeBbox[3])
  ]
}

function quantizeMin(value: number, min: number, max: number): number {
  if (!(min < max)) return 0
  return clampByte(Math.floor(((value - min) / (max - min)) * 255))
}

function quantizeMax(value: number, min: number, max: number): number {
  if (!(min < max)) return 255
  return clampByte(Math.ceil(((value - min) / (max - min)) * 255))
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value))
}

function framesEqual(left: MiniFrame, right: MiniFrame): boolean {
  return left[0] === right[0]
    && left[1] === right[1]
    && left[2] === right[2]
    && left[3] === right[3]
}
