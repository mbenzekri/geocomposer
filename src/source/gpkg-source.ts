import { constants, type PathLike } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DbRef, DescInfo, Feature, SourceRef} from '../core/feature.js'
import type { Geometry, BBox } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { DbSource, hasSourceConfigType, type FeatureTransform } from './source.js'
import type { StreamOptions } from './source.js'
import { AbortSignalGuard } from './source-utils.js'
import { Props } from '../core/tools.js'
import { WkbReader } from './wkb-reader.js'

export type GpkgSourceOptions = {
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
  transformFeature?: FeatureTransform
}

export type GpkgSourceJson = DescInfo & {
  type: 'gpkg'
  path: string
  tableName?: string
  geometryColumn?: string
  primaryKey?: string
}

type SqliteDatabase = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Props | undefined
    all: (...params: unknown[]) => Props[]
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

export class GpkgSource extends DbSource {
  readonly type = 'geopackage'

  private readonly reader: GpkgReader
  private opened = false
  private opening: Promise<void> | null = null

  static acceptsConfig(entry: unknown): entry is GpkgSourceJson {
    return hasSourceConfigType(entry, 'gpkg')
  }

  static fromConfig(
    id: string,
    entry: GpkgSourceJson,
    baseDir: string
  ): GpkgSource {
    return new GpkgSource(id, resolve(baseDir, entry.path), {
      tableName: entry.tableName,
      geometryColumn: entry.geometryColumn,
      primaryKey: entry.primaryKey
    })
  }

  constructor(
    readonly id: string,
    private readonly filePath: PathLike,
    options: GpkgSourceOptions = {}
  ) {
    super(options.transformFeature)

    this.reader = new GpkgReader(this.id, this.filePath, {
      tableName: options.tableName,
      geometryColumn: options.geometryColumn,
      primaryKey: options.primaryKey
    })
  }

  async open(): Promise<void> {
    if (this.opened) return

    if (!this.opening) {
      this.opening = this.reader.open().then(() => {
        this.opened = true
      })
    }

    try {
      await this.opening
    } finally {
      this.opening = null
    }
  }

  async close(): Promise<void> {
    if (this.opening) {
      await this.opening
    }

    if (!this.opened) return

    await this.reader.close()
    this.opened = false
  }

  protected override async readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    await this.open()
    return this.reader.read(sourceRef, options)
  }

  protected override async *streamFeatures(options: StreamOptions): AsyncGenerator<Feature> {
    await this.open()
    yield* this.reader.stream(options)
  }

  protected override abortReason(signal: AbortSignal): unknown {
    return AbortSignalGuard.reason(signal, 'GeoPackage stream aborted')
  }
}

class GpkgReader {
  private db: SqliteDatabase | null = null
  private meta: GeoPackageTableMeta | null = null

  constructor(
    private readonly sourceId: string,
    private readonly filePath: PathLike,
    private readonly options: Pick<GpkgSourceOptions, 'tableName' | 'geometryColumn' | 'primaryKey'>
  ) {}

  async open(): Promise<void> {
    await access(this.filePath, constants.R_OK)

    this.db = await openGeoPackageDatabase(this.filePath)
    this.meta = resolveTableMeta(this.db, {
      tableName: this.options.tableName,
      geometryColumn: this.options.geometryColumn,
      primaryKey: this.options.primaryKey
    })
  }

  async close(): Promise<void> {
    this.db?.close()
    this.db = null
    this.meta = null
  }

  async *stream(options: StreamOptions): AsyncGenerator<Feature> {
    const state = this.requireOpen()
    const rows = state.db.prepare(this.selectAllSql(state.meta)).all()
    const signal = options.signal

    for (let index = 0; index < rows.length; index += 1) {
      AbortSignalGuard.throwIfAborted(signal, 'GeoPackage stream aborted')
      yield this.toFeature(state.meta, rows[index], index, options.layer)
    }
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const state = this.requireOpen()
    const ref = this.toDbRef(sourceRef, state.meta)
    const row = state.db.prepare(this.selectOneSql(state.meta)).get(ref.rowId)
    if (!row) return null
    return this.toFeature(state.meta, row, ref.recordIndex ?? 0, options.layer)
  }

