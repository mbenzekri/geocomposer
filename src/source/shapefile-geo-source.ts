import { constants, createReadStream, type PathLike } from 'node:fs'
import { access, open, readFile, type FileHandle } from 'node:fs/promises'
import type { BBox, CrsCode, GeoProperties } from '../core/types.js'
import type { GeoFeature, GeoFeatureByteRange, GeoFeatureSourceRef } from '../geometry/geo-feature.js'
import type { GeoGeometry, GeoPosition } from '../geometry/geo-geometry.js'
import { GeoSource, type GeoStreamOptions } from './geo-source.js'

export type ShapefileGeoSourceOptions = {
  crs?: CrsCode
  dbfEncoding?: BufferEncoding
  highWaterMark?: number
  transformFeature?: (feature: GeoFeature, index: number) => GeoFeature | Promise<GeoFeature>
}

type ShpRecord = {
  recordNumber: number
  offset: number
  byteLength: number
  content: Buffer
}

type DbfField = {
  name: string
  type: string
  length: number
  decimalCount: number
  offset: number
}

type DbfRecord = {
  properties: GeoProperties
  sourceRef: GeoFeatureByteRange
  deleted: boolean
}

export class ShapefileGeoSource extends GeoSource {
  readonly type = 'shapefile'
  readonly crs: CrsCode

  private readonly dbfEncoding?: BufferEncoding
  private readonly highWaterMark?: number
  private readonly transformFeature?: ShapefileGeoSourceOptions['transformFeature']
  private dbfReader: DbfReader | null = null

  constructor(
    readonly id: string,
    private readonly shpPath: PathLike,
    private readonly dbfPath: PathLike,
    options: ShapefileGeoSourceOptions = {}
  ) {
    super()

    this.crs = options.crs ?? 'EPSG:4326'
    this.dbfEncoding = options.dbfEncoding
    this.highWaterMark = options.highWaterMark
    this.transformFeature = options.transformFeature
  }

  async open(): Promise<void> {
    await access(this.shpPath, constants.R_OK)
    await access(this.dbfPath, constants.R_OK)
    await this.getDbfReader()
  }

  async close(): Promise<void> {
    await this.dbfReader?.close()
    this.dbfReader = null
  }

  async getExtent(): Promise<BBox | null> {
    const handle = await open(this.shpPath, 'r')
    try {
      const header = Buffer.alloc(100)
      const bytesRead = await readFully(handle, header, 0)
      if (bytesRead < header.length) return null

      return [
        header.readDoubleLE(36),
        header.readDoubleLE(44),
        header.readDoubleLE(52),
        header.readDoubleLE(60)
      ]
    } finally {
      await handle.close()
    }
  }

  stream(options: GeoStreamOptions = {}): ReadableStream<GeoFeature> {
    const iterator = this.readFeatures(options.signal)[Symbol.asyncIterator]()

    return new ReadableStream<GeoFeature>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(getAbortReason(options.signal))
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

  private async *readFeatures(signal?: AbortSignal): AsyncGenerator<GeoFeature> {
    const dbf = await this.getDbfReader()
    const parser = new ShpRecordParser()
    const file = createReadStream(this.shpPath, {
      start: 100,
      highWaterMark: this.highWaterMark,
      signal
    })

    try {
      for await (const chunk of file) {
        throwIfAborted(signal)
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))

        for (;;) {
          const record = parser.read()
          if (!record) break

          const recordIndex = record.recordNumber - 1
          const dbfRecord = await dbf.readRecord(recordIndex)
          const sourceRef: GeoFeatureSourceRef = {
            sourceId: `${this.id}:shp`,
            offset: record.offset,
            byteLength: record.byteLength,
            recordIndex,
            related: {
              dbf: dbfRecord.sourceRef
            }
          }
          const sourceFeature: GeoFeature = {
            type: 'Feature',
            id: record.recordNumber,
            properties: dbfRecord.properties,
            geometry: parseShapeGeometry(record.content),
            sourceRef
          }
          const outputFeature = this.transformFeature
            ? await this.transformFeature(sourceFeature, recordIndex)
            : sourceFeature

          yield { ...outputFeature, sourceRef }
          throwIfAborted(signal)
        }
      }

      if (!parser.empty) {
        throw new Error('Invalid shapefile: unfinished record at end of file')
      }
    } finally {
      file.destroy()
    }
  }

  private async getDbfReader(): Promise<DbfReader> {
    if (this.dbfReader) return this.dbfReader

    const encoding = this.dbfEncoding ?? await readDbfEncoding(this.dbfPath)
    this.dbfReader = await DbfReader.open(`${this.id}:dbf`, this.dbfPath, encoding)
    return this.dbfReader
  }
}

class ShpRecordParser {
  private buffer = Buffer.alloc(0)
  private bufferOffset = 100

