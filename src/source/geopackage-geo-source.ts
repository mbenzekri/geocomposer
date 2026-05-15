import { constants, type PathLike } from 'node:fs'
import { access } from 'node:fs/promises'
import type { BBox, CrsCode, GeoProperties } from '../core/types.js'
import { computeGeometryBBox, expandBBox } from '../geometry/bbox.js'
import type { GeoFeature, GeoFeatureSourceRef } from '../geometry/geo-feature.js'
import type { GeoGeometry, GeoPosition } from '../geometry/geo-geometry.js'
import { DatabaseGeoSource, type GeoStreamOptions } from './geo-source.js'

export type GeoPackageGeoSourceOptions = {
  crs?: CrsCode
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
  transformFeature?: (feature: GeoFeature, index: number) => GeoFeature | Promise<GeoFeature>
}

type SqliteDatabase = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined
    all: (...params: unknown[]) => Record<string, unknown>[]
  }
  close: () => void
}

type GeoPackageTableMeta = {
  tableName: string
  geometryColumn: string
  primaryKey: string
  propertyColumns: string[]
  extent: BBox | null
  srsId: number | null
}

const GPKG_CRS_PREFIX = 'EPSG:'

export class GeoPackageGeoSource extends DatabaseGeoSource {
  readonly type = 'geopackage'
  get crs(): CrsCode {
    return this.resolvedCrs
  }

  private readonly userCrs?: CrsCode
  private readonly tableName?: string
  private readonly geometryColumn?: string
  private readonly primaryKey?: string
  private readonly transformFeature?: GeoPackageGeoSourceOptions['transformFeature']

  private resolvedCrs: CrsCode
  private db: SqliteDatabase | null = null
  private meta: GeoPackageTableMeta | null = null

  constructor(
    readonly id: string,
    private readonly filePath: PathLike,
    options: GeoPackageGeoSourceOptions = {}
  ) {
    super()

    this.userCrs = options.crs
    this.resolvedCrs = options.crs ?? 'EPSG:4326'
    this.tableName = options.tableName
    this.geometryColumn = options.geometryColumn
    this.primaryKey = options.primaryKey
    this.transformFeature = options.transformFeature
  }

  async open(): Promise<void> {
    await access(this.filePath, constants.R_OK)

    this.db = await openGeoPackageDatabase(this.filePath)
    this.meta = resolveTableMeta(this.db, {
      tableName: this.tableName,
      geometryColumn: this.geometryColumn,
      primaryKey: this.primaryKey
    })

    if (!this.userCrs) {
      const inferredCrs = crsFromSrsId(this.meta.srsId)
      if (inferredCrs) {
        this.resolvedCrs = inferredCrs
      }
    }
  }

  async close(): Promise<void> {
    this.db?.close()
    this.db = null
    this.meta = null
  }

  async getExtent(): Promise<BBox | null> {
    if (!this.meta) {
      throw new Error('GeoPackage source is not opened')
    }

    if (this.meta.extent) {
      return this.meta.extent
    }

    let extent: BBox | null = null

    for await (const feature of this.readFeatures()) {
      const bbox = feature.bbox ?? computeGeometryBBox(feature.geometry)
      if (bbox) extent = extent ? expandBBox(extent, bbox) : bbox
    }

    return extent
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
    if (!this.db || !this.meta) {
      throw new Error('GeoPackage source is not opened')
    }

    const meta = this.meta
    const idExpression = meta.primaryKey === 'rowid'
      ? 'rowid'
      : quoteSqlIdentifier(meta.primaryKey)
    const propertyAliases = meta.propertyColumns.map((column, index) => ({
      column,
      alias: `p_${index}`
    }))
    const selectColumns = [
      `${idExpression} AS ${quoteSqlIdentifier('__id__')}`,
      `${quoteSqlIdentifier(meta.geometryColumn)} AS ${quoteSqlIdentifier('__geom__')}`,
      ...propertyAliases.map(({ column, alias }) =>
        `${quoteSqlIdentifier(column)} AS ${quoteSqlIdentifier(alias)}`
      )
    ]
    const sql = [
      `SELECT ${selectColumns.join(', ')}`,
      `FROM ${quoteSqlIdentifier(meta.tableName)}`,
      `ORDER BY ${idExpression}`
    ].join(' ')

    const rows = this.db.prepare(sql).all()

    for (let index = 0; index < rows.length; index += 1) {
      throwIfAborted(signal)

      const row = rows[index]
      const idValue = row.__id__
      const sourceRef: GeoFeatureSourceRef = {
        storage: 'database',
        sourceId: this.id,
        tableName: meta.tableName,
        rowId: toFeatureRowId(idValue, index),
        primaryKey: meta.primaryKey === 'rowid' ? undefined : meta.primaryKey,
        geometryColumn: meta.geometryColumn,
        recordIndex: index
      }
      const properties: GeoProperties = {}

      for (const { column, alias } of propertyAliases) {
        properties[column] = normalizePropertyValue(row[alias])
      }

      const sourceFeature: GeoFeature = {
        type: 'Feature',
        id: toFeatureRowId(idValue, index),
        properties,
        geometry: parseGeoPackageGeometry(row.__geom__),
        sourceRef
      }

      const outputFeature = this.transformFeature
        ? await this.transformFeature(sourceFeature, index)
        : sourceFeature

      yield {
        ...outputFeature,
        sourceRef
      }
    }
  }
}

