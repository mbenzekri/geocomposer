import type { PathLike } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as wkx from 'wkx'
import type { DescInfo, Feature, FileRef, SourceRef } from '../core/feature.js'
import type { Geometry, Position } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { FileSource, hasSourceConfigType, type FeatureTransform, type SourceIndexConfig } from './source.js'
import type { StreamOptions } from './source.js'
import { AbortSignalGuard, FileByteReader } from './source-utils.js'

const DEFAULT_GEOMETRY_COLUMN = 'geometry'
const DEFAULT_PRIMARY_KEY = 'id'
const DEFAULT_DELIMITER = ','
const QUOTE = '"'.charCodeAt(0)
const LF = '\n'.charCodeAt(0)

export type CsvSourceJson = DescInfo & {
  type: 'csv'
  path: string
  gzip?: boolean
  encoding?: BufferEncoding
  highWaterMark?: number
  delimiter?: string
  geometryColumn?: string
  x?: string
  y?: string
  primaryKey?: string
  indexes?: SourceIndexConfig
}

export type CsvSourceOptions = DescInfo & {
  gzip?: boolean
  encoding?: BufferEncoding
  highWaterMark?: number
  delimiter?: string
  geometryColumn?: string
  x?: string
  y?: string
  primaryKey?: string
  indexes?: SourceIndexConfig
  transformFeature?: FeatureTransform
}

type CsvRecord = {
  fields: string[]
  offset: number
  byteLength: number
}

export class CsvSource extends FileSource {
  readonly type = 'csv'

  private readonly reader: CsvReader

  static acceptsConfig(entry: unknown): entry is CsvSourceJson {
    return hasSourceConfigType(entry, 'csv')
  }

  static fromConfig(id: string, entry: CsvSourceJson): CsvSource {
    return new CsvSource(id, entry.path, {
      title: entry.title,
      abstract: entry.abstract,
      gzip: entry.gzip,
      encoding: entry.encoding,
      highWaterMark: entry.highWaterMark,
      delimiter: entry.delimiter,
      geometryColumn: entry.geometryColumn,
      x: entry.x,
      y: entry.y,
      primaryKey: entry.primaryKey,
      indexes: entry.indexes
    })
  }

  constructor(
    id: string,
    private readonly filePath: PathLike,
    options: CsvSourceOptions = {}
  ) {
    super(id, options, options.transformFeature)

    this.reader = new CsvReader(this.id, {
      encoding: options.encoding ?? 'utf8',
      highWaterMark: options.highWaterMark,
      delimiter: normalizeDelimiter(options.delimiter),
      geometryColumn: resolveGeometryColumn(this.id, options),
      x: resolveCoordinateColumn(this.id, options, 'x'),
      y: resolveCoordinateColumn(this.id, options, 'y'),
      primaryKey: options.primaryKey ?? DEFAULT_PRIMARY_KEY
    })
  }

  getFiles() {
    return [{ role: 'data', path: this.filePath }]
  }

  protected override streamFeatures(options: StreamOptions): AsyncIterable<Feature> {
    return this.reader.stream(options, this.fileStream('data', {
      highWaterMark: this.reader.highWaterMark,
      signal: options.signal
    }))
  }

  protected override readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    return this.reader.read(
      sourceRef,
      options,
      this.fileHandle('data'),
      this.fileStream('data', {
        highWaterMark: this.reader.highWaterMark,
        signal: options.signal
      })
    )
  }

  protected override abortReason(signal: AbortSignal): unknown {
    return AbortSignalGuard.reason(signal, 'CSV stream aborted')
  }
}

class CsvReader {
  constructor(
    private readonly sourceId: string,
    private readonly options: {
      encoding: BufferEncoding
      highWaterMark?: number
      delimiter: string
      geometryColumn?: string
      x?: string
      y?: string
      primaryKey: string
    }
  ) {}

  get highWaterMark(): number | undefined {
    return this.options.highWaterMark
  }

  async *stream(options: StreamOptions, file: AsyncIterable<Buffer | string>): AsyncGenerator<Feature> {
    const records = this.records(options.signal, file)
    const headerRecord = await records.next()
    if (headerRecord.done) return

    const header = this.header(headerRecord.value.fields)
    let index = 0

    for await (const record of records) {
      AbortSignalGuard.throwIfAborted(options.signal, 'CSV stream aborted')

      yield this.feature(record, header, options.layer, index)
      index += 1
    }
  }