  get empty(): boolean {
    return this.buffer.length === 0
  }

  push(chunk: Buffer): void {
    this.buffer = /* this.buffer.length === 0 ? chunk : */ Buffer.concat([this.buffer, chunk])
  }

  read(): ShpRecord | null {
    if (this.buffer.length < 8) return null

    const recordNumber = this.buffer.readInt32BE(0)
    const contentByteLength = this.buffer.readInt32BE(4) * 2
    const byteLength = 8 + contentByteLength
    if (this.buffer.length < byteLength) return null

    const record: ShpRecord = {
      recordNumber,
      offset: this.bufferOffset,
      byteLength,
      content: this.buffer.subarray(8, byteLength)
    }

    this.buffer = this.buffer.subarray(byteLength)
    this.bufferOffset += byteLength
    return record
  }
}

class DbfReader {
  private constructor(
    private readonly sourceId: string,
    private readonly handle: FileHandle,
    private readonly encoding: BufferEncoding,
    private readonly recordCount: number,
    private readonly headerLength: number,
    private readonly recordLength: number,
    private readonly fields: DbfField[]
  ) {}

  static async open(sourceId: string, path: PathLike, encoding: BufferEncoding): Promise<DbfReader> {
    const handle = await open(path, 'r')

    try {
      const header = Buffer.alloc(32)
      const bytesRead = await readFully(handle, header, 0)
      if (bytesRead < header.length) {
        throw new Error('Invalid DBF: header is too short')
      }

      const recordCount = header.readUInt32LE(4)
      const headerLength = header.readUInt16LE(8)
      const recordLength = header.readUInt16LE(10)
      const descriptors = Buffer.alloc(headerLength - 32)
      const descriptorBytesRead = await readFully(handle, descriptors, 32)
      if (descriptorBytesRead < descriptors.length) {
        throw new Error('Invalid DBF: field descriptors are incomplete')
      }

      const fields: DbfField[] = []
      let recordOffset = 1

      for (let offset = 0; offset + 32 <= descriptors.length; offset += 32) {
        if (descriptors[offset] === 0x0d) break

        const descriptor = descriptors.subarray(offset, offset + 32)
        const nameEnd = descriptor.indexOf(0)
        const name = descriptor
          .subarray(0, nameEnd === -1 ? 11 : nameEnd)
          .toString('ascii')
          .trim()
        const length = descriptor[16]

        if (!name || length === 0) continue

        fields.push({
          name,
          type: String.fromCharCode(descriptor[11]),
          length,
          decimalCount: descriptor[17],
          offset: recordOffset
        })
        recordOffset += length
      }

      return new DbfReader(sourceId, handle, encoding, recordCount, headerLength, recordLength, fields)
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async close(): Promise<void> {
    await this.handle.close()
  }

  async readRecord(index: number): Promise<DbfRecord> {
    if (index < 0 || index >= this.recordCount) {
      throw new Error(`Invalid DBF: record index ${index} is out of range`)
    }

    const offset = this.headerLength + index * this.recordLength
    const record = Buffer.alloc(this.recordLength)
    const bytesRead = await readFully(this.handle, record, offset)
    if (bytesRead < this.recordLength) {
      throw new Error(`Invalid DBF: record ${index} is incomplete`)
    }

    const deleted = record[0] === 0x2a
    const properties: GeoProperties = {}

    if (!deleted) {
      for (const field of this.fields) {
        const value = parseDbfValue(record.subarray(field.offset, field.offset + field.length), field, this.encoding)
        properties[field.name] = value
      }
    }

    return {
      properties,
      deleted,
      sourceRef: {
        sourceId: this.sourceId,
        offset,
        byteLength: this.recordLength
      }
    }
  }
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let total = 0

  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total)
    if (bytesRead === 0) break
    total += bytesRead
  }

  return total
}
function parseShapeGeometry(content: Buffer): GeoGeometry | null {
  if (content.length < 4) return null

  const shapeType = content.readInt32LE(0)

  switch (shapeType) {
    case 0:
      return null

    case 1:
    case 11:
    case 21:
      return parsePoint(content)

    case 3:
    case 13:
    case 23:
      return parsePolyLine(content)

    case 5:
    case 15:
    case 25:
      return parsePolygon(content)

    case 8:
    case 18:
    case 28:
      return parseMultiPoint(content)

    default:
      throw new Error(`Unsupported shapefile shape type: ${shapeType}`)
  }
}

function parsePoint(content: Buffer): GeoGeometry | null {
  if (content.length < 20) return null

  return {
    type: 'Point',
    coordinates: [content.readDoubleLE(4), content.readDoubleLE(12)]
  }
}

function parseMultiPoint(content: Buffer): GeoGeometry | null {
  if (content.length < 40) return null

  const pointCount = content.readInt32LE(36)
  const coordinates = readPoints(content, 40, pointCount)

  return {
    type: 'MultiPoint',
    coordinates
  }
}

