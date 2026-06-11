import pg, { type Pool as PgPool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
import Cursor from 'pg-cursor'
import type { BBox, CrsCode, Geometry } from '../core/geometry.js'
import type { DbRef, Feature, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { DbSource, toStream, type FeatureTransform, type QueryOptions } from './source.js'
import type { StreamOptions } from './source.js'
import { AbortSignalGuard } from './source-utils.js'
import { Props } from '../core/tools.js'
import { WkbReader } from './wkb-reader.js'

export type PostgisExtentStrategy = 'estimated' | 'exact' | 'none'

export type PostgisConnectionOptions = {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
  max?: number
  connectionTimeoutMillis?: number
  idleTimeoutMillis?: number
  statementTimeoutMillis?: number
  queryTimeoutMillis?: number
  applicationName?: string
}

export type PostgisSourceOptions = {
  crs?: CrsCode
  connection: PostgisConnectionOptions
  schema?: string
  tableName: string
  geometryColumn?: string
  primaryKey?: string
  srid?: number
  properties?: string[]
  batchSize?: number
  extentStrategy?: PostgisExtentStrategy
  transformFeature?: FeatureTransform
}

type PostgisTableMeta = {
  schemaName: string
  tableName: string
  geometryColumn: string
  primaryKey: string
  propertyColumns: string[]
  srid: number | null
}

type PostgisQuery = {
  sql: string
  params: unknown[]
  properties: Array<{ column: string, alias: string }>
}

const DEFAULT_SCHEMA = 'public'
const DEFAULT_BATCH_SIZE = 500
const DEFAULT_EXTENT_STRATEGY: PostgisExtentStrategy = 'estimated'
const POSTGIS_CRS_PREFIX = 'EPSG:'

const PgPoolConstructor = pg.Pool

export class PostgisSource extends DbSource {
  readonly type = 'postgis'
  get crs(): CrsCode {
    return this.reader.crs
  }

  private readonly reader: PostgisReader
  private opened = false
  private opening: Promise<void> | null = null

  constructor(
    readonly id: string,
    options: PostgisSourceOptions
  ) {
    super(options.transformFeature)

    this.reader = new PostgisReader(this.id, {
      ...options,
      schema: options.schema ?? DEFAULT_SCHEMA,
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
    return this.reader.getExtent(layer)
  }

  override query(options: QueryOptions): ReadableStream<Feature> {
    return toStream(this.queryFeatures(options), options, (signal) => this.abortReason(signal))
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
    return AbortSignalGuard.reason(signal, 'PostGIS stream aborted')
  }

  private async *queryFeatures(options: QueryOptions): AsyncGenerator<Feature> {
    await this.open()
    yield* this.mapFeatures(this.reader.query(options), options)
  }
}

class PostgisReader {
  private readonly userCrs?: CrsCode
  private resolvedCrs: CrsCode
  private pool: PgPool | null = null
  private meta: PostgisTableMeta | null = null

  constructor(
    private readonly sourceId: string,
    private readonly options: Required<Pick<PostgisSourceOptions, 'connection' | 'schema' | 'tableName' | 'batchSize' | 'extentStrategy'>>
      & Pick<PostgisSourceOptions, 'crs' | 'geometryColumn' | 'primaryKey' | 'srid' | 'properties'>
  ) {
    this.userCrs = options.crs
    this.resolvedCrs = options.crs ?? 'EPSG:4326'
  }

  get crs(): CrsCode {
    return this.resolvedCrs
  }

  async open(): Promise<void> {
    this.pool = new PgPoolConstructor(createPoolConfig(this.options.connection))

    try {
      const client = await this.pool.connect()
      try {
        await client.query('SELECT 1')
        this.meta = await resolveTableMeta(client, this.options)
      } finally {
        client.release()
      }

      if (!this.userCrs) {
        const inferredCrs = crsFromSrid(this.meta.srid)
        if (inferredCrs) {
          this.resolvedCrs = inferredCrs
        }
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    const pool = this.pool
    this.pool = null
    this.meta = null
    if (pool) await pool.end()
  }

  async getExtent(_: Layer): Promise<BBox | null> {
    const state = this.requireOpen()

    switch (this.options.extentStrategy) {
      case 'none':
        return null

      case 'exact':
        return this.queryExtent(state, this.exactExtentSql(state.meta), [])

      case 'estimated':
        return this.queryExtent(state, this.estimatedExtentSql(), [
          state.meta.schemaName,
          state.meta.tableName,
          state.meta.geometryColumn
        ])
    }
  }

  async *stream(options: StreamOptions): AsyncGenerator<Feature> {
    const state = this.requireOpen()
    const query = this.selectSql(state.meta, {})
    yield* this.featuresFromQuery(state, query, options)
  }

  async *query(options: QueryOptions): AsyncGenerator<Feature> {
    const state = this.requireOpen()
    const query = this.selectSql(state.meta, {
      bbox: options.bbox,
      properties: options.properties
    })
    yield* this.featuresFromQuery(state, query, options)
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const state = this.requireOpen()
    const ref = this.toDbRef(sourceRef, state.meta)
    const query = this.selectOneSql(state.meta, ref)
    const result = await state.pool.query(query.sql, query.params)
    const row = result.rows[0]
    if (!row) return null
    return this.toFeature(state.meta, query.properties, row, ref.recordIndex ?? 0, options.layer)
  }

  private requireOpen(): { pool: PgPool, meta: PostgisTableMeta } {
    if (!this.pool || !this.meta) {
      throw new Error('PostGIS source is not opened')
    }

    return {
      pool: this.pool,
      meta: this.meta
    }
  }

  private async *featuresFromQuery(
    state: { pool: PgPool, meta: PostgisTableMeta },
    query: PostgisQuery,
    options: StreamOptions
  ): AsyncGenerator<Feature> {
    let index = 0

    for await (const row of this.queryRows(state.pool, query.sql, query.params, options.signal)) {
      AbortSignalGuard.throwIfAborted(options.signal, 'PostGIS stream aborted')
      yield this.toFeature(state.meta, query.properties, row, index, options.layer)
      index += 1
    }
  }

  private async *queryRows(
    pool: PgPool,
    sql: string,
    params: unknown[],
    signal?: AbortSignal
  ): AsyncGenerator<Props> {
    const client = await pool.connect()
    const cursor = client.query(new Cursor<Props>(sql, params))
    let closed = false

    const closeCursor = async (): Promise<void> => {
      if (closed) return
      closed = true
      await cursor.close().catch(() => undefined)
    }
    const onAbort = () => {
      void closeCursor()
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for (;;) {
        AbortSignalGuard.throwIfAborted(signal, 'PostGIS stream aborted')
        const rows = await cursor.read(this.options.batchSize)
        if (rows.length === 0) return

        for (const row of rows) {
          AbortSignalGuard.throwIfAborted(signal, 'PostGIS stream aborted')
          yield row
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await closeCursor()
      client.release()
    }
  }

  private toFeature(
    meta: PostgisTableMeta,
    properties: Array<{ column: string, alias: string }>,
    row: QueryResultRow,
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
      geometry: parsePostgisGeometry(row.__geom__),
      sourceRef
    }
  }

  private selectSql(
    meta: PostgisTableMeta,
    options: { bbox?: BBox, properties?: string[] }
  ): PostgisQuery {
    const params: unknown[] = []
    const where: string[] = []

    if (options.bbox) {
      params.push(options.bbox[0], options.bbox[1], options.bbox[2], options.bbox[3])
      const envelope = `ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, ${meta.srid ?? 0})`
      const geom = quoteSqlIdentifier(meta.geometryColumn)
      where.push(`${geom} IS NOT NULL`)
      where.push(`ST_Intersects(${geom}, ${envelope})`)
    }

    const idExpression = quoteSqlIdentifier(meta.primaryKey)
    const properties = this.propertyAliases(meta, options.properties)
    const sql = [
      `SELECT ${this.selectColumns(meta, properties).join(', ')}`,
      `FROM ${qualifiedTableName(meta)}`,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      `ORDER BY ${idExpression}`
    ].filter(Boolean).join(' ')

    return { sql, params, properties }
  }

  private selectOneSql(meta: PostgisTableMeta, sourceRef: DbRef): PostgisQuery {
    const properties = this.propertyAliases(meta)
    const idExpression = quoteSqlIdentifier(meta.primaryKey)
    const sql = [
      `SELECT ${this.selectColumns(meta, properties).join(', ')}`,
      `FROM ${qualifiedTableName(meta)}`,
      `WHERE ${idExpression} = $1`
    ].join(' ')

    return {
      sql,
      params: [sourceRef.rowId],
      properties
    }
  }

  private selectColumns(meta: PostgisTableMeta, properties: Array<{ column: string, alias: string }>): string[] {
    return [
      `${quoteSqlIdentifier(meta.primaryKey)} AS ${quoteSqlIdentifier('__id__')}`,
      `ST_AsEWKB(${quoteSqlIdentifier(meta.geometryColumn)}) AS ${quoteSqlIdentifier('__geom__')}`,
      ...properties.map(({ column, alias }) =>
        `${quoteSqlIdentifier(column)} AS ${quoteSqlIdentifier(alias)}`
      )
    ]
  }

  private propertyAliases(meta: PostgisTableMeta, requested?: string[]): Array<{ column: string, alias: string }> {
    const columns = requested ?? meta.propertyColumns

    for (const column of columns) {
      if (!meta.propertyColumns.includes(column)) {
        throw new Error(`Invalid PostGIS source property column "${column}" for table "${meta.schemaName}.${meta.tableName}"`)
      }
    }

    return columns.map((column, index) => ({
      column,
      alias: `p_${index}`
    }))
  }

  private async queryExtent(
    state: { pool: PgPool, meta: PostgisTableMeta },
    sql: string,
    params: unknown[]
  ): Promise<BBox | null> {
    const row = (await state.pool.query(sql, params)).rows[0]
    return row ? toOptionalBBox(row.min_x, row.min_y, row.max_x, row.max_y) : null
  }

  private estimatedExtentSql(): string {
    return [
      'SELECT',
      'ST_XMin(extent)::float8 AS min_x,',
      'ST_YMin(extent)::float8 AS min_y,',
      'ST_XMax(extent)::float8 AS max_x,',
      'ST_YMax(extent)::float8 AS max_y',
      'FROM (SELECT ST_EstimatedExtent($1, $2, $3) AS extent) e',
      'WHERE extent IS NOT NULL'
    ].join(' ')
  }

  private exactExtentSql(meta: PostgisTableMeta): string {
    const geometryColumn = quoteSqlIdentifier(meta.geometryColumn)

    return [
      'SELECT',
      'ST_XMin(extent)::float8 AS min_x,',
      'ST_YMin(extent)::float8 AS min_y,',
      'ST_XMax(extent)::float8 AS max_x,',
      'ST_YMax(extent)::float8 AS max_y',
      `FROM (SELECT ST_Extent(${geometryColumn}) AS extent FROM ${qualifiedTableName(meta)}) e`,
      'WHERE extent IS NOT NULL'
    ].join(' ')
  }

  private toDbRef(sourceRef: SourceRef, meta: PostgisTableMeta): DbRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.sourceId) {
      throw new Error(`PostGIS sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (sourceRef.storage !== 'database') {
      throw new Error('PostGIS sourceRef must use database storage')
    }

    if (sourceRef.schemaName !== undefined && sourceRef.schemaName !== meta.schemaName) {
      throw new Error(`PostGIS sourceRef targets schema "${sourceRef.schemaName}", expected "${meta.schemaName}"`)
    }

    if (sourceRef.tableName !== meta.tableName) {
      throw new Error(`PostGIS sourceRef targets table "${sourceRef.tableName}", expected "${meta.tableName}"`)
    }

    return sourceRef as DbRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }
}

async function resolveTableMeta(
  client: PoolClient,
  options: Pick<PostgisSourceOptions, 'geometryColumn' | 'primaryKey' | 'srid' | 'properties'> & {
    schema: string
    tableName: string
  }
): Promise<PostgisTableMeta> {
  const schemaName = requireNonEmptyString(options.schema, 'PostGIS schema')
  const tableName = requireNonEmptyString(options.tableName, 'PostGIS tableName')
  const columns = await readColumns(client, schemaName, tableName)

  if (columns.length === 0) {
    throw new Error(`Invalid PostGIS source: table "${schemaName}.${tableName}" was not found`)
  }

  const geometryColumn = await resolveGeometryColumn(client, {
    schemaName,
    tableName,
    configuredColumn: options.geometryColumn,
    tableColumns: columns
  })
  const primaryKey = await resolvePrimaryKey(client, {
    schemaName,
    tableName,
    configuredPrimaryKey: options.primaryKey,
    tableColumns: columns
  })
  const propertyColumns = resolvePropertyColumns({
    configuredProperties: options.properties,
    tableColumns: columns,
    geometryColumn
  })
  const srid = options.srid ?? await readSrid(client, schemaName, tableName, geometryColumn)

  return {
    schemaName,
    tableName,
    geometryColumn,
    primaryKey,
    propertyColumns,
    srid
  }
}

async function readColumns(client: PoolClient, schemaName: string, tableName: string): Promise<string[]> {
  const result = await client.query<{
    column_name: string
  }>([
    'SELECT column_name',
    'FROM information_schema.columns',
    'WHERE table_schema = $1 AND table_name = $2',
    'ORDER BY ordinal_position'
  ].join(' '), [schemaName, tableName])

  return result.rows.map((row) => row.column_name)
}

async function resolveGeometryColumn(
  client: PoolClient,
  options: {
    schemaName: string
    tableName: string
    configuredColumn?: string
    tableColumns: string[]
  }
): Promise<string> {
  if (options.configuredColumn) {
    const geometryColumn = requireKnownColumn(options.configuredColumn, options.tableColumns, 'geometry column')
    await ensurePostgisGeometryColumn(client, options.schemaName, options.tableName, geometryColumn)
    return geometryColumn
  }

  const result = await client.query<{
    f_geometry_column: string
  }>([
    'SELECT f_geometry_column',
    'FROM geometry_columns',
    'WHERE f_table_schema = $1 AND f_table_name = $2',
    'ORDER BY f_geometry_column'
  ].join(' '), [options.schemaName, options.tableName])

  if (result.rows.length === 0) {
    throw new Error(`Invalid PostGIS source: no geometry column found for table "${options.schemaName}.${options.tableName}"; specify geometryColumn`)
  }

  if (result.rows.length > 1) {
    throw new Error(`PostGIS table "${options.schemaName}.${options.tableName}" has multiple geometry columns; specify geometryColumn`)
  }

  return requireKnownColumn(result.rows[0].f_geometry_column, options.tableColumns, 'geometry column')
}

async function ensurePostgisGeometryColumn(
  client: PoolClient,
  schemaName: string,
  tableName: string,
  geometryColumn: string
): Promise<void> {
  const result = await client.query<{ exists: boolean }>([
    'SELECT EXISTS (',
    'SELECT 1 FROM geometry_columns',
    'WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3',
    ') AS exists'
  ].join(' '), [schemaName, tableName, geometryColumn])

  if (!result.rows[0]?.exists) {
    throw new Error(`Invalid PostGIS source: column "${geometryColumn}" is not registered as a geometry column for table "${schemaName}.${tableName}"`)
  }
}

async function resolvePrimaryKey(
  client: PoolClient,
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

  const result = await client.query<{
    column_name: string
  }>([
    'SELECT kcu.column_name',
    'FROM information_schema.table_constraints tc',
    'JOIN information_schema.key_column_usage kcu',
    'ON kcu.constraint_schema = tc.constraint_schema',
    'AND kcu.constraint_name = tc.constraint_name',
    'AND kcu.table_schema = tc.table_schema',
    'AND kcu.table_name = tc.table_name',
    "WHERE tc.constraint_type = 'PRIMARY KEY'",
    'AND tc.table_schema = $1',
    'AND tc.table_name = $2',
    'ORDER BY kcu.ordinal_position'
  ].join(' '), [options.schemaName, options.tableName])

  if (result.rows.length === 0) {
    throw new Error(`PostGIS table "${options.schemaName}.${options.tableName}" has no primary key; specify primaryKey`)
  }

  if (result.rows.length > 1) {
    throw new Error(`PostGIS table "${options.schemaName}.${options.tableName}" uses a composite primary key; configure a single stable primaryKey column`)
  }

  return requireKnownColumn(result.rows[0].column_name, options.tableColumns, 'primary key')
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
  client: PoolClient,
  schemaName: string,
  tableName: string,
  geometryColumn: string
): Promise<number | null> {
  const result = await client.query<{ srid: unknown }>('SELECT Find_SRID($1, $2, $3) AS srid', [
    schemaName,
    tableName,
    geometryColumn
  ])
  const srid = toOptionalNumber(result.rows[0]?.srid)

  return srid && srid > 0 ? srid : null
}

function createPoolConfig(options: PostgisConnectionOptions): PoolConfig {
  return {
    connectionString: options.connectionString,
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    ssl: options.ssl,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    idleTimeoutMillis: options.idleTimeoutMillis,
    statement_timeout: options.statementTimeoutMillis,
    query_timeout: options.queryTimeoutMillis,
    application_name: options.applicationName
  }
}

function parsePostgisGeometry(value: unknown): Geometry | null {
  const buffer = toBuffer(value)
  if (!buffer) return null

  const reader = new WkbReader(buffer)
  const geometry = reader.readGeometry()

  if (!reader.eof) {
    throw new Error('Invalid PostGIS geometry: trailing bytes after WKB body')
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
  const normalized = requireNonEmptyString(column, `PostGIS ${label}`)
  if (!columns.includes(normalized)) {
    throw new Error(`Invalid PostGIS source: ${label} "${normalized}" was not found`)
  }

  return normalized
}

function qualifiedTableName(meta: Pick<PostgisTableMeta, 'schemaName' | 'tableName'>): string {
  return `${quoteSqlIdentifier(meta.schemaName)}.${quoteSqlIdentifier(meta.tableName)}`
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function crsFromSrid(srid: number | null): CrsCode | null {
  return srid !== null && Number.isInteger(srid) && srid > 0 ? `${POSTGIS_CRS_PREFIX}${srid}` : null
}