  async read(
    sourceRef: SourceRef,
    options: StreamOptions,
    handle: FileHandle,
    file: AsyncIterable<Buffer | string>
  ): Promise<Feature | null> {
    const ref = this.toFileRef(sourceRef)
    const header = await this.readHeader(options.signal, file)

    const buffer = Buffer.alloc(ref.byteLength)
    const bytesRead = await FileByteReader.readFully(handle, buffer, ref.offset)
    if (bytesRead < ref.byteLength) {
      throw new Error('Invalid CSV sourceRef: byte range exceeds file length')
    }

    const record: CsvRecord = {
      fields: parseCsvRecord(buffer.toString(this.options.encoding), this.options.delimiter),
      offset: ref.offset,
      byteLength: ref.byteLength
    }
    return this.feature(record, header, options.layer, sourceRef.recordIndex ?? 0)
  }

  private async readHeader(signal: AbortSignal | undefined, file: AsyncIterable<Buffer | string>): Promise<string[]> {
    const records = this.records(signal, file)
    const header = await records.next()
    if (header.done) throw new Error(`CSV source "${this.sourceId}" is empty`)
    await records.return?.(undefined)
    return this.header(header.value.fields)
  }

  private header(fields: string[]): string[] {
    const header = fields.map((field) => field.trim())
    if (header.length === 0 || header.every((field) => field === '')) {
      throw new Error(`CSV source "${this.sourceId}" header is empty`)
    }
    if (this.options.geometryColumn && !header.includes(this.options.geometryColumn)) {
      throw new Error(`CSV source "${this.sourceId}" missing geometryColumn "${this.options.geometryColumn}"`)
    }
    if (this.options.x && !header.includes(this.options.x)) {
      throw new Error(`CSV source "${this.sourceId}" missing x column "${this.options.x}"`)
    }
    if (this.options.y && !header.includes(this.options.y)) {
      throw new Error(`CSV source "${this.sourceId}" missing y column "${this.options.y}"`)
    }
    return header
  }

  private feature(record: CsvRecord, header: string[], layer: Layer, index: number): Feature {
    const row = this.row(header, record.fields)
    const id = row[this.options.primaryKey]
    const geometry = this.geometry(row)
    const geometryColumns = new Set([this.options.geometryColumn, this.options.x, this.options.y])
    const properties = Object.fromEntries(
      Object.entries(row)
        .filter(([name]) => !geometryColumns.has(name))
        .map(([name, value]) => [name, parseCsvValue(value)])
    )

    return {
      type: 'Feature',
      id: id === undefined || id === '' ? undefined : id,
      properties,
      geometry,
      layer,
      sourceRef: {
        storage: 'file',
        sourceId: this.sourceId,
        offset: record.offset,
        byteLength: record.byteLength,
        recordIndex: index
      }
    }
  }

  private geometry(row: Record<string, string>): Geometry | null {
    if (this.options.geometryColumn) {
      return parseWktGeometry(row[this.options.geometryColumn] ?? '')
    }

    const x = row[this.options.x as string]?.trim() ?? ''
    const y = row[this.options.y as string]?.trim() ?? ''
    if (x === '' || y === '') return null

    const coordinate: Position = [Number(x), Number(y)]
    if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
      throw new Error(`CSV source "${this.sourceId}" invalid x/y coordinate "${x},${y}"`)
    }

    return {
      type: 'Point',
      coordinates: coordinate
    }
  }

  private row(header: string[], fields: string[]): Record<string, string> {
    const row: Record<string, string> = {}
    for (let index = 0; index < header.length; index += 1) {
      row[header[index]] = fields[index] ?? ''
    }
    return row
  }

  private async *records(signal: AbortSignal | undefined, file: AsyncIterable<Buffer | string>): AsyncGenerator<CsvRecord> {
    const parser = new CsvRecordParser(this.options.encoding, this.options.delimiter)

    try {
      for await (const chunk of file) {
        AbortSignalGuard.throwIfAborted(signal, 'CSV stream aborted')
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), this.options.encoding))

        for (;;) {
          const record = parser.read()
          if (!record) break
          yield record
        }
      }

      const lastRecord = parser.finish()
      if (lastRecord) yield lastRecord
    } finally {
      ;(file as { destroy?: () => void }).destroy?.()
    }
  }

  private toFileRef(sourceRef: SourceRef): FileRef {
    if (sourceRef.storage !== 'file' || sourceRef.sourceId !== this.sourceId) {
      throw new Error(`Invalid CSV sourceRef for source "${this.sourceId}"`)
    }
    if (!Number.isSafeInteger(sourceRef.offset) || sourceRef.offset < 0) {
      throw new Error('Invalid CSV sourceRef: offset must be a non-negative integer')
    }
    if (!Number.isSafeInteger(sourceRef.byteLength) || sourceRef.byteLength < 0) {
      throw new Error('Invalid CSV sourceRef: byteLength must be a non-negative integer')
    }
    return sourceRef as FileRef
  }
}

class CsvRecordParser {
  private readonly records: CsvRecord[] = []
  private readonly bytes: number[] = []
  private offset = 0
  private recordStart = 0
  private inQuotes = false
  private quotePending = false