function parsePolyLine(content: Buffer): GeoGeometry | null {
  const parts = readPartedPoints(content)
  if (!parts || parts.length === 0) return null

  if (parts.length === 1) {
    return {
      type: 'LineString',
      coordinates: parts[0]
    }
  }

  return {
    type: 'MultiLineString',
    coordinates: parts
  }
}

function parsePolygon(content: Buffer): GeoGeometry | null {
  const rings = readPartedPoints(content)
  if (!rings || rings.length === 0) return null

  const polygons = groupPolygonRings(rings)

  if (polygons.length === 1) {
    return {
      type: 'Polygon',
      coordinates: polygons[0]
    }
  }

  return {
    type: 'MultiPolygon',
    coordinates: polygons
  }
}

function readPartedPoints(content: Buffer): GeoPosition[][] | null {
  if (content.length < 44) return null

  const partCount = content.readInt32LE(36)
  const pointCount = content.readInt32LE(40)
  const partOffset = 44
  const pointOffset = partOffset + partCount * 4

  if (content.length < pointOffset + pointCount * 16) return null

  const partStarts: number[] = []
  for (let index = 0; index < partCount; index += 1) {
    partStarts.push(content.readInt32LE(partOffset + index * 4))
  }

  const points = readPoints(content, pointOffset, pointCount)

  return partStarts.map((start, index) => {
    const end = partStarts[index + 1] ?? points.length
    return points.slice(start, end)
  })
}

function readPoints(content: Buffer, offset: number, count: number): GeoPosition[] {
  const points: GeoPosition[] = []

  for (let index = 0; index < count; index += 1) {
    const pointOffset = offset + index * 16
    points.push([
      content.readDoubleLE(pointOffset),
      content.readDoubleLE(pointOffset + 8)
    ])
  }

  return points
}

function groupPolygonRings(rings: GeoPosition[][]): GeoPosition[][][] {
  const outerRings: GeoPosition[][] = []
  const holes: GeoPosition[][] = []

  for (const ring of rings) {
    if (signedRingArea(ring) < 0) {
      outerRings.push(ring)
    } else {
      holes.push(ring)
    }
  }

  if (outerRings.length === 0) return [rings]

  const polygons = outerRings.map((ring) => [ring])

  for (const hole of holes) {
    const point = hole[0]
    const polygonIndex = point
      ? outerRings.findIndex((outer) => pointInRing(point, outer))
      : -1

    polygons[Math.max(0, polygonIndex)].push(hole)
  }

  return polygons
}

function signedRingArea(ring: GeoPosition[]): number {
  let area = 0

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]
    const next = ring[(index + 1) % ring.length]
    area += current[0] * next[1] - next[0] * current[1]
  }

  return area / 2
}

function pointInRing(point: GeoPosition, ring: GeoPosition[]): boolean {
  let inside = false

  for (let currentIndex = 0, previousIndex = ring.length - 1; currentIndex < ring.length; previousIndex = currentIndex, currentIndex += 1) {
    const current = ring[currentIndex]
    const previous = ring[previousIndex]
    const intersects = (current[1] > point[1]) !== (previous[1] > point[1])
      && point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) / (previous[1] - current[1]) + current[0]

    if (intersects) inside = !inside
  }

  return inside
}

function parseDbfValue(raw: Buffer, field: DbfField, encoding: BufferEncoding): unknown {
  const text = raw.toString(encoding).trim()

  if (text.length === 0) return null

  switch (field.type.toUpperCase()) {
    case 'N':
    case 'F': {
      const value = Number(text)
      return Number.isNaN(value) ? null : value
    }

    case 'L': {
      const value = text.toUpperCase()
      if (value === 'T' || value === 'Y') return true
      if (value === 'F' || value === 'N') return false
      return null
    }

    case 'D':
      return text.length === 8
        ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
        : text

    default:
      return text
  }
}

async function readDbfEncoding(dbfPath: PathLike): Promise<BufferEncoding> {
  if (typeof dbfPath !== 'string') return 'utf8'

  try {
    const cpgPath = dbfPath.replace(/\.dbf$/i, '.cpg')
    const codePage = (await readFile(cpgPath, 'utf8')).trim().toLowerCase()

    if (codePage === 'utf-8' || codePage === 'utf8' || codePage === '65001') return 'utf8'
    if (codePage === 'ascii' || codePage === 'us-ascii') return 'ascii'
    if (codePage === 'latin1' || codePage === 'iso-8859-1' || codePage === 'windows-1252' || codePage === 'cp1252') return 'latin1'
  } catch {
    return 'utf8'
  }

  return 'utf8'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw getAbortReason(signal)
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Shapefile stream aborted')
}