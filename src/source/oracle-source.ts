import oracledb from 'oracledb'
import type { BBox, CrsCode, Geometry } from '../core/geometry.js'
import type { DbRef, DescInfo, Feature, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { Gt } from '../core/geotools.js'
import { type Props, type Registry } from '../core/tools.js'
import { DbSource, hasSourceConfigType, toStream, type FeatureTransform, type QueryOptions } from './source.js'
import type { StreamOptions } from './source.js'
import { DbDataset, type DbDatasetJson } from './db-dataset.js'
import { AbortSignalGuard } from './source-utils.js'
import { SdoGeometryReader } from './sdo-geometry-reader.js'

export type OracleExtentStrategy = 'metadata' | 'exact' | 'none'

export type OracleConnectionOptions = {
  connectionString?: string
  connectString?: string
  host?: string
  port?: number
  serviceName?: string
  sid?: string
  user?: string
  password?: string
  externalAuth?: boolean
  homogeneous?: boolean
  poolMin?: number
  poolMax?: number
  poolIncrement?: number
  poolTimeout?: number
  queueTimeout?: number
  stmtCacheSize?: number
  callTimeout?: number
  walletLocation?: string
  walletPassword?: string
  configDir?: string
}

export type OracleSourceOptions = {
  connection: OracleConnectionOptions
  schema?: string
  datasets: Record<string, DbDatasetJson>
  batchSize?: number
  extentStrategy?: OracleExtentStrategy
  transformFeature?: FeatureTransform
}

export type OracleSourceJson = DescInfo & {
  type: 'oracle'
  connection: OracleConnectionOptions
  schema?: string
  datasets: Record<string, DbDatasetJson>
  batchSize?: number
  extentStrategy?: OracleExtentStrategy
}

type OracleTableOptions = {
  schema?: string
  tableName: string
  geometryColumn?: string
  primaryKey?: string
  srid?: number
  properties?: string[]
}

type OracleColumnMeta = {
  columnName: string
  dataType: string
  dataTypeOwner: string | null
}

type OracleTableMeta = {
  schemaName: string
  tableName: string
  geometryColumn: string
  primaryKey: string
  propertyColumns: string[]
  srid: number | null
  metadataExtent: BBox | null
}

type OracleQuery = {
  sql: string
  binds: OracleBinds
  properties: Array<{ column: string, alias: string }>
}

type OracleBinds = Record<string, string | number | null>
type OracleRow = Props

const DEFAULT_BATCH_SIZE = 500
const DEFAULT_EXTENT_STRATEGY: OracleExtentStrategy = 'metadata'
const ROWID_PRIMARY_KEY = 'ROWID'

export class OracleSource extends DbSource {
  readonly type = 'oracle'

  private readonly reader: OracleReader
  private opened = false
  private opening: Promise<void> | null = null

  static acceptsConfig(entry: unknown): entry is OracleSourceJson {
    return hasSourceConfigType(entry, 'oracle')
  }

  static fromConfig(
    id: string,
    entry: OracleSourceJson
  ): OracleSource {
    return new OracleSource(id, {
      connection: entry.connection,
      schema: entry.schema,
      datasets: entry.datasets,
      batchSize: entry.batchSize,
      extentStrategy: entry.extentStrategy
    })
  }

  constructor(
    readonly id: string,
    options: OracleSourceOptions
  ) {
    super(options.transformFeature)

    this.reader = new OracleReader(this.id, {
      connection: options.connection,
      schema: options.schema,
      datasets: DbDataset.build(`Oracle source "${this.id}"`, options.datasets),
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

  protected override async readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    await this.open()
    return this.reader.read(sourceRef, this.resolveDatasetId(options.layer), options)
  }

  protected override async *streamFeatures(options: StreamOptions): AsyncGenerator<Feature> {
    await this.open()
    yield* this.reader.stream(this.resolveDatasetId(options.layer), options)
  }

  protected override abortReason(signal: AbortSignal): unknown {
    return AbortSignalGuard.reason(signal, 'Oracle stream aborted')
  }

  private async *queryFeatures(options: QueryOptions): AsyncGenerator<Feature> {
    await this.open()
    yield* this.mapFeatures(this.reader.query(this.resolveDatasetId(options.layer), options), options)
  }
}

class OracleReader {
  private pool: oracledb.Pool | null = null
  private readonly metas = new Map<string, OracleTableMeta>()
  private readonly geometryReader = new SdoGeometryReader()

  constructor(
    private readonly sourceId: string,
    private readonly options: {
      connection: OracleConnectionOptions
      schema?: string
      datasets: Registry<DbDataset>
      batchSize: number
      extentStrategy: OracleExtentStrategy
    }
  ) {}

  async open(): Promise<void> {
    if (!oracledb.thin) {
      throw new Error('Oracle source requires node-oracledb thin mode; do not call oracledb.initOracleClient().')
    }

    const pool = await oracledb.createPool(createPoolAttributes(this.options.connection))
    this.pool = pool

    try {
      const connection = await this.getConnection(pool)
      try {
        await connection.execute('SELECT 1 FROM dual')
        for (const dataset of this.options.datasets.all) {
          this.metas.set(dataset.id, await resolveTableMeta(connection, this.tableOptions(dataset)))
        }
      } finally {
        await connection.close()
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
    if (pool) await pool.close(0)
  }

  async getExtent(datasetId: string): Promise<BBox | null> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)

    switch (this.options.extentStrategy) {
      case 'none':
        return null

      case 'metadata':
        return meta.metadataExtent

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
      crs: options.layer.crs
    })
    yield* this.featuresFromQuery({ pool: state.pool, meta }, query, options)
  }

  async read(sourceRef: SourceRef, datasetId: string, options: StreamOptions): Promise<Feature | null> {
    const state = this.requireOpen()
    const meta = this.metaForDataset(datasetId)
    const ref = this.toDbRef(sourceRef, meta)
    const query = this.selectOneSql(meta, ref)
    const rows = await this.executeRows(state.pool, query.sql, query.binds)
    const row = rows[0]
    if (!row) return null
    return this.toFeature(meta, query.properties, row, ref.recordIndex ?? 0, options.layer)
  }

  private requireOpen(): { pool: oracledb.Pool } {
    if (!this.pool) {
      throw new Error('Oracle source is not opened')
    }

    return {
      pool: this.pool
    }
  }

  private metaForDataset(datasetId: string): OracleTableMeta {
    this.options.datasets.get(datasetId)
    const meta = this.metas.get(datasetId)

    if (!meta) {
      throw new Error(`Oracle source "${this.sourceId}" dataset "${datasetId}" is not opened`)
    }

    return meta
  }

  private tableOptions(dataset: DbDataset): OracleTableOptions {
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
    state: { pool: oracledb.Pool, meta: OracleTableMeta },
    query: OracleQuery,
    options: StreamOptions
  ): AsyncGenerator<Feature> {
    let index = 0

    for await (const row of this.queryRows(state.pool, query.sql, query.binds, options.signal)) {
      AbortSignalGuard.throwIfAborted(options.signal, 'Oracle stream aborted')
      yield this.toFeature(state.meta, query.properties, row, index, options.layer)
      index += 1
    }
  }

  private async *queryRows(
    pool: oracledb.Pool,
    sql: string,
    binds: OracleBinds,
    signal?: AbortSignal
  ): AsyncGenerator<OracleRow> {
    const connection = await this.getConnection(pool)
    let resultSet: oracledb.ResultSet<OracleRow> | null = null
    let resultSetClosed = false
    let connectionClosed = false

    const closeResultSet = async (): Promise<void> => {
      if (!resultSet || resultSetClosed) return
      resultSetClosed = true
      await resultSet.close().catch(() => undefined)
    }
    const closeConnection = async (drop = false): Promise<void> => {
      if (connectionClosed) return
      connectionClosed = true
      if (drop) {
        await connection.close({ drop: true }).catch(() => undefined)
      } else {
        await connection.close().catch(() => undefined)
      }
    }
    const onAbort = () => {
      void closeResultSet()
      void closeConnection(true)
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      AbortSignalGuard.throwIfAborted(signal, 'Oracle stream aborted')
      const result = await connection.execute<OracleRow>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        resultSet: true,
        fetchArraySize: this.options.batchSize,
        dbObjectAsPojo: false
      })
      resultSet = result.resultSet ?? null

      if (!resultSet) return

      for (;;) {
        AbortSignalGuard.throwIfAborted(signal, 'Oracle stream aborted')
        const rows = await resultSet.getRows(this.options.batchSize)
        if (rows.length === 0) return

        for (const row of rows) {
          AbortSignalGuard.throwIfAborted(signal, 'Oracle stream aborted')
          yield row
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await closeResultSet()
      await closeConnection()
    }
  }

  private async executeRows(
    pool: oracledb.Pool,
    sql: string,
    binds: OracleBinds = {}
  ): Promise<OracleRow[]> {
    const connection = await this.getConnection(pool)

    try {
      const result = await connection.execute<OracleRow>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        dbObjectAsPojo: false
      })
      return result.rows ?? []
    } finally {
      await connection.close()
    }
  }

  private async getConnection(pool: oracledb.Pool): Promise<oracledb.Connection> {
    const connection = await pool.getConnection()
    if (this.options.connection.callTimeout !== undefined) {
      connection.callTimeout = this.options.connection.callTimeout
    }
    return connection
  }

  private toFeature(
    meta: OracleTableMeta,
    properties: Array<{ column: string, alias: string }>,
    row: OracleRow,
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
      primaryKey: meta.primaryKey === ROWID_PRIMARY_KEY ? undefined : meta.primaryKey,
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
      geometry: this.parseGeometry(row.__geom__),
      sourceRef
    }
  }

  private parseGeometry(value: unknown): Geometry | null {
    return this.geometryReader.readGeometry(value)
  }

  private selectSql(
    meta: OracleTableMeta,
    options: { bbox?: BBox, properties?: string[], crs?: CrsCode }
  ): OracleQuery {
    const binds: OracleBinds = {}
    const where: string[] = []

    if (options.bbox) {
      const envelopeSrid = (options.crs ? sridFromCrs(options.crs) : null) ?? meta.srid
      binds.minX = options.bbox[0]
      binds.minY = options.bbox[1]
      binds.maxX = options.bbox[2]
      binds.maxY = options.bbox[3]
      binds.bboxSrid = envelopeSrid ?? null

      const geom = quoteOracleIdentifier(meta.geometryColumn)
      const envelope = [
        'MDSYS.SDO_GEOMETRY(',
        '2003, :bboxSrid, NULL,',
        'MDSYS.SDO_ELEM_INFO_ARRAY(1, 1003, 3),',
        'MDSYS.SDO_ORDINATE_ARRAY(:minX, :minY, :maxX, :maxY)',
        ')'
      ].join(' ')

      where.push(`${geom} IS NOT NULL`)
      where.push(`SDO_FILTER(${geom}, ${envelope}, 'querytype=WINDOW') = 'TRUE'`)
    }

    const properties = this.propertyAliases(meta, options.properties)
    const sql = [
      `SELECT ${this.selectColumns(meta, properties).join(', ')}`,
      `FROM ${qualifiedTableName(meta)}`,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      `ORDER BY ${orderExpression(meta)}`
    ].filter(Boolean).join(' ')

    return { sql, binds, properties }
  }

  private selectOneSql(meta: OracleTableMeta, sourceRef: DbRef): OracleQuery {
    const properties = this.propertyAliases(meta)
    const where = meta.primaryKey === ROWID_PRIMARY_KEY
      ? 'ROWID = CHARTOROWID(:featureKey)'
      : `${quoteOracleIdentifier(meta.primaryKey)} = :featureKey`
    const sql = [
      `SELECT ${this.selectColumns(meta, properties).join(', ')}`,
      `FROM ${qualifiedTableName(meta)}`,
      `WHERE ${where}`
    ].join(' ')

    return {
      sql,
      binds: { featureKey: sourceRef.rowId },
      properties
    }
  }

  private selectColumns(meta: OracleTableMeta, properties: Array<{ column: string, alias: string }>): string[] {
    return [
      `${idExpression(meta)} AS ${quoteOracleIdentifier('__id__')}`,
      `${quoteOracleIdentifier(meta.geometryColumn)} AS ${quoteOracleIdentifier('__geom__')}`,
      ...properties.map(({ column, alias }) =>
        `${quoteOracleIdentifier(column)} AS ${quoteOracleIdentifier(alias)}`
      )
    ]
  }

  private propertyAliases(meta: OracleTableMeta, requested?: string[]): Array<{ column: string, alias: string }> {
    const columns = requested
      ? requested.map((column) => requireKnownColumn(column, meta.propertyColumns, 'property column'))
      : meta.propertyColumns

    return columns.map((column, index) => ({
      column,
      alias: `p_${index}`
    }))
  }

  private async queryExactExtent(pool: oracledb.Pool, meta: OracleTableMeta): Promise<BBox | null> {
    const sql = [
      `SELECT SDO_AGGR_MBR(${quoteOracleIdentifier(meta.geometryColumn)}) AS ${quoteOracleIdentifier('__extent__')}`,
      `FROM ${qualifiedTableName(meta)}`,
      `WHERE ${quoteOracleIdentifier(meta.geometryColumn)} IS NOT NULL`
    ].join(' ')
    const row = (await this.executeRows(pool, sql))[0]
    const geometry = this.parseGeometry(row?.__extent__)

    return geometry ? Gt.bbox(geometry) : null
  }

  private toDbRef(sourceRef: SourceRef, meta: OracleTableMeta): DbRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.sourceId) {
      throw new Error(`Oracle sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (sourceRef.storage !== 'database') {
      throw new Error('Oracle sourceRef must use database storage')
    }

    if (sourceRef.schemaName !== undefined && normalizeOracleName(sourceRef.schemaName) !== meta.schemaName) {
      throw new Error(`Oracle sourceRef targets schema "${sourceRef.schemaName}", expected "${meta.schemaName}"`)
    }

    if (normalizeOracleName(sourceRef.tableName) !== meta.tableName) {
      throw new Error(`Oracle sourceRef targets table "${sourceRef.tableName}", expected "${meta.tableName}"`)
    }

    return sourceRef as DbRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }
}

async function resolveTableMeta(
  connection: oracledb.Connection,
  options: OracleTableOptions
): Promise<OracleTableMeta> {
  const schemaName = await resolveSchemaName(connection, options.schema)
  const tableName = await resolveTableName(connection, schemaName, options.tableName)
  const columns = await readColumns(connection, schemaName, tableName)

  if (columns.length === 0) {
    throw new Error(`Invalid Oracle source: table "${schemaName}.${tableName}" was not found`)
  }

  const geometryColumn = await resolveGeometryColumn(connection, {
    schemaName,
    tableName,
    configuredColumn: options.geometryColumn,
    tableColumns: columns
  })
  const primaryKey = await resolvePrimaryKey(connection, {
    schemaName,
    tableName,
    configuredPrimaryKey: options.primaryKey,
    tableColumns: columns.map((column) => column.columnName)
  })
  const propertyColumns = resolvePropertyColumns({
    configuredProperties: options.properties,
    tableColumns: columns.map((column) => column.columnName),
    geometryColumn
  })
  const spatialMetadata = await readSpatialMetadata(connection, schemaName, tableName, geometryColumn)
  const srid = options.srid ?? spatialMetadata.srid

  return {
    schemaName,
    tableName,
    geometryColumn,
    primaryKey,
    propertyColumns,
    srid,
    metadataExtent: spatialMetadata.extent
  }
}

async function resolveSchemaName(connection: oracledb.Connection, configuredSchema?: string): Promise<string> {
  if (!configuredSchema) {
    const rows = await executeRows<{ schemaName: string }>(connection, [
      `SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS ${quoteOracleIdentifier('schemaName')}`,
      'FROM dual'
    ].join(' '))
    return requireNonEmptyString(String(rows[0]?.schemaName ?? ''), 'Oracle current schema')
  }

  const schemaName = requireNonEmptyString(configuredSchema, 'Oracle schema')
  const rows = await executeRows<{ schemaName: string }>(connection, [
    `SELECT username AS ${quoteOracleIdentifier('schemaName')}`,
    'FROM all_users',
    'WHERE username = :schemaName OR username = UPPER(:schemaName)',
    'ORDER BY CASE WHEN username = :schemaName THEN 0 ELSE 1 END',
    'FETCH FIRST 1 ROWS ONLY'
  ].join(' '), { schemaName })

  return rows[0]?.schemaName ?? normalizeOracleName(schemaName)
}

async function resolveTableName(connection: oracledb.Connection, schemaName: string, configuredTableName: string): Promise<string> {
  const tableName = requireNonEmptyString(configuredTableName, 'Oracle tableName')
  const rows = await executeRows<{ tableName: string }>(connection, [
    `SELECT DISTINCT table_name AS ${quoteOracleIdentifier('tableName')}`,
    'FROM all_tab_columns',
    'WHERE owner = :schemaName',
    'AND (table_name = :tableName OR table_name = UPPER(:tableName))',
    'ORDER BY CASE WHEN table_name = :tableName THEN 0 ELSE 1 END, table_name',
    'FETCH FIRST 1 ROWS ONLY'
  ].join(' '), { schemaName, tableName })

  return rows[0]?.tableName ?? normalizeOracleName(tableName)
}

async function readColumns(
  connection: oracledb.Connection,
  schemaName: string,
  tableName: string
): Promise<OracleColumnMeta[]> {
  return executeRows<{
    columnName: string
    dataType: string
    dataTypeOwner: string | null
  }>(connection, [
    `SELECT column_name AS ${quoteOracleIdentifier('columnName')},`,
    `data_type AS ${quoteOracleIdentifier('dataType')},`,
    `data_type_owner AS ${quoteOracleIdentifier('dataTypeOwner')}`,
    'FROM all_tab_columns',
    'WHERE owner = :schemaName AND table_name = :tableName',
    'ORDER BY column_id'
  ].join(' '), { schemaName, tableName })
}

async function resolveGeometryColumn(
  connection: oracledb.Connection,
  options: {
    schemaName: string
    tableName: string
    configuredColumn?: string
    tableColumns: OracleColumnMeta[]
  }
): Promise<string> {
  if (options.configuredColumn) {
    const geometryColumn = requireKnownColumn(
      options.configuredColumn,
      options.tableColumns.map((column) => column.columnName),
      'geometry column'
    )
    ensureOracleGeometryColumn(options.schemaName, options.tableName, geometryColumn, options.tableColumns)
    return geometryColumn
  }

  const metadataRows = await executeRows<{ columnName: string }>(connection, [
    `SELECT column_name AS ${quoteOracleIdentifier('columnName')}`,
    'FROM all_sdo_geom_metadata',
    'WHERE owner = :schemaName AND table_name = :tableName',
    'ORDER BY column_name'
  ].join(' '), {
    schemaName: options.schemaName,
    tableName: options.tableName
  })

  if (metadataRows.length === 1) {
    return requireKnownColumn(
      metadataRows[0].columnName,
      options.tableColumns.map((column) => column.columnName),
      'geometry column'
    )
  }

  if (metadataRows.length > 1) {
    throw new Error(`Oracle table "${options.schemaName}.${options.tableName}" has multiple SDO_GEOMETRY metadata entries; specify geometryColumn`)
  }

  const geometryColumns = options.tableColumns.filter(isSdoGeometryColumn)

  if (geometryColumns.length === 0) {
    throw new Error(`Invalid Oracle source: no MDSYS.SDO_GEOMETRY column found for table "${options.schemaName}.${options.tableName}"; specify geometryColumn`)
  }

  if (geometryColumns.length > 1) {
    throw new Error(`Oracle table "${options.schemaName}.${options.tableName}" has multiple SDO_GEOMETRY columns; specify geometryColumn`)
  }

  return geometryColumns[0].columnName
}

function ensureOracleGeometryColumn(
  schemaName: string,
  tableName: string,
  geometryColumn: string,
  columns: OracleColumnMeta[]
): void {
  const column = columns.find((candidate) => candidate.columnName === geometryColumn)

  if (!column || !isSdoGeometryColumn(column)) {
    throw new Error(`Invalid Oracle source: column "${geometryColumn}" is not MDSYS.SDO_GEOMETRY for table "${schemaName}.${tableName}"`)
  }
}

async function resolvePrimaryKey(
  connection: oracledb.Connection,
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

  const rows = await executeRows<{ columnName: string }>(connection, [
    `SELECT acc.column_name AS ${quoteOracleIdentifier('columnName')}`,
    'FROM all_constraints ac',
    'JOIN all_cons_columns acc',
    'ON acc.owner = ac.owner',
    'AND acc.constraint_name = ac.constraint_name',
    'AND acc.table_name = ac.table_name',
    "WHERE ac.constraint_type = 'P'",
    'AND ac.owner = :schemaName',
    'AND ac.table_name = :tableName',
    'ORDER BY acc.position'
  ].join(' '), {
    schemaName: options.schemaName,
    tableName: options.tableName
  })

  if (rows.length === 0) return ROWID_PRIMARY_KEY

  if (rows.length > 1) {
    throw new Error(`Oracle table "${options.schemaName}.${options.tableName}" uses a composite primary key; configure a single stable primaryKey column`)
  }

  return requireKnownColumn(rows[0].columnName, options.tableColumns, 'primary key')
}

function resolvePropertyColumns(options: {
  configuredProperties?: string[]
  tableColumns: string[]
  geometryColumn: string
}): string[] {
  const columns = options.configuredProperties
    ? options.configuredProperties.map((column) => requireKnownColumn(column, options.tableColumns, 'property column'))
    : options.tableColumns.filter((column) => column !== options.geometryColumn)

  return columns.map((column) => requireKnownColumn(column, options.tableColumns, 'property column'))
}

async function readSpatialMetadata(
  connection: oracledb.Connection,
  schemaName: string,
  tableName: string,
  geometryColumn: string
): Promise<{ srid: number | null, extent: BBox | null }> {
  const rows = await executeRows<{
    srid: unknown
    lowerBound: unknown
    upperBound: unknown
    axisIndex: unknown
  }>(connection, [
    'SELECT * FROM (',
    `SELECT m.srid AS ${quoteOracleIdentifier('srid')},`,
    `d.sdo_lb AS ${quoteOracleIdentifier('lowerBound')},`,
    `d.sdo_ub AS ${quoteOracleIdentifier('upperBound')},`,
    `ROWNUM AS ${quoteOracleIdentifier('axisIndex')}`,
    'FROM all_sdo_geom_metadata m, TABLE(m.diminfo) d',
    'WHERE m.owner = :schemaName',
    'AND m.table_name = :tableName',
    'AND m.column_name = :geometryColumn',
    ') ORDER BY "axisIndex"'
  ].join(' '), { schemaName, tableName, geometryColumn })
  const srid = toOptionalNumber(rows[0]?.srid)
  const xDim = rows[0]
  const yDim = rows[1]
  const extent = toOptionalBBox(
    xDim?.lowerBound,
    yDim?.lowerBound,
    xDim?.upperBound,
    yDim?.upperBound
  )

  return { srid, extent }
}

async function executeRows<T extends Props>(
  connection: oracledb.Connection,
  sql: string,
  binds: OracleBinds = {}
): Promise<T[]> {
  const result = await connection.execute<T>(sql, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    dbObjectAsPojo: false
  })

  return result.rows ?? []
}

function createPoolAttributes(options: OracleConnectionOptions): oracledb.PoolAttributes {
  return {
    connectString: createConnectString(options),
    user: options.user,
    password: options.password,
    externalAuth: options.externalAuth,
    homogeneous: options.homogeneous,
    poolMin: options.poolMin,
    poolMax: options.poolMax,
    poolIncrement: options.poolIncrement,
    poolTimeout: options.poolTimeout,
    queueTimeout: options.queueTimeout,
    stmtCacheSize: options.stmtCacheSize,
    walletLocation: options.walletLocation,
    walletPassword: options.walletPassword,
    configDir: options.configDir
  }
}

function createConnectString(options: OracleConnectionOptions): string | undefined {
  if (options.connectString) return options.connectString
  if (options.connectionString) return options.connectionString
  if (!options.host) return undefined

  const port = options.port ?? 1521

  if (options.serviceName) {
    return `${options.host}:${port}/${options.serviceName}`
  }

  if (options.sid) {
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${options.host})(PORT=${port}))(CONNECT_DATA=(SID=${options.sid})))`
  }

  return `${options.host}:${port}`
}

