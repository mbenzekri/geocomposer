import RBush from 'rbush'
import type { Feature } from '../core/feature.js'
import type { BBox } from '../core/geometry.js'
import { Gt } from '../core/geotools.js'
import type { Layer } from '../layer/layer.js'
import { Index } from './index.js'
import type { HeaderEntry } from './indexer.js'
import { IndexRecord } from './index-record.js'

const RTREE_CHUNK_SIZE = 100
const RTREE_LEAF_FLAG = 1
const MAX_INDEX_BUFFER_SIZE = 0x7fffffff

type RtreeRange = {
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
  children: Array<RtreeNode | RtreeRange>
  leaf: boolean
}

class RtreeEntry {
  constructor(
    private readonly buffer: Buffer,
    private readonly position: number
  ) {}

  get bbox(): BBox {
    const offset = this.offset
    return [
      this.buffer.readFloatLE(offset),
      this.buffer.readFloatLE(offset + 4),
      this.buffer.readFloatLE(offset + 8),
      this.buffer.readFloatLE(offset + 12)
    ]
  }

  get firstChild(): number {
    return this.buffer.readInt32LE(this.offset + 16)
  }

  get childCount(): number {
    return this.buffer.readInt32LE(this.offset + 20)
  }

  get recordStart(): number {
    return this.buffer.readInt32LE(this.offset + 24)
  }

  get recordEnd(): number {
    return this.buffer.readInt32LE(this.offset + 28)
  }

  get isLeaf(): boolean {
    return this.buffer.readInt32LE(this.offset + 32) === RTREE_LEAF_FLAG
  }

  intersects(bbox: BBox): boolean {
    return Gt.intersects(this.bbox, bbox)
  }

  private get offset(): number {
    return this.position * IndexRtree.ENTRY_SIZE
  }
}

export class IndexRtree extends Index<BBox> {
  static readonly NAME = 'rtree'
  static readonly ENTRY_SIZE = 36

  constructor(
    layer: Layer,
    private readonly record: IndexRecord,
    private readonly buffer: Buffer,
    readonly entry: HeaderEntry
  ) {
    super(IndexRtree.NAME, layer)
  }

  static fromBuffer(layer: Layer, record: IndexRecord, fileBuffer: Buffer, entry: HeaderEntry): IndexRtree {
    return new IndexRtree(
      layer,
      record,
      fileBuffer.subarray(entry.offset, entry.offset + entry.byteLength),
      entry
    )
  }

  static fromSegment(layer: Layer, record: IndexRecord, buffer: Buffer, entry: HeaderEntry): IndexRtree {
    return new IndexRtree(layer, record, buffer, entry)
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
          const feature = await this.record.get(records[position])
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
    if (this.entry.byteLength === 0) return []

    const records: number[] = []
    const stack = [0]

    while (stack.length > 0) {
      const entry = this.readEntry(stack.pop()!)
      if (!entry.intersects(bbox)) continue

      if (entry.isLeaf) {
        for (let record = entry.recordStart; record <= entry.recordEnd; record += 1) {
          records.push(record)
        }
        continue
      }

      for (let offset = entry.childCount - 1; offset >= 0; offset -= 1) {
        stack.push(entry.firstChild + offset)
      }
    }

    return records
  }

  private readEntry(position: number): RtreeEntry {
    if (position < 0 || position >= this.entry.recordCount) {
      throw new Error(`Invalid rtree index: entry ${position} is out of bounds`)
    }
    return new RtreeEntry(this.buffer, position)
  }
}

export class IndexRtreeBuilder {
  private tree = new RBush<RtreeRange>()
  private chunkStart = 0
  private chunkCount = 0
  private chunkBbox: BBox | null = null

  add(feature: Feature, record: number): void {
    if (this.chunkCount === 0) this.chunkStart = record

    const bbox = feature.bbox
    this.chunkCount = record - this.chunkStart + 1
    if (bbox) this.chunkBbox = this.chunkBbox ? Gt.expand(this.chunkBbox, bbox) : bbox

    if (this.chunkCount === RTREE_CHUNK_SIZE) this.flushChunk()
  }

  finalize() {
    this.flushChunk()
    const buffer = new RtreeToBuffer(this.tree).write()

    return {
      name: IndexRtree.NAME,
      buffer,
      recordCount: buffer.length / IndexRtree.ENTRY_SIZE,
      entrySize: IndexRtree.ENTRY_SIZE
    }
  }

  private flushChunk(): void {
    if (this.chunkCount === 0) return

    if (this.chunkBbox) {
      this.tree.insert({
        minX: this.chunkBbox[0],
        minY: this.chunkBbox[1],
        maxX: this.chunkBbox[2],
        maxY: this.chunkBbox[3],
        recordStart: this.chunkStart,
        recordEnd: this.chunkStart + this.chunkCount - 1
      })
    }

    this.chunkStart += this.chunkCount
    this.chunkCount = 0
    this.chunkBbox = null
  }
}

class RtreeToBuffer {
  private buffer = resizableBuffer(IndexRtree.ENTRY_SIZE * 1024)
  private count = 0

  constructor(private readonly tree: RBush<RtreeRange>) {}

  write(): Buffer {
    if (this.tree.all().length === 0) return Buffer.alloc(0)

    this.writeEntry(this.tree.toJSON() as RtreeNode)
    return this.buffer.subarray(0, this.count * IndexRtree.ENTRY_SIZE)
  }

  private writeEntry(node: RtreeNode | RtreeRange): number {
    const index = this.count
    this.reserve(1)
    this.writeEntryAt(index, node)
    return index
  }

  private writeEntryAt(index: number, node: RtreeNode | RtreeRange): void {
    const children = this.isNode(node) ? node.children : []
    const firstChild = children.length > 0 ? this.count : -1

    this.reserve(children.length)
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      this.writeEntryAt(firstChild + childIndex, children[childIndex])
    }

    this.writeFields(index, node, firstChild, children.length, this.isNode(node) ? 0 : RTREE_LEAF_FLAG)
  }

  private writeFields(index: number, item: RtreeNode | RtreeRange, firstChild: number, childCount: number, flags: number): void {
    const offset = index * IndexRtree.ENTRY_SIZE
    this.buffer.writeFloatLE(item.minX, offset)
    this.buffer.writeFloatLE(item.minY, offset + 4)
    this.buffer.writeFloatLE(item.maxX, offset + 8)
    this.buffer.writeFloatLE(item.maxY, offset + 12)
    this.buffer.writeInt32LE(firstChild, offset + 16)
    this.buffer.writeInt32LE(childCount, offset + 20)
    this.buffer.writeInt32LE(this.isNode(item) ? -1 : item.recordStart, offset + 24)
    this.buffer.writeInt32LE(this.isNode(item) ? -1 : item.recordEnd, offset + 28)
    this.buffer.writeInt32LE(flags, offset + 32)
  }

  private isNode(item: RtreeNode | RtreeRange): item is RtreeNode {
    return 'children' in item
  }

  private reserve(entryCount: number): void {
    if (entryCount === 0) return

    const needed = (this.count + entryCount) * IndexRtree.ENTRY_SIZE
    if (needed > this.buffer.length) {
      let capacity = this.buffer.length
      while (capacity < needed) capacity *= 2
      resizeBuffer(this.buffer, capacity)
    }

    this.count += entryCount
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