  constructor(
    private readonly encoding: BufferEncoding,
    private readonly delimiter: string
  ) {}

  push(chunk: Buffer): void {
    for (const byte of chunk) {
      this.pushByte(byte)
    }
  }

  read(): CsvRecord | null {
    return this.records.shift() ?? null
  }

  finish(): CsvRecord | null {
    if (this.bytes.length === 0) return null
    return this.flushRecord(this.offset)
  }

  private pushByte(byte: number): void {
    this.bytes.push(byte)
    this.offset += 1

    if (this.quotePending) {
      if (byte === QUOTE) {
        this.quotePending = false
        return
      }

      this.inQuotes = false
      this.quotePending = false
    }

    if (this.inQuotes) {
      if (byte === QUOTE) this.quotePending = true
      return
    }

    if (byte === QUOTE) {
      this.inQuotes = true
      return
    }

    if (byte === LF) {
      this.records.push(this.flushRecord(this.offset))
    }
  }

  private flushRecord(endOffset: number): CsvRecord {
    const buffer = Buffer.from(this.bytes)
    this.bytes.length = 0
    const record = {
      fields: parseCsvRecord(buffer.toString(this.encoding), this.delimiter),
      offset: this.recordStart,
      byteLength: endOffset - this.recordStart
    }
    this.recordStart = endOffset
    return record
  }
}

function parseCsvRecord(input: string, delimiter: string): string[] {
  const text = input.endsWith('\n')
    ? input.slice(0, input.endsWith('\r\n') ? -2 : -1)
    : input
  const fields: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (char === delimiter) {
      fields.push(field)
      field = ''
      continue
    }

    field += char
  }

  fields.push(field)
  return fields
}

function resolveGeometryColumn(sourceId: string, options: CsvSourceOptions): string | undefined {
  if (options.geometryColumn && (options.x || options.y)) {
    throw new Error(`CSV source "${sourceId}" cannot combine geometryColumn with x/y columns`)
  }
  if (options.x || options.y) return undefined
  return options.geometryColumn ?? DEFAULT_GEOMETRY_COLUMN
}

function resolveCoordinateColumn(sourceId: string, options: CsvSourceOptions, axis: 'x' | 'y'): string | undefined {
  const value = options[axis]
  if (!options.x && !options.y) return undefined
  if (!options.x || !options.y) {
    throw new Error(`CSV source "${sourceId}" requires both x and y columns`)
  }
  if (!value) return undefined
  const column = value.trim()
  if (column === '') {
    throw new Error(`CSV source "${sourceId}" ${axis} column must not be empty`)
  }
  return column
}

function parseCsvValue(value: string): string | number | boolean | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.toLowerCase() === 'true') return true
  if (trimmed.toLowerCase() === 'false') return false

  const number = Number(trimmed)
  return Number.isFinite(number) ? number : value
}

function parseWktGeometry(wkt: string): Geometry | null {
  if (wkt.trim() === '') return null

  const geojson = wkx.Geometry.parse(wkt).toGeoJSON() as unknown
  return toGeometry(geojson)
}

function toGeometry(value: unknown): Geometry | null {
  if (!isGeoJsonGeometry(value)) return null

  switch (value.type) {
    case 'Point':
    case 'LineString':
    case 'Polygon':
    case 'MultiPoint':
    case 'MultiLineString':
    case 'MultiPolygon':
      return value as Geometry

    case 'GeometryCollection':
      return toHomogeneousGeometry(value.geometries)
  }

  return null
}

function toHomogeneousGeometry(geometries: unknown[]): Geometry | null {
  const items = geometries.map(toGeometry).filter((geometry): geometry is Geometry => geometry !== null)
  if (items.length === 0) return null

  if (items.every((geometry) => geometry.type === 'Point')) {
    return {
      type: 'MultiPoint',
      coordinates: items.map((geometry) => (geometry as { type: 'Point', coordinates: Position }).coordinates)
    }
  }

  if (items.every((geometry) => geometry.type === 'LineString')) {
    return {
      type: 'MultiLineString',
      coordinates: items.map((geometry) => (geometry as { type: 'LineString', coordinates: Position[] }).coordinates)
    }
  }

  if (items.every((geometry) => geometry.type === 'Polygon')) {
    return {
      type: 'MultiPolygon',
      coordinates: items.map((geometry) => (geometry as { type: 'Polygon', coordinates: Position[][] }).coordinates)
    }
  }

  return null
}

function isGeoJsonGeometry(value: unknown): value is {
  type: string
  coordinates?: unknown
  geometries: unknown[]
} {
  return typeof value === 'object' && value !== null && 'type' in value
}

function normalizeDelimiter(value: string | undefined): string {
  const delimiter = value ?? DEFAULT_DELIMITER
  if (delimiter.length !== 1) {
    throw new Error('CSV delimiter must be a single character')
  }
  return delimiter
}