function isSdoGeometryColumn(column: OracleColumnMeta): boolean {
  return normalizeOracleName(column.dataType) === 'SDO_GEOMETRY'
    && (!column.dataTypeOwner || normalizeOracleName(column.dataTypeOwner) === 'MDSYS')
}

function idExpression(meta: OracleTableMeta): string {
  return meta.primaryKey === ROWID_PRIMARY_KEY
    ? 'ROWIDTOCHAR(ROWID)'
    : quoteOracleIdentifier(meta.primaryKey)
}

function orderExpression(meta: OracleTableMeta): string {
  return meta.primaryKey === ROWID_PRIMARY_KEY
    ? 'ROWID'
    : quoteOracleIdentifier(meta.primaryKey)
}

function qualifiedTableName(meta: Pick<OracleTableMeta, 'schemaName' | 'tableName'>): string {
  return `${quoteOracleIdentifier(meta.schemaName)}.${quoteOracleIdentifier(meta.tableName)}`
}

function quoteOracleIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function requireNonEmptyString(value: string, label: string): string {
  if (value.trim() === '') {
    throw new Error(`${label} must not be empty`)
  }

  return value
}

function requireKnownColumn(column: string, columns: string[], label: string): string {
  const normalized = requireNonEmptyString(column, `Oracle ${label}`)
  const exact = columns.find((candidate) => candidate === normalized)
  if (exact) return exact

  const upper = normalizeOracleName(normalized)
  const upperMatch = columns.find((candidate) => candidate === upper)
  if (upperMatch) return upperMatch

  const insensitiveMatch = columns.find((candidate) => candidate.toUpperCase() === normalized.toUpperCase())
  if (insensitiveMatch) return insensitiveMatch

  throw new Error(`Invalid Oracle source: ${label} "${normalized}" was not found`)
}

function normalizeOracleName(value: string): string {
  return value.toUpperCase()
}

function sridFromCrs(crs: CrsCode): number | null {
  const match = crs.match(/^EPSG:(\d+)$/i)
  if (!match) return null

  const srid = Number(match[1])
  return Number.isSafeInteger(srid) && srid > 0 ? srid : null
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