  private requireOpen(): { db: SqliteDatabase, meta: GeoPackageTableMeta } {
    if (!this.db || !this.meta) {
      throw new Error('GeoPackage source is not opened')
    }

    return {
      db: this.db,
      meta: this.meta
    }
  }

  private toFeature(meta: GeoPackageTableMeta, row: Props, index: number, layer: Layer): Feature {
    const idValue = row.__id__
    const rowId = toFeatureRowId(idValue, index)
    const sourceRef: SourceRef = {
      storage: 'database',
      sourceId: this.sourceId,
      tableName: meta.tableName,
      rowId,
      primaryKey: meta.primaryKey === 'rowid' ? undefined : meta.primaryKey,
      geometryColumn: meta.geometryColumn,
      recordIndex: index
    }
    const properties: Props = {}

    for (const { column, alias } of this.propertyAliases(meta)) {
      properties[column] = normalizePropertyValue(row[alias])
    }

    return {
      layer,
      type: 'Feature',
      id: rowId,
      properties,
      geometry: parseGeoPackageGeometry(row.__geom__),
      sourceRef
    }
  }

  private selectAllSql(meta: GeoPackageTableMeta): string {
    const idExpression = meta.primaryKey === 'rowid'
      ? 'rowid'
      : quoteSqlIdentifier(meta.primaryKey)

    return [
      `SELECT ${this.selectColumns(meta).join(', ')}`,
      `FROM ${quoteSqlIdentifier(meta.tableName)}`,
      `ORDER BY ${idExpression}`
    ].join(' ')
  }

  private selectOneSql(meta: GeoPackageTableMeta): string {
    const idExpression = meta.primaryKey === 'rowid'
      ? 'rowid'
      : quoteSqlIdentifier(meta.primaryKey)

    return [
      `SELECT ${this.selectColumns(meta).join(', ')}`,
      `FROM ${quoteSqlIdentifier(meta.tableName)}`,
      `WHERE ${idExpression} = ?`
    ].join(' ')
  }

  private selectColumns(meta: GeoPackageTableMeta): string[] {
    const idExpression = meta.primaryKey === 'rowid'
      ? 'rowid'
      : quoteSqlIdentifier(meta.primaryKey)

    return [
      `${idExpression} AS ${quoteSqlIdentifier('__id__')}`,
      `${quoteSqlIdentifier(meta.geometryColumn)} AS ${quoteSqlIdentifier('__geom__')}`,
      ...this.propertyAliases(meta).map(({ column, alias }) =>
        `${quoteSqlIdentifier(column)} AS ${quoteSqlIdentifier(alias)}`
      )
    ]
  }

  private propertyAliases(meta: GeoPackageTableMeta): Array<{ column: string, alias: string }> {
    return meta.propertyColumns.map((column, index) => ({
      column,
      alias: `p_${index}`
    }))
  }

  private toDbRef(sourceRef: SourceRef, meta: GeoPackageTableMeta): DbRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.sourceId) {
      throw new Error(`GeoPackage sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (sourceRef.storage !== 'database') {
      throw new Error('GeoPackage sourceRef must use database storage')
    }

    if (sourceRef.tableName !== meta.tableName) {
      throw new Error(`GeoPackage sourceRef targets table "${sourceRef.tableName}", expected "${meta.tableName}"`)
    }

    return sourceRef as DbRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }
}

async function openGeoPackageDatabase(path: PathLike): Promise<SqliteDatabase> {
  if (typeof path !== 'string') {
    throw new Error('GeoPackage source requires a string file path')
  }

  let module: { DatabaseSync: new (location: string, options?: Props) => SqliteDatabase }

  try {
    module = await import('node:sqlite') as {
      DatabaseSync: new (location: string, options?: Props) => SqliteDatabase
    }
  } catch {
    throw new Error('GeoPackage source requires Node.js with built-in node:sqlite support (Node.js 22.5+).')
  }

  return new module.DatabaseSync(path, { readOnly: true })
}

function resolveTableMeta(
  db: SqliteDatabase,
  options: Pick<GpkgSourceOptions, 'tableName' | 'geometryColumn' | 'primaryKey'>
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

function parseGeoPackageGeometry(value: unknown): Geometry | null {
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