async function openGeoPackageDatabase(path: PathLike): Promise<SqliteDatabase> {
  if (typeof path !== 'string') {
    throw new Error('GeoPackage source requires a string file path')
  }

  let module: { DatabaseSync: new (location: string, options?: Record<string, unknown>) => SqliteDatabase }

  try {
    module = await import('node:sqlite') as {
      DatabaseSync: new (location: string, options?: Record<string, unknown>) => SqliteDatabase
    }
  } catch {
    throw new Error('GeoPackage source requires Node.js with built-in node:sqlite support (Node.js 22.5+).')
  }

  return new module.DatabaseSync(path, { readOnly: true })
}

function resolveTableMeta(
  db: SqliteDatabase,
  options: Pick<GeoPackageGeoSourceOptions, 'tableName' | 'geometryColumn' | 'primaryKey'>
): GeoPackageTableMeta {
  let sql = [
    'SELECT',
    'gc.table_name AS table_name,',
    'gc.column_name AS geometry_column,',
    'gc.srs_id AS srs_id,',
    'c.min_x AS min_x,',
    'c.min_y AS min_y,',
    'c.max_x AS max_x,',
    'c.max_y AS max_y',
    'FROM gpkg_geometry_columns gc',
    'JOIN gpkg_contents c ON c.table_name = gc.table_name',
    "WHERE c.data_type = 'features'"
  ].join(' ')

  if (options.tableName) {
    sql += ` AND gc.table_name = ${quoteSqlString(options.tableName)}`
  }

  if (options.geometryColumn) {
    sql += ` AND gc.column_name = ${quoteSqlString(options.geometryColumn)}`
  }

  sql += ' ORDER BY gc.table_name, gc.column_name'

  const rows = db.prepare(sql).all()

  if (rows.length === 0) {
    throw new Error('Invalid GeoPackage: no feature geometry table found for the requested options')
  }

  if (rows.length > 1 && !options.tableName) {
    throw new Error('GeoPackage contains multiple feature tables; specify tableName explicitly')
  }

  const selected = rows[0]
  const tableName = String(selected.table_name)
  const geometryColumn = String(selected.geometry_column)
  const srsId = toOptionalNumber(selected.srs_id)
  const tableInfo = db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`).all()
  const tableColumns = tableInfo
    .map((column) => String(column.name))
    .filter(Boolean)
  const schemaPrimaryKey = tableInfo.find((column) => Number(column.pk ?? 0) > 0)?.name
  const primaryKey = options.primaryKey
    ?? (typeof schemaPrimaryKey === 'string' ? schemaPrimaryKey : undefined)
    ?? 'rowid'

  if (primaryKey !== 'rowid' && !tableColumns.includes(primaryKey)) {
    throw new Error(`Invalid GeoPackage: primary key column "${primaryKey}" not found in table "${tableName}"`)
  }

  if (!tableColumns.includes(geometryColumn)) {
    throw new Error(`Invalid GeoPackage: geometry column "${geometryColumn}" not found in table "${tableName}"`)
  }

  return {
    tableName,
    geometryColumn,
    primaryKey,
    propertyColumns: tableColumns.filter((column) => column !== geometryColumn),
    extent: toOptionalBBox(selected.min_x, selected.min_y, selected.max_x, selected.max_y),
    srsId
  }
}

function parseGeoPackageGeometry(value: unknown): GeoGeometry | null {
  const buffer = toBuffer(value)
  if (!buffer) return null
  if (buffer.length < 8) {
    throw new Error('Invalid GeoPackage geometry: header is too short')
  }

  if (buffer[0] !== 0x47 || buffer[1] !== 0x50) {
    throw new Error('Invalid GeoPackage geometry: missing GP magic bytes')
  }

  const flags = buffer[3]
  const empty = (flags & 0b00010000) !== 0
  const envelopeCode = (flags >> 1) & 0b00000111
  const envelopeSize = getEnvelopeByteLength(envelopeCode)
  const wkbOffset = 8 + envelopeSize

  if (buffer.length < wkbOffset) {
    throw new Error('Invalid GeoPackage geometry: envelope exceeds buffer length')
  }

  if (empty) return null

  const wkb = buffer.subarray(wkbOffset)
  if (wkb.length === 0) {
    throw new Error('Invalid GeoPackage geometry: missing WKB body')
  }

  const reader = new WkbReader(wkb)
  const geometry = reader.readGeometry()

  if (!reader.eof) {
    throw new Error('Invalid GeoPackage geometry: trailing bytes after WKB body')
  }

  return geometry
}

class WkbReader {
  private readonly view: DataView
  private offset = 0

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  get eof(): boolean {
    return this.offset === this.buffer.length
  }

  readGeometry(): GeoGeometry | null {
    const littleEndian = this.readUInt8() === 1
    const rawType = this.readUInt32(littleEndian)
    const decoded = decodeWkbType(rawType)

    if (decoded.hasSrid) {
      this.readUInt32(littleEndian)
    }

    switch (decoded.baseType) {
      case 0:
        return null

      case 1:
        return this.readPoint(decoded.dimensions, littleEndian)

      case 2:
        return this.readLineString(decoded.dimensions, littleEndian)

      case 3:
        return this.readPolygon(decoded.dimensions, littleEndian)

      case 4:
        return this.readMultiPoint(decoded.dimensions, littleEndian)

      case 5:
        return this.readMultiLineString(decoded.dimensions, littleEndian)

      case 6:
        return this.readMultiPolygon(decoded.dimensions, littleEndian)

      case 7:
        return this.readGeometryCollection(littleEndian)

      default:
        throw new Error(`Unsupported WKB geometry type: ${rawType}`)
    }
  }

  private readPoint(dimension: number, littleEndian: boolean): GeoGeometry | null {
    const position = this.readPosition(dimension, littleEndian)
    if (Number.isNaN(position[0]) || Number.isNaN(position[1])) return null

    return {
      type: 'Point',
      coordinates: position
    }
  }

  private readLineString(dimension: number, littleEndian: boolean): GeoGeometry {
    const count = this.readUInt32(littleEndian)
    const coordinates: GeoPosition[] = []

    for (let index = 0; index < count; index += 1) {
      coordinates.push(this.readPosition(dimension, littleEndian))
    }

    return {
      type: 'LineString',
      coordinates
    }
  }

  private readPolygon(dimension: number, littleEndian: boolean): GeoGeometry {
    const ringCount = this.readUInt32(littleEndian)
    const coordinates: GeoPosition[][] = []

    for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
      const pointCount = this.readUInt32(littleEndian)
      const ring: GeoPosition[] = []

      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        ring.push(this.readPosition(dimension, littleEndian))
      }

      coordinates.push(ring)
    }

    return {
      type: 'Polygon',
      coordinates
    }
  }

  private readMultiPoint(dimension: number, littleEndian: boolean): GeoGeometry | null {
    const count = this.readUInt32(littleEndian)
    const coordinates: GeoPosition[] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (!geometry) continue

      if (geometry.type !== 'Point') {
        throw new Error('Invalid WKB MultiPoint: expected Point members')
      }

      const position = geometry.coordinates
      if (position.length < dimension) {
        // Keep parsing defensive for mixed-dimension payloads.
        coordinates.push([...position] as GeoPosition)
      } else {
        coordinates.push(position)
      }
    }

    return coordinates.length === 0
      ? null
      : {
        type: 'MultiPoint',
        coordinates
      }
  }

  private readMultiLineString(_: number, littleEndian: boolean): GeoGeometry | null {
    const count = this.readUInt32(littleEndian)
    const coordinates: GeoPosition[][] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (!geometry) continue

      if (geometry.type !== 'LineString') {
        throw new Error('Invalid WKB MultiLineString: expected LineString members')
      }

      coordinates.push(geometry.coordinates)
    }

    if (coordinates.length === 0) return null

    return {
      type: 'MultiLineString',
      coordinates
    }
  }

  private readMultiPolygon(_: number, littleEndian: boolean): GeoGeometry | null {
    const count = this.readUInt32(littleEndian)
    const coordinates: GeoPosition[][][] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (!geometry) continue

      if (geometry.type !== 'Polygon') {
        throw new Error('Invalid WKB MultiPolygon: expected Polygon members')
      }

      coordinates.push(geometry.coordinates)
    }

    if (coordinates.length === 0) return null

    return {
      type: 'MultiPolygon',
      coordinates
    }
  }

  private readGeometryCollection(littleEndian: boolean): GeoGeometry | null {
    const count = this.readUInt32(littleEndian)
    const geometries: GeoGeometry[] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (geometry) geometries.push(geometry)
    }

    if (geometries.length === 0) return null

    if (geometries.every((geometry) => geometry.type === 'Point')) {
      return {
        type: 'MultiPoint',
        coordinates: geometries.map((geometry) => (geometry as { type: 'Point', coordinates: GeoPosition }).coordinates)
      }
    }

    if (geometries.every((geometry) => geometry.type === 'LineString')) {
      return {
        type: 'MultiLineString',
        coordinates: geometries.map((geometry) => (geometry as { type: 'LineString', coordinates: GeoPosition[] }).coordinates)
      }
    }

    if (geometries.every((geometry) => geometry.type === 'Polygon')) {
      return {
        type: 'MultiPolygon',
        coordinates: geometries.map((geometry) => (geometry as { type: 'Polygon', coordinates: GeoPosition[][] }).coordinates)
      }
    }

    return null
  }

  private readPosition(dimension: number, littleEndian: boolean): GeoPosition {
    const values: number[] = []

    for (let index = 0; index < dimension; index += 1) {
      values.push(this.readFloat64(littleEndian))
    }

    return values as GeoPosition
  }

  private readUInt8(): number {
    if (this.offset + 1 > this.view.byteLength) {
      throw new Error('Invalid WKB: unexpected end of input')
    }

    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  private readUInt32(littleEndian: boolean): number {
    if (this.offset + 4 > this.view.byteLength) {
      throw new Error('Invalid WKB: unexpected end of input')
    }

    const value = this.view.getUint32(this.offset, littleEndian)
    this.offset += 4
    return value
  }

  private readFloat64(littleEndian: boolean): number {
    if (this.offset + 8 > this.view.byteLength) {
      throw new Error('Invalid WKB: unexpected end of input')
    }

    const value = this.view.getFloat64(this.offset, littleEndian)
    this.offset += 8
    return value
  }
}

function decodeWkbType(rawType: number): {
  baseType: number
  dimensions: number
  hasSrid: boolean
} {
  let type = rawType
  let hasZ = false
  let hasM = false
  let hasSrid = false

  if ((type & 0x80000000) !== 0) {
    hasZ = true
    type &= 0x7fffffff
  }

  if ((type & 0x40000000) !== 0) {
    hasM = true
    type &= 0xbfffffff
  }

  if ((type & 0x20000000) !== 0) {
    hasSrid = true
    type &= 0xdfffffff
  }

  if (type >= 3000) {
    type -= 3000
    hasZ = true
    hasM = true
  } else if (type >= 2000) {
    type -= 2000
    hasM = true
  } else if (type >= 1000) {
    type -= 1000
    hasZ = true
  }

  return {
    baseType: type,
    dimensions: 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0),
    hasSrid
  }
}

function getEnvelopeByteLength(code: number): number {
  switch (code) {
    case 0:
      return 0

    case 1:
      return 32

    case 2:
    case 3:
      return 48

    case 4:
      return 64

    default:
      throw new Error(`Invalid GeoPackage geometry envelope code: ${code}`)
  }
}

function toBuffer(value: unknown): Uint8Array | null {
  if (!value) return null

  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }

  return null
}

function toOptionalBBox(minX: unknown, minY: unknown, maxX: unknown, maxY: unknown): BBox | null {
  const values = [minX, minY, maxX, maxY].map((value) => toOptionalNumber(value))

  if (values.some((value) => value === null)) {
    return null
  }

  return [values[0] as number, values[1] as number, values[2] as number, values[3] as number]
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : null
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function toFeatureRowId(value: unknown, fallback: number): string | number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') {
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)
      ? value.toString()
      : Number(value)
  }

  return fallback
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function normalizePropertyValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)
      ? value.toString()
      : Number(value)
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64')
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('base64')
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
  }

  return value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw getAbortReason(signal)
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('GeoPackage stream aborted')
}

export function crsFromSrsId(srsId: number | null): CrsCode | null {
  return Number.isInteger(srsId) ? `${GPKG_CRS_PREFIX}${srsId}` : null
}
