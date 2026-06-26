import sql from 'mssql'
import type { BBox, CrsCode, Geometry } from '../core/geometry.js'
import type { DbRef, DescInfo, Feature, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { Gt } from '../core/geotools.js'
import { type Props, type Registry } from '../core/tools.js'
import { DbSource, hasSourceConfigType, toStream, type FeatureTransform, type QueryOptions } from './source.js'
import type { StreamOptions } from './source.js'
import { DbDataset, type DbDatasetJson } from './db-dataset.js'
import { AbortSignalGuard } from './source-utils.js'
import { WkbReader } from './wkb-reader.js'

export type MssqlExtentStrategy = 'exact' | 'none'

export type MssqlConnectionObjectOptions = {
  connectionString?: string
  server?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  poolMin?: number
  poolMax?: number
  connectionTimeoutMillis?: number
  requestTimeoutMillis?: number
  encrypt?: boolean
  trustServerCertificate?: boolean
}

export type MssqlConnectionOptions = string | MssqlConnectionObjectOptions

export type MssqlSourceOptions = DescInfo & {
  connection: MssqlConnectionOptions
  schema?: string
  datasets: Record<string, DbDatasetJson>
  batchSize?: number
  extentStrategy?: MssqlExtentStrategy
  transformFeature?: FeatureTransform
}

export type MssqlSourceJson = DescInfo & {
  type: 'mssql'
  connection: MssqlConnectionOptions
  schema?: string
  datasets: Record<string, DbDatasetJson>
  batchSize?: number
  extentStrategy?: MssqlExtentStrategy
}

type MssqlTableOptions = {
  schema: string
  tableName: string
  geometryColumn?: string
  primaryKey?: string
  srid?: number
  properties?: string[]
}

type MssqlColumnMeta = {
  columnName: string
  dataType: string
}

type MssqlTableMeta = {
  schemaName: string
  tableName: string
  geometryColumn: string
  primaryKey: string
  propertyColumns: string[]
  srid: number | null
  spatialType: 'geometry' | 'geography'
}

type MssqlQuery = {
  sqlText: string
  inputs: MssqlInputs
  properties: Array<{ column: string, alias: string }>
}

type MssqlInputs = Record<string, unknown>

const DEFAULT_SCHEMA = 'dbo'
const DEFAULT_BATCH_SIZE = 500
const DEFAULT_EXTENT_STRATEGY: MssqlExtentStrategy = 'exact'
const DEFAULT_URL_ENCRYPT = false
const DEFAULT_URL_TRUST_SERVER_CERTIFICATE = true

export class MssqlSource extends DbSource {
  readonly type = 'mssql'

  private readonly reader: MssqlReader
  private opened = false
  private opening: Promise<void> | null = null

  static acceptsConfig(entry: unknown): entry is MssqlSourceJson {
    return hasSourceConfigType(entry, 'mssql')
  }

  static fromConfig(
    id: string,
    entry: MssqlSourceJson
  ): MssqlSource {
    return new MssqlSource(id, {
      title: entry.title,
      abstract: entry.abstract,
      connection: entry.connection,
      schema: entry.schema,
      datasets: entry.datasets,
      batchSize: entry.batchSize,
      extentStrategy: entry.extentStrategy
    })
  }

  constructor(
    id: string,
    options: MssqlSourceOptions
  ) {
    super(id, options, options.transformFeature)

    this.reader = new MssqlReader(this.id, {
      connection: options.connection,
      schema: options.schema ?? DEFAULT_SCHEMA,
      datasets: DbDataset.build(`MSSQL source "${this.id}"`, options.datasets),
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      extentStrategy: options.extentStrategy ?? DEFAULT_EXTENT_STRATEGY
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

  override async getExtent(layer: Layer): Promise<BBox | null> {
    await this.open()
    return this.reader.getExtent(this.resolveDatasetId(layer))
  }

  override query(options: QueryOptions): ReadableStream<Feature> {
    return toStream(this.queryFeatures(options), options, (signal) => this.abortReason(signal))
  }

  override async readById(featureId: string, options: StreamOptions): Promise<Feature | null> {
    await this.open()
    return this.reader.readById(featureId, this.resolveDatasetId(options.layer), options)
  }

  protected override async readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    await this.open()
    return this.reader.read(sourceRef, this.resolveDatasetId(options.layer), options)
  }

  protected override async *streamFeatures(options: StreamOptions): AsyncGenerator<Feature> {
    await this.open()
    yield* this.reader.stream(this.resolveDatasetId(options.layer), options)
  }

  protected override abortReason(signal: AbortSignal): unknown {
    return AbortSignalGuard.reason(signal, 'MSSQL stream aborted')
  }

  private async *queryFeatures(options: QueryOptions): AsyncGenerator<Feature> {
    await this.open()
    yield* this.mapFeatures(this.reader.query(this.resolveDatasetId(options.layer), options), options)
  }
}

class MssqlReader {
  private pool: sql.ConnectionPool | null = null
  private readonly metas = new Map<string, MssqlTableMeta>()

  constructor(
    private readonly sourceId: string,
    private readonly options: {
      connection: MssqlConnectionOptions
      schema: string
      datasets: Registry<DbDataset>
      batchSize: number
      extentStrategy: MssqlExtentStrategy
    }
  ) {}

  async open(): Promise<void> {
    const pool = new sql.ConnectionPool(createPoolConfig(this.options.connection))
    this.pool = pool

    try {
      await pool.connect()
      await pool.request().query('SELECT 1')
      for (const dataset of this.options.datasets.all) {
        this.metas.set(dataset.id, await resolveTableMeta(pool, this.tableOptions(dataset)))
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    const pool = this.pool
    this.pool = null
    this.metas.clear()
    if (pool) await pool.close()
  }

  async getExtent(datasetId: string): Promise<BBox | null> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)

    switch (this.options.extentStrategy) {
      case 'none':
        return null

      case 'exact':
        return this.queryExactExtent(state.pool, meta)
    }
  }

  async *stream(datasetId: string, options: StreamOptions): AsyncGenerator<Feature> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)
    const query = this.selectSql(meta, {})
    yield* this.featuresFromQuery({ pool: state.pool, meta }, query, options)
  }

  async *query(datasetId: string, options: QueryOptions): AsyncGenerator<Feature> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)
    const query = this.selectSql(meta, {
      bbox: options.bbox,
      properties: options.properties,
      crs: options.layer.crs,
      limit: options.limit,
      offset: options.offset
    })
    yield* this.featuresFromQuery({ pool: state.pool, meta }, query, options)
  }

  async read(sourceRef: SourceRef, datasetId: string, options: StreamOptions): Promise<Feature | null> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)
    const ref = this.toDbRef(sourceRef, meta)
    const query = this.selectOneSql(meta, ref)
    const rows = await this.executeRows(state.pool, query.sqlText, query.inputs)
    const row = rows[0]
    if (!row) return null
    return this.toFeature(meta, query.properties, row, ref.recordIndex ?? 0, options.layer)
  }

  async readById(featureId: string, datasetId: string, options: StreamOptions): Promise<Feature | null> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)
    const query = this.selectOneSql(meta, {
      storage: 'database',
      sourceId: this.sourceId,
      schemaName: meta.schemaName,
      tableName: meta.tableName,
      rowId: featureId,
      primaryKey: meta.primaryKey,
      geometryColumn: meta.geometryColumn
    })
    const rows = await this.executeRows(state.pool, query.sqlText, query.inputs)
    const row = rows[0]
    if (!row) return null
    return this.toFeature(meta, query.properties, row, 0, options.layer)
  }

  private requireOpen(): { pool: sql.ConnectionPool } {
    if (!this.pool) {
      throw new Error('MSSQL source is not opened')
    }

    return { pool: this.pool }
  }

  private metaForDataset(datasetId: string): MssqlTableMeta {
    this.options.datasets.get(datasetId)
    const meta = this.metas.get(datasetId)

    if (!meta) {
      throw new Error(`MSSQL source "${this.sourceId}" dataset "${datasetId}" is not opened`)
    }

    return meta
  }

  private tableOptions(dataset: DbDataset): MssqlTableOptions {
    return {
      schema: dataset.schema ?? this.options.schema,
      tableName: dataset.tableName,
      geometryColumn: dataset.geometryColumn,
      primaryKey: dataset.primaryKey,
      srid: dataset.srid,
      properties: dataset.properties
    }
  }

  private async *featuresFromQuery(
    state: { pool: sql.ConnectionPool, meta: MssqlTableMeta },
    query: MssqlQuery,
    options: StreamOptions
  ): AsyncGenerator<Feature> {
    let recordIndex = 0
    let offset = toNonNegativeInteger(query.inputs.__offset__, 0)
    const limit = query.inputs.__limit__ === undefined
      ? undefined
      : toNonNegativeInteger(query.inputs.__limit__, 0)

    while (limit === undefined || recordIndex < limit) {
      AbortSignalGuard.throwIfAborted(options.signal, 'MSSQL stream aborted')
      const batchLimit = Math.min(this.options.batchSize, limit === undefined ? this.options.batchSize : limit - recordIndex)
      const rows = await this.executeRows(state.pool, pagedSql(query.sqlText), {
        ...query.inputs,
        __offset__: offset,
        __fetch__: batchLimit
      })

      if (rows.length === 0) return

      for (const row of rows) {
        AbortSignalGuard.throwIfAborted(options.signal, 'MSSQL stream aborted')
        yield this.toFeature(state.meta, query.properties, row, recordIndex, options.layer)
        recordIndex += 1
        offset += 1
      }
    }
  }

  private async executeRows(
    pool: sql.ConnectionPool,
    sqlText: string,
    inputs: MssqlInputs = {}
  ): Promise<Props[]> {
    const request = pool.request()

    for (const [name, value] of Object.entries(inputs)) {
      request.input(name, value)
    }

    const result = await request.query(sqlText)
    return result.recordset ?? []
  }

  private toFeature(
    meta: MssqlTableMeta,
    properties: Array<{ column: string, alias: string }>,
    row: Props,
    index: number,
    layer: Layer
  ): Feature {
    const idValue = row.__id__
    const rowId = toFeatureRowId(idValue, index)
    const sourceRef: SourceRef = {
      storage: 'database',
      sourceId: this.sourceId,
      schemaName: meta.schemaName,
      tableName: meta.tableName,
      rowId,
      primaryKey: meta.primaryKey,
      geometryColumn: meta.geometryColumn,
      recordIndex: index
    }
    const featureProperties: Props = {}

    for (const { column, alias } of properties) {
      featureProperties[column] = normalizePropertyValue(row[alias])
    }

    return {
      layer,
      type: 'Feature',
      id: rowId,
      properties: featureProperties,
      geometry: parseMssqlGeometry(row.__geom__),
      sourceRef
    }
  }

  private selectSql(
    meta: MssqlTableMeta,
    options: { bbox?: BBox, properties?: string[], crs?: CrsCode, limit?: number, offset?: number }
  ): MssqlQuery {
    const inputs: MssqlInputs = {}
    const where: string[] = []

    if (options.bbox) {
      inputs.bboxWkt = bboxPolygonWkt(options.bbox)
      inputs.bboxSrid = (options.crs ? sridFromCrs(options.crs) : null) ?? meta.srid ?? 0
      const geom = quoteSqlIdentifier(meta.geometryColumn)
      where.push(`${geom} IS NOT NULL`)
      where.push(`${geom}.STIntersects(${meta.spatialType}::STGeomFromText(@bboxWkt, @bboxSrid)) = 1`)
    }

    if (options.limit !== undefined) inputs.__limit__ = options.limit
    if (options.offset !== undefined) inputs.__offset__ = options.offset

    const properties = this.propertyAliases(meta, options.properties)
    const sqlText = [
      `SELECT ${this.selectColumns(meta, properties).join(', ')}`,
      `FROM ${qualifiedTableName(meta)}`,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      `ORDER BY ${quoteSqlIdentifier(meta.primaryKey)}`
    ].filter(Boolean).join(' ')

    return { sqlText, inputs, properties }
  }

  private selectOneSql(meta: MssqlTableMeta, sourceRef: DbRef): MssqlQuery {
    const properties = this.propertyAliases(meta)
    const sqlText = [
      `SELECT ${this.selectColumns(meta, properties).join(', ')}`,
      `FROM ${qualifiedTableName(meta)}`,
      `WHERE ${quoteSqlIdentifier(meta.primaryKey)} = @featureKey`
    ].join(' ')

    return {
      sqlText,
      inputs: { featureKey: sourceRef.rowId },
      properties
    }
  }

  private selectColumns(meta: MssqlTableMeta, properties: Array<{ column: string, alias: string }>): string[] {
    return [
      `${quoteSqlIdentifier(meta.primaryKey)} AS ${quoteSqlIdentifier('__id__')}`,
      `${quoteSqlIdentifier(meta.geometryColumn)}.STAsBinary() AS ${quoteSqlIdentifier('__geom__')}`,
      ...properties.map(({ column, alias }) =>
        `${quoteSqlIdentifier(column)} AS ${quoteSqlIdentifier(alias)}`
      )
    ]
  }

  private propertyAliases(meta: MssqlTableMeta, requested?: string[]): Array<{ column: string, alias: string }> {
    const columns = requested
      ? requested.map((column) => requireKnownColumn(column, meta.propertyColumns, 'property column'))
      : meta.propertyColumns

    return columns.map((column, index) => ({
      column,
      alias: `p_${index}`
    }))
  }

  private async queryExactExtent(pool: sql.ConnectionPool, meta: MssqlTableMeta): Promise<BBox | null> {
    const sqlText = [
      `SELECT ${meta.spatialType}::EnvelopeAggregate(${quoteSqlIdentifier(meta.geometryColumn)}).STAsBinary() AS ${quoteSqlIdentifier('__extent__')}`,
      `FROM ${qualifiedTableName(meta)}`,
      `WHERE ${quoteSqlIdentifier(meta.geometryColumn)} IS NOT NULL`
    ].join(' ')
    const row = (await this.executeRows(pool, sqlText))[0]
    const geometry = parseMssqlGeometry(row?.__extent__)

    return geometry ? Gt.bbox(geometry) : null
  }

  private toDbRef(sourceRef: SourceRef, meta: MssqlTableMeta): DbRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.sourceId) {
      throw new Error(`MSSQL sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (sourceRef.storage !== 'database') {
      throw new Error('MSSQL sourceRef must use database storage')
    }

    if (sourceRef.schemaName !== undefined && sourceRef.schemaName !== meta.schemaName) {
      throw new Error(`MSSQL sourceRef targets schema "${sourceRef.schemaName}", expected "${meta.schemaName}"`)
    }

    if (sourceRef.tableName !== meta.tableName) {
      throw new Error(`MSSQL sourceRef targets table "${sourceRef.tableName}", expected "${meta.tableName}"`)
    }

    return sourceRef as DbRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }
}

async function resolveTableMeta(
  pool: sql.ConnectionPool,
  options: MssqlTableOptions
): Promise<MssqlTableMeta> {
  const schemaName = requireNonEmptyString(options.schema, 'MSSQL schema')
  const tableName = requireNonEmptyString(options.tableName, 'MSSQL tableName')
  const columns = await readColumns(pool, schemaName, tableName)

  if (columns.length === 0) {
    throw new Error(`Invalid MSSQL source: table "${schemaName}.${tableName}" was not found`)
  }

  const geometry = await resolveGeometryColumn({
    schemaName,
    tableName,
    configuredColumn: options.geometryColumn,
    tableColumns: columns
  })
  const primaryKey = await resolvePrimaryKey(pool, {
    schemaName,
    tableName,
    configuredPrimaryKey: options.primaryKey,
    tableColumns: columns.map((column) => column.columnName)
  })
  const propertyColumns = resolvePropertyColumns({
    configuredProperties: options.properties,
    tableColumns: columns.map((column) => column.columnName),
    geometryColumn: geometry.columnName
  })
  const srid = options.srid ?? await readSrid(pool, schemaName, tableName, geometry.columnName)

  return {
    schemaName,
    tableName,
    geometryColumn: geometry.columnName,
    primaryKey,
    propertyColumns,
    srid,
    spatialType: geometry.dataType
  }
}

async function readColumns(pool: sql.ConnectionPool, schemaName: string, tableName: string): Promise<MssqlColumnMeta[]> {
  const result = await pool.request()
    .input('schemaName', schemaName)
    .input('tableName', tableName)
    .query([
      'SELECT c.name AS columnName, t.name AS dataType',
      'FROM sys.columns c',
      'JOIN sys.tables tb ON tb.object_id = c.object_id',
      'JOIN sys.schemas s ON s.schema_id = tb.schema_id',
      'JOIN sys.types t ON t.user_type_id = c.user_type_id',
      'WHERE s.name = @schemaName AND tb.name = @tableName',
      'ORDER BY c.column_id'
    ].join(' '))

  return (result.recordset ?? []).map((row) => ({
    columnName: String(row.columnName),
    dataType: String(row.dataType).toLowerCase()
  }))
}

async function resolveGeometryColumn(options: {
  schemaName: string
  tableName: string
  configuredColumn?: string
  tableColumns: MssqlColumnMeta[]
}): Promise<{ columnName: string, dataType: 'geometry' | 'geography' }> {
  if (options.configuredColumn) {
    const columnName = requireKnownColumn(options.configuredColumn, options.tableColumns.map((column) => column.columnName), 'geometry column')
    const column = options.tableColumns.find((entry) => entry.columnName === columnName)
    if (column?.dataType !== 'geometry' && column?.dataType !== 'geography') {
      throw new Error(`Invalid MSSQL source: column "${columnName}" is not a geometry/geography column for table "${options.schemaName}.${options.tableName}"`)
    }
    return { columnName, dataType: column.dataType }
  }

  const spatialColumns = options.tableColumns.filter((column) =>
    column.dataType === 'geometry' || column.dataType === 'geography'
  )

  if (spatialColumns.length === 0) {
    throw new Error(`Invalid MSSQL source: no geometry column found for table "${options.schemaName}.${options.tableName}"; specify geometryColumn`)
  }

  if (spatialColumns.length > 1) {
    throw new Error(`MSSQL table "${options.schemaName}.${options.tableName}" has multiple geometry columns; specify geometryColumn`)
  }

  const column = spatialColumns[0]
  return { columnName: column.columnName, dataType: column.dataType as 'geometry' | 'geography' }
}

async function resolvePrimaryKey(
  pool: sql.ConnectionPool,
  options: {
    schemaName: string
    tableName: string
    configuredPrimaryKey?: string
    tableColumns: string[]
  }
): Promise<string> {
  if (options.configuredPrimaryKey) {
    return requireKnownColumn(options.configuredPrimaryKey, options.tableColumns, 'primary key')
  }

  const result = await pool.request()
    .input('schemaName', options.schemaName)
    .input('tableName', options.tableName)
    .query([
      'SELECT c.name AS columnName',
      'FROM sys.indexes i',
      'JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id',
      'JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id',
      'JOIN sys.tables tb ON tb.object_id = i.object_id',
      'JOIN sys.schemas s ON s.schema_id = tb.schema_id',
      'WHERE i.is_primary_key = 1 AND s.name = @schemaName AND tb.name = @tableName',
      'ORDER BY ic.key_ordinal'
    ].join(' '))
  const rows = result.recordset ?? []

  if (rows.length === 0) {
    throw new Error(`MSSQL table "${options.schemaName}.${options.tableName}" has no primary key; specify primaryKey`)
  }

  if (rows.length > 1) {
    throw new Error(`MSSQL table "${options.schemaName}.${options.tableName}" uses a composite primary key; configure a single stable primaryKey column`)
  }

  return requireKnownColumn(String(rows[0].columnName), options.tableColumns, 'primary key')
}

function resolvePropertyColumns(options: {
  configuredProperties?: string[]
  tableColumns: string[]
  geometryColumn: string
}): string[] {
  const columns = options.configuredProperties
    ?? options.tableColumns.filter((column) => column !== options.geometryColumn)

  return columns.map((column) => requireKnownColumn(column, options.tableColumns, 'property column'))
}

async function readSrid(
  pool: sql.ConnectionPool,
  schemaName: string,
  tableName: string,
  geometryColumn: string
): Promise<number | null> {
  const result = await pool.request()
    .input('schemaName', schemaName)
    .input('tableName', tableName)
    .input('geometryColumn', geometryColumn)
    .query([
      `SELECT TOP (1) ${quoteSqlIdentifier(geometryColumn)}.STSrid AS srid`,
      `FROM ${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(tableName)}`,
      `WHERE ${quoteSqlIdentifier(geometryColumn)} IS NOT NULL`
    ].join(' '))
  const srid = toOptionalNumber(result.recordset?.[0]?.srid)

  return srid && srid > 0 ? srid : null
}

function createPoolConfig(options: MssqlConnectionOptions): sql.config {
  if (typeof options === 'string') {
    return parseMssqlConnectionString(options)
  }

  if (options.connectionString !== undefined) {
    const parsed = parseMssqlConnectionString(options.connectionString)

    return {
      ...parsed,
      connectionTimeout: options.connectionTimeoutMillis,
      requestTimeout: options.requestTimeoutMillis,
      pool: {
        min: options.poolMin,
        max: options.poolMax
      },
      options: {
        encrypt: options.encrypt ?? parsed.options?.encrypt,
        trustServerCertificate: options.trustServerCertificate ?? parsed.options?.trustServerCertificate
      }
    }
  }

  return {
    server: options.server ?? options.host ?? 'localhost',
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    connectionTimeout: options.connectionTimeoutMillis,
    requestTimeout: options.requestTimeoutMillis,
    pool: {
      min: options.poolMin,
      max: options.poolMax
    },
    options: {
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate
    }
  }
}

function parseMssqlConnectionString(connectionString: string): sql.config {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw invalidMssqlConnectionString()
  }

  if (
    url.protocol !== 'mssql:'
    || url.username === ''
    || url.password === ''
    || url.hostname === ''
    || url.port === ''
    || url.pathname === ''
    || url.pathname === '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw invalidMssqlConnectionString()
  }

  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidMssqlConnectionString()
  }

  return {
    server: url.hostname,
    port,
    database: decodeMssqlUrlPart(url.pathname.slice(1)),
    user: decodeMssqlUrlPart(url.username),
    password: decodeMssqlUrlPart(url.password),
    options: {
      encrypt: DEFAULT_URL_ENCRYPT,
      trustServerCertificate: DEFAULT_URL_TRUST_SERVER_CERTIFICATE
    }
  }
}

function decodeMssqlUrlPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw invalidMssqlConnectionString()
  }
}

function invalidMssqlConnectionString(): Error {
  return new Error('Invalid MSSQL GeoComposer connection string: expected "mssql://user:password@host:port/database"')
}

function pagedSql(baseSql: string): string {
  return `${baseSql} OFFSET @__offset__ ROWS FETCH NEXT @__fetch__ ROWS ONLY`
}

function bboxPolygonWkt(bbox: BBox): string {
  const [minX, minY, maxX, maxY] = bbox
  return `POLYGON((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`
}

function parseMssqlGeometry(value: unknown): Geometry | null {
  const buffer = toBuffer(value)
  if (!buffer) return null

  const reader = new WkbReader(buffer)
  const geometry = reader.readGeometry()

  if (!reader.eof) {
    throw new Error('Invalid MSSQL geometry: trailing bytes after WKB body')
  }

  return geometry
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

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const number = toOptionalNumber(value)
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : fallback
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

function requireNonEmptyString(value: string, label: string): string {
  if (value.trim() === '') {
    throw new Error(`${label} must not be empty`)
  }

  return value
}

function requireKnownColumn(column: string, columns: string[], label: string): string {
  const normalized = requireNonEmptyString(column, `MSSQL ${label}`)
  if (!columns.includes(normalized)) {
    throw new Error(`Invalid MSSQL source: ${label} "${normalized}" was not found`)
  }

  return normalized
}

function qualifiedTableName(meta: Pick<MssqlTableMeta, 'schemaName' | 'tableName'>): string {
  return `${quoteSqlIdentifier(meta.schemaName)}.${quoteSqlIdentifier(meta.tableName)}`
}

function quoteSqlIdentifier(identifier: string): string {
  return `[${identifier.replace(/]/g, ']]')}]`
}

function sridFromCrs(crs: CrsCode): number | null {
  const match = crs.match(/^EPSG:(\d+)$/i)
  if (!match) return null

  const srid = Number(match[1])
  return Number.isSafeInteger(srid) && srid > 0 ? srid : null
}
