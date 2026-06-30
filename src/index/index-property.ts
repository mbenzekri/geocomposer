import type { Feature } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import type { RequestTimings } from '../source/source.js'
import {
  comparePropertyValues,
  matchesPropertyFilter,
  toComparablePropertyValue,
  type ComparablePropertyValue,
  type PropertyFilterCriteria
} from '../stream/property-filter.js'
import { Index } from './index.js'
import type { HeaderEntry } from './indexer.js'
import { IndexRecord } from './index-record.js'

const MAX_INDEX_BUFFER_SIZE = 0x7fffffff

type PropertyIndexItem = {
  record: number
  value: ComparablePropertyValue
}

type ComparablePropertyType = 'string' | 'number' | 'boolean'

export class IndexProperty extends Index<PropertyFilterCriteria> {
  static readonly NAME_PREFIX = 'property:'
  static readonly ENTRY_SIZE = 4

  constructor(
    layer: Layer,
    private readonly record: IndexRecord,
    readonly property: string,
    private readonly buffer: Buffer,
    readonly entry: HeaderEntry
  ) {
    super(IndexProperty.indexName(property), layer)
  }

  static indexName(property: string): string {
    return `${IndexProperty.NAME_PREFIX}${property}`
  }

  static isIndexName(name: string): boolean {
    return name.startsWith(IndexProperty.NAME_PREFIX)
  }

  static propertyFromIndexName(name: string): string {
    if (!IndexProperty.isIndexName(name)) throw new Error(`Invalid property index name "${name}"`)
    return name.slice(IndexProperty.NAME_PREFIX.length)
  }

  static fromBuffer(layer: Layer, record: IndexRecord, fileBuffer: Buffer, entry: HeaderEntry): IndexProperty {
    return new IndexProperty(
      layer,
      record,
      IndexProperty.propertyFromIndexName(entry.name),
      fileBuffer.subarray(entry.offset, entry.offset + entry.byteLength),
      entry
    )
  }

  static fromSegment(layer: Layer, record: IndexRecord, buffer: Buffer, entry: HeaderEntry): IndexProperty {
    return new IndexProperty(layer, record, IndexProperty.propertyFromIndexName(entry.name), buffer, entry)
  }

  stream(criteria?: PropertyFilterCriteria, timings?: RequestTimings): ReadableStream<Feature> {
    if (!criteria) throw new Error('IndexProperty.stream requires property criteria')
    if (criteria.property !== this.property) {
      throw new Error(`IndexProperty "${this.property}" cannot query property "${criteria.property}"`)
    }

    const records = this.records(criteria)
    let position = 0

    return new ReadableStream({
      pull: async (controller) => {
        const resolvedRecords = await records
        while (position < resolvedRecords.length) {
          const feature = await this.record.get(resolvedRecords[position], timings)
          position += 1
          if (feature && matchesPropertyFilter(feature, criteria)) {
            controller.enqueue(feature)
            return
          }
        }

        controller.close()
      }
    })
  }

  private async records(criteria: PropertyFilterCriteria): Promise<number[]> {
    if (this.entry.byteLength === 0) return []
    if (toComparablePropertyValue(criteria.value) === null) return []

    if (criteria.op === '<') return this.recordSlice(0, await this.lowerBound(criteria.value))
    if (criteria.op === '>') return this.recordSlice(await this.upperBound(criteria.value), this.entry.recordCount)

    const start = await this.lowerBound(criteria.value)
    return this.recordSlice(start, await this.upperBound(criteria.value, start))
  }

  private async lowerBound(value: unknown, low = 0): Promise<number> {
    return this.bound(value, low, false)
  }

  private async upperBound(value: unknown, low = 0): Promise<number> {
    return this.bound(value, low, true)
  }

  private async bound(value: unknown, low: number, upper: boolean): Promise<number> {
    const comparable = toComparablePropertyValue(value)
    if (comparable === null) return 0

    let high = this.entry.recordCount
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      const comparison = await this.compareEntry(mid, comparable)
      if (comparison === null) return 0
      if (comparison < 0 || (upper && comparison === 0)) low = mid + 1
      else high = mid
    }

    return low
  }

  private async compareEntry(position: number, value: ComparablePropertyValue): Promise<number | null> {
    const feature = await this.record.get(this.recordAt(position))
    if (!feature) return null

    const propertyValue = toComparablePropertyValue(feature.properties?.[this.property])
    if (propertyValue === null) return null

    return comparePropertyValues(propertyValue, value)
  }

  private recordSlice(start: number, end: number): number[] {
    const records: number[] = []
    for (let position = start; position < end; position += 1) records.push(this.recordAt(position))
    return records
  }

  private recordAt(position: number): number {
    if (position < 0 || position >= this.entry.recordCount) {
      throw new Error(`Invalid property index "${this.property}": entry ${position} is out of bounds`)
    }

    const offset = position * IndexProperty.ENTRY_SIZE
    if (this.entry.entrySize !== IndexProperty.ENTRY_SIZE || offset + IndexProperty.ENTRY_SIZE > this.buffer.length) {
      throw new Error(`Invalid property index "${this.property}": entry exceeds buffer length`)
    }

    return this.buffer.readUInt32LE(offset)
  }
}

export class IndexPropertyBuilder {
  private readonly items: PropertyIndexItem[] = []
  private valueType?: ComparablePropertyType

  constructor(readonly property: string) {}

  add(feature: Feature, record: number): void {
    if (!Number.isSafeInteger(record) || record < 0 || record > 0xffffffff) {
      throw new Error(`Record index ${record} is out of bounds for property index "${this.property}"`)
    }

    const value = toComparablePropertyValue(feature.properties?.[this.property])
    if (value === null) return

    const valueType = typeof value as ComparablePropertyType
    this.valueType ??= valueType
    if (valueType !== this.valueType) {
      throw new Error(`Property index "${this.property}" cannot mix ${this.valueType} and ${valueType} values`)
    }

    this.items.push({ record, value })
  }

  finalize() {
    this.items.sort((left, right) => {
      const comparison = comparePropertyValues(left.value, right.value)
      if (comparison !== null && comparison !== 0) return comparison
      if (comparison === null) return String(left.value).localeCompare(String(right.value))
      return left.record - right.record
    })

    const buffer = resizableBuffer(Math.max(IndexProperty.ENTRY_SIZE, this.items.length * IndexProperty.ENTRY_SIZE))
    for (let index = 0; index < this.items.length; index += 1) {
      buffer.writeUInt32LE(this.items[index].record, index * IndexProperty.ENTRY_SIZE)
    }

    return {
      name: IndexProperty.indexName(this.property),
      buffer: buffer.subarray(0, this.items.length * IndexProperty.ENTRY_SIZE),
      recordCount: this.items.length,
      entrySize: IndexProperty.ENTRY_SIZE
    }
  }
}

function resizableBuffer(byteLength: number): Buffer {
  const ResizableArrayBuffer = ArrayBuffer as unknown as {
    new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer
  }
  return Buffer.from(new ResizableArrayBuffer(byteLength, { maxByteLength: MAX_INDEX_BUFFER_SIZE }))
}
