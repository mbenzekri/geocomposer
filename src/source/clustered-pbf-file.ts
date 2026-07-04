import type { PathLike } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
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

const FEATURE_ID_STRING = 1
const FEATURE_ID_NUMBER = 2
const FEATURE_BBOX = 3
const FEATURE_PROPERTIES = 4
const FEATURE_GEOMETRY = 5

const GEOMETRY_TYPE = 1
const GEOMETRY_PRECISION = 2
const GEOMETRY_DIMENSIONS = 3
const GEOMETRY_COORDS_INT = 4
const GEOMETRY_COORDS_DOUBLE = 5
const GEOMETRY_NESTING = 6

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH_DELIMITED = 2

type ClusterFeature = {
  feature: Feature
  hilbert: number
  index: number
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

export class ClusteredPbfFile {
  private readonly codec = new FeaturePbfCodec()

  constructor(
    private readonly sourceId: string,
    private readonly filePath: string,
    private readonly highWaterMark = DEFAULT_HIGH_WATER_MARK
  ) {}

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
    force = false
  ): Promise<void> {
    if (!force && !await this.needsBuild(originalFiles)) return

    const features: ClusterFeature[] = []
    const precision = clusteredCoordinatePrecision(layer)
    const reader = streamOriginal().getReader()
    let index = 0

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        features.push({
          feature: toWritableFeature(result.value, precision),
          hilbert: hilbertKey(result.value, layer),
          index
        })
        index += 1
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }

    features.sort((a, b) => a.hilbert - b.hilbert || a.index - b.index)
    await this.write(features.map((item) => item.feature), precision)
  }

  stream(options: StreamOptions): AsyncIterable<Feature> {
    return this.streamFile(options)
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const ref = this.toFileRef(sourceRef)
    const handle = await openFile(this.filePath, 'r')
    const buffer = Buffer.alloc(ref.byteLength)

    try {
      const bytesRead = await FileByteReader.readFully(handle, buffer, ref.offset)
      if (bytesRead < ref.byteLength) {
        throw new Error('Invalid clustered PBF sourceRef: byte range exceeds file length')
      }

      return this.withSourceRef(this.codec.decodeRecord(buffer, options.layer), {
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

  private async write(features: readonly Feature[], precision: number | undefined): Promise<void> {
    const handle = await openFile(this.filePath, 'w')
    let position = 0

    try {
      for (const feature of features) {
        const record = this.codec.encodeRecord(feature, precision)
        await handle.write(record, 0, record.length, position)
        position += record.length
      }
    } finally {
      await handle.close()
    }
  }

  private async *streamFile(options: StreamOptions): AsyncGenerator<Feature> {
    const handle = await openFile(this.filePath, 'r')
    const parser = new DelimitedPbfParser()
    let position = 0

    try {
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

          yield this.withSourceRef(this.codec.decodeMessage(record.message, options.layer), {
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

export function clusteredPbfPath(sourceFile: SourceFile): string {
  return `${pathToString(sourceFile.path)}.clustered.pbf`
}

function pathToString(path: PathLike): string {
  if (path instanceof URL) return fileURLToPath(path)
  return path.toString()
}

class FeaturePbfCodec {
  encodeRecord(feature: Feature, precision: number | undefined): Buffer {
    const message = this.encodeMessage(feature, precision)
    return Buffer.concat([encodeVarint(BigInt(message.length)), message])
  }

  decodeRecord(record: Buffer, layer: Layer): Feature {
    const length = readVarint(record, 0)
    const start = length.next
    const end = start + Number(length.value)
    if (end !== record.length) throw new Error('Invalid clustered PBF record length')
    return this.decodeMessage(record.subarray(start, end), layer)
  }

  decodeMessage(buffer: Buffer, layer: Layer): Feature {
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
          properties = JSON.parse(value.buffer.toString('utf8')) as Props
          position = value.next
          break
        }
        case FEATURE_GEOMETRY: {
          const value = readLengthDelimited(buffer, position, wireType)
          geometry = this.decodeGeometry(value.buffer)
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

  private encodeMessage(feature: Feature, precision: number | undefined): Buffer {
    const fields: Buffer[] = []

    if (typeof feature.id === 'string') fields.push(writeString(FEATURE_ID_STRING, feature.id))
    else if (typeof feature.id === 'number') fields.push(writeDouble(FEATURE_ID_NUMBER, feature.id))

    if (feature.bbox) fields.push(writePackedDouble(FEATURE_BBOX, feature.bbox))
    if (feature.properties !== null) fields.push(writeString(FEATURE_PROPERTIES, JSON.stringify(feature.properties)))
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

  private decodeGeometry(buffer: Buffer): Geometry {
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
  private bufferOffset = 0

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
    properties: feature.properties ?? null,
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

function inflateGeometry(decoded: DecodedGeometry): Geometry {
  if (!decoded.type || !decoded.dimensions) throw new Error('Invalid clustered PBF geometry')
  const positions = inflatePositions(decoded)
  let offset = 0

  const take = (count: number): Position[] => {
    const items = positions.slice(offset, offset + count)
    offset += count
    return items
  }

  switch (decoded.type) {
    case 1:
      return { type: 'Point', coordinates: positions[0] }
    case 2:
      return { type: 'LineString', coordinates: take(decoded.nesting[0] ?? positions.length) }
    case 3: {
      const ringCount = decoded.nesting[0] ?? 0
      const rings: Position[][] = []
      for (let index = 0; index < ringCount; index += 1) rings.push(take(decoded.nesting[index + 1] ?? 0))
      return { type: 'Polygon', coordinates: rings }
    }
    case 4:
      return { type: 'MultiPoint', coordinates: take(decoded.nesting[0] ?? positions.length) }
    case 5: {
      const lineCount = decoded.nesting[0] ?? 0
      const lines: Position[][] = []
      for (let index = 0; index < lineCount; index += 1) lines.push(take(decoded.nesting[index + 1] ?? 0))
      return { type: 'MultiLineString', coordinates: lines }
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
      return { type: 'MultiPolygon', coordinates: polygons }
    }
  }
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
