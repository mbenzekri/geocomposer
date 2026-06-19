import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layer } from '../../src/layer/layer.js'

type QueryRow = Record<string, unknown>

const layer = {
  id: 'cities-layer',
  dataset: 'cities',
  crs: 'EPSG:4326'
} as Layer

const fakeOracledb = {
  thin: true,
  OUT_FORMAT_OBJECT: 4002,
  createPool: vi.fn()
}

const oracleState = {
  schemaRows: [{ schemaName: 'GEOCOMPOSER' }] as QueryRow[],
  currentSchemaRows: [{ schemaName: 'GEOCOMPOSER' }] as QueryRow[],
  tableRows: [{ tableName: 'CITIES' }] as QueryRow[],
  columns: [
    { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
    { columnName: 'GEOM', dataType: 'SDO_GEOMETRY', dataTypeOwner: 'MDSYS' },
    { columnName: 'NAME', dataType: 'VARCHAR2', dataTypeOwner: null },
    { columnName: 'PAYLOAD', dataType: 'RAW', dataTypeOwner: null }
  ] as QueryRow[],
  metadataRows: [{ columnName: 'GEOM' }] as QueryRow[],
  primaryKeyRows: [{ columnName: 'ID' }] as QueryRow[],
  spatialRows: [
    { srid: 4326, lowerBound: 1, upperBound: 3, axisIndex: 1 },
    { srid: 4326, lowerBound: 2, upperBound: 4, axisIndex: 2 }
  ] as QueryRow[],
  readRows: [{ __id__: 7, __geom__: sdoPoint(2, 48), p_0: 'Paris' }] as QueryRow[],
  exactExtentRows: [{ __extent__: sdoRectangle(1, 2, 3, 4) }] as QueryRow[],
  streamRows: [{
    __id__: 7,
    __geom__: sdoPoint(2, 48),
    p_0: 'Paris',
    p_1: new Uint8Array([1, 2])
  }] as QueryRow[],
  resultSetMissing: false
}

class FakeOracleResultSet {
  private offset = 0
  closed = false

  constructor(private readonly rows: QueryRow[]) {}

  async getRows(size: number): Promise<QueryRow[]> {
    const rows = this.rows.slice(this.offset, this.offset + size)
    this.offset += rows.length
    return rows
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeOracleConnection {
  closed = false
  dropped = false
  callTimeout?: number
  readonly queries: Array<{ sql: string, binds: QueryRow }> = []

  async execute(sql: string, binds: QueryRow = {}, options: { resultSet?: boolean } = {}): Promise<{
    rows?: QueryRow[]
    resultSet?: FakeOracleResultSet
  }> {
    this.queries.push({ sql, binds })

    if (options.resultSet) {
      if (oracleState.resultSetMissing) return {}
      return {
        resultSet: new FakeOracleResultSet(oracleState.streamRows)
      }
    }

    return { rows: oracleRowsFor(sql) }
  }

  async close(options?: { drop?: boolean }): Promise<void> {
    this.closed = true
    this.dropped = options?.drop === true
  }
}

class FakeOraclePool {
  static instances: FakeOraclePool[] = []

  readonly connections: FakeOracleConnection[] = []
  closed = false
  closeMode: number | undefined

  constructor(readonly attributes: unknown) {
    FakeOraclePool.instances.push(this)
  }

  async getConnection(): Promise<FakeOracleConnection> {
    const connection = new FakeOracleConnection()
    this.connections.push(connection)
    return connection
  }

  async close(mode: number): Promise<void> {
    this.closed = true
    this.closeMode = mode
  }
}

beforeEach(() => {
  vi.resetModules()
  fakeOracledb.thin = true
  fakeOracledb.createPool = vi.fn(async (attributes: unknown) => new FakeOraclePool(attributes))
  FakeOraclePool.instances = []
  oracleState.schemaRows = [{ schemaName: 'GEOCOMPOSER' }]
  oracleState.currentSchemaRows = [{ schemaName: 'GEOCOMPOSER' }]
  oracleState.tableRows = [{ tableName: 'CITIES' }]
  oracleState.columns = [
    { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
    { columnName: 'GEOM', dataType: 'SDO_GEOMETRY', dataTypeOwner: 'MDSYS' },
    { columnName: 'NAME', dataType: 'VARCHAR2', dataTypeOwner: null },
    { columnName: 'PAYLOAD', dataType: 'RAW', dataTypeOwner: null }
  ]
  oracleState.metadataRows = [{ columnName: 'GEOM' }]
  oracleState.primaryKeyRows = [{ columnName: 'ID' }]
  oracleState.spatialRows = [
    { srid: 4326, lowerBound: 1, upperBound: 3, axisIndex: 1 },
    { srid: 4326, lowerBound: 2, upperBound: 4, axisIndex: 2 }
  ]
  oracleState.readRows = [{ __id__: 7, __geom__: sdoPoint(2, 48), p_0: 'Paris' }]
  oracleState.exactExtentRows = [{ __extent__: sdoRectangle(1, 2, 3, 4) }]
  oracleState.streamRows = [{
    __id__: 7,
    __geom__: sdoPoint(2, 48),
    p_0: 'Paris',
    p_1: new Uint8Array([1, 2])
  }]
  oracleState.resultSetMissing = false
})

describe('OracleSource', () => {
  it('streams features with database sourceRef and closes resources', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')
    const source = new OracleSource('oracle-test', {
      connection: {
        connectionString: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
        callTimeout: 30000
      },
      schema: 'GEOCOMPOSER',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id',
          properties: ['name', 'payload']
        }
      },
      batchSize: 1
    })

    await source.open()
    const features = await readAll(source.query({ layer, bbox: [1, 47, 3, 49], limit: 1 }))

    expect(features).toHaveLength(1)
    expect(features[0].id).toBe(7)
    expect(features[0].properties).toEqual({
      NAME: 'Paris',
      PAYLOAD: 'AQI='
    })
    expect(features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [2, 48]
    })
    expect(features[0].sourceRef).toEqual({
      storage: 'database',
      sourceId: 'oracle-test',
      schemaName: 'GEOCOMPOSER',
      tableName: 'CITIES',
      rowId: 7,
      primaryKey: 'ID',
      geometryColumn: 'GEOM',
      recordIndex: 0
    })
    expect(FakeOraclePool.instances[0].connections.at(-1)?.callTimeout).toBe(30000)

    await source.close()
    expect(FakeOraclePool.instances[0].closed).toBe(true)
    expect(FakeOraclePool.instances[0].closeMode).toBe(0)
  })

  it('uses metadata extent, readById and thin mode guard', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')
    const source = new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id',
          properties: ['name']
        }
      }
    })

    await source.open()

    await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 3, 4])
    await expect(source.readById('7', { layer })).resolves.toMatchObject({
      id: 7,
      properties: { NAME: 'Paris' },
      sourceRef: {
        storage: 'database',
        sourceId: 'oracle-test',
        schemaName: 'GEOCOMPOSER',
        tableName: 'CITIES',
        rowId: 7
      }
    })

    await source.close()

    fakeOracledb.thin = false
    const thickSource = new OracleSource('oracle-thick-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: { tableName: 'cities' } }
    })

    await expect(thickSource.open()).rejects.toThrow('thin mode')
  })

  it('supports config helpers, automatic metadata, ROWID and exact/none extents', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')

    expect(OracleSource.acceptsConfig({ type: 'oracle' })).toBe(true)
    expect(OracleSource.acceptsConfig({ type: 'postgis' })).toBe(false)

    oracleState.primaryKeyRows = []
    oracleState.streamRows = [{
      __id__: 'AAABBB',
      __geom__: null,
      p_0: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      p_1: 'Paris',
      p_2: new DataView(new Uint8Array([4, 5]).buffer)
    }]
    oracleState.readRows = []

    const source = OracleSource.fromConfig('oracle-config-test', {
      type: 'oracle',
      title: 'Oracle title',
      abstract: 'Oracle abstract',
      connection: {
        connectionString: 'oracle://geo%20user:geo%20pass@localhost:1521/XEPDB1?retry=1',
        externalAuth: false,
        homogeneous: true,
        poolMin: 0,
        poolMax: 2,
        poolIncrement: 1,
        poolTimeout: 3,
        queueTimeout: 4,
        stmtCacheSize: 5,
        walletLocation: '/wallet',
        walletPassword: 'secret',
        configDir: '/config'
      },
      datasets: { cities: 'cities' },
      extentStrategy: 'exact'
    })

    await source.open()
    await source.open()

    expect(source.title).toBe('Oracle title')
    expect(FakeOraclePool.instances[0].attributes).toMatchObject({
      connectString: 'localhost:1521/XEPDB1?retry=1',
      user: 'geo user',
      password: 'geo pass',
      homogeneous: true,
      poolMin: 0,
      poolMax: 2,
      poolIncrement: 1,
      poolTimeout: 3,
      queueTimeout: 4,
      stmtCacheSize: 5,
      walletLocation: '/wallet',
      walletPassword: 'secret',
      configDir: '/config'
    })
    await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 3, 4])

    const features = await readAll(source.stream({ layer }))
    expect(features[0]).toMatchObject({
      id: 'AAABBB',
      geometry: null,
      properties: {
        ID: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        NAME: 'Paris',
        PAYLOAD: 'BAU='
      },
      sourceRef: {
        primaryKey: undefined
      }
    })
    await expect(source.read(features[0].sourceRef!, { layer })).resolves.toBeNull()

    await source.close()
    await source.close()

    const noneSource = new OracleSource('oracle-none-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id'
        }
      },
      extentStrategy: 'none'
    })
    await noneSource.open()
    await expect(noneSource.getExtent(layer)).resolves.toBeNull()
    await noneSource.close()
  })

  it('validates sourceRef, requested properties and connection strings', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')
    const source = new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id',
          properties: ['name']
        }
      }
    })

    await source.open()

    await expect(readAll(source.query({ layer, properties: ['missing'] }))).rejects.toThrow('property column "missing"')
    await expect(source.query({ layer: { ...layer, dataset: 'missing' } as Layer }).getReader().read()).rejects.toThrow('Item missing not found')
    await expect(source.read({
      storage: 'mem',
      sourceId: 'oracle-test',
      featureIndex: 0
    }, { layer })).rejects.toThrow('database storage')
    await expect(source.read({
      storage: 'database',
      sourceId: 'other',
      tableName: 'cities',
      rowId: 7
    }, { layer })).rejects.toThrow('belongs to "other"')
    await expect(source.read({
      storage: 'database',
      sourceId: 'oracle-test',
      schemaName: 'other',
      tableName: 'cities',
      rowId: 7
    }, { layer })).rejects.toThrow('targets schema')
    await expect(source.read({
      storage: 'database',
      sourceId: 'oracle-test',
      tableName: 'other',
      rowId: 7
    }, { layer })).rejects.toThrow('targets table')

    await source.close()

    for (const connection of [
      'postgres://u:p@localhost:1521/XEPDB1',
      'oracle://u:p@localhost/XEPDB1',
      'oracle://u:p@localhost:1521/',
      'oracle://%zz:p@localhost:1521/XEPDB1'
    ]) {
      const invalidSource = new OracleSource('invalid-oracle-test', {
        connection,
        datasets: { cities: 'cities' }
      })
      await expect(invalidSource.open()).rejects.toThrow('Invalid Oracle GeoComposer connection string')
    }
  })

  it('cleans up when open fails and reports metadata errors', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')

    oracleState.columns = []
    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('was not found')
    expect(FakeOraclePool.instances.at(-1)?.closed).toBe(true)

    oracleState.columns = [
      { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
      { columnName: 'GEOM', dataType: 'SDO_GEOMETRY', dataTypeOwner: 'MDSYS' }
    ]
    oracleState.metadataRows = [{ columnName: 'GEOM' }, { columnName: 'GEOM2' }]
    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('multiple SDO_GEOMETRY metadata')

    oracleState.metadataRows = []
    oracleState.columns = [{ columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null }]
    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('no MDSYS.SDO_GEOMETRY')

    oracleState.columns = [
      { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
      { columnName: 'GEOM', dataType: 'SDO_GEOMETRY', dataTypeOwner: 'MDSYS' },
      { columnName: 'GEOM2', dataType: 'SDO_GEOMETRY', dataTypeOwner: 'MDSYS' }
    ]
    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('multiple SDO_GEOMETRY columns')

    oracleState.columns = [
      { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
      { columnName: 'GEOM', dataType: 'NUMBER', dataTypeOwner: null }
    ]
    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: { tableName: 'cities', geometryColumn: 'geom' } }
    }).open()).rejects.toThrow('is not MDSYS.SDO_GEOMETRY')

    oracleState.columns = [
      { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
      { columnName: 'GEOM', dataType: 'SDO_GEOMETRY', dataTypeOwner: 'MDSYS' }
    ]
    oracleState.primaryKeyRows = [{ columnName: 'ID' }, { columnName: 'OTHER' }]
    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('composite primary key')

    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: { cities: { tableName: 'cities', primaryKey: 'missing' } }
    }).open()).rejects.toThrow('primary key "missing"')

    await expect(new OracleSource('oracle-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: ' ',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('schema must not be empty')
  })

  it('handles empty result sets and missing resultSet objects', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')
    const source = new OracleSource('oracle-empty-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      schema: 'GEOCOMPOSER',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id',
          properties: ['name']
        }
      },
      extentStrategy: 'exact'
    })

    oracleState.readRows = []
    oracleState.exactExtentRows = []
    oracleState.resultSetMissing = true

    await source.open()
    await expect(source.getExtent(layer)).resolves.toBeNull()
    await expect(source.readById('7', { layer })).resolves.toBeNull()
    await expect(readAll(source.query({ layer }))).resolves.toEqual([])
    await source.close()
  })

  it('covers default schema, case-insensitive columns, pagination and abort paths', async () => {
    vi.doMock('oracledb', () => ({
      default: fakeOracledb
    }))

    const { OracleSource } = await import('../../src/source/oracle-source.js')

    oracleState.columns = [
      { columnName: 'ID', dataType: 'NUMBER', dataTypeOwner: null },
      { columnName: 'GEOM', dataType: 'SDO_GEOMETRY', dataTypeOwner: null },
      { columnName: 'Name', dataType: 'VARCHAR2', dataTypeOwner: null },
      { columnName: 'PAYLOAD', dataType: 'RAW', dataTypeOwner: null }
    ]
    oracleState.spatialRows = [
      { srid: '4326', lowerBound: '1', upperBound: 3n, axisIndex: 1 },
      { srid: '4326', lowerBound: '2', upperBound: '4', axisIndex: 2 }
    ]
    oracleState.streamRows = [{
      __id__: 5n,
      __geom__: sdoPoint(3, 4),
      p_0: 'Paris',
      p_1: exactArrayBuffer(new Uint8Array([9, 10]))
    }]
    oracleState.readRows = [{
      __id__: undefined,
      __geom__: null,
      p_0: 'Lyon',
      p_1: exactArrayBuffer(new Uint8Array([11, 12]))
    }]

    const source = new OracleSource('oracle-extra-test', {
      connection: 'oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          properties: ['name', 'payload']
        }
      }
    })

    await source.open()
    await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 3, 4])

    const features = await readAll(source.query({
      layer: { ...layer, crs: 'CRS:84' } as Layer,
      bbox: [1, 2, 3, 4],
      offset: 2,
      limit: 3
    }))
    expect(features[0]).toMatchObject({
      id: 5,
      properties: {
        Name: 'Paris',
        PAYLOAD: 'CQo='
      }
    })
    const pagedQuery = FakeOraclePool.instances[0].connections.at(-1)?.queries.at(-1)
    expect(pagedQuery?.binds).toMatchObject({
      pageOffset: 2,
      pageLimit: 3,
      bboxSrid: 4326
    })

    await expect(source.read({
      storage: 'database',
      sourceId: 'oracle-extra-test',
      tableName: 'cities',
      rowId: 'AAABBB',
      recordIndex: 9
    }, { layer })).resolves.toMatchObject({
      id: 9,
      properties: {
        Name: 'Lyon',
        PAYLOAD: 'Cww='
      },
      sourceRef: {
        recordIndex: 9,
        primaryKey: 'ID'
      }
    })

    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(source.query({ layer, signal: controller.signal }).getReader().read()).rejects.toThrow('stop')

    await source.close()

    const invalidSource = new OracleSource('invalid-url-test', {
      connection: 'not a url',
      datasets: { cities: 'cities' }
    })
    await expect(invalidSource.open()).rejects.toThrow('Invalid Oracle GeoComposer connection string')
  })
})

function oracleRowsFor(sql: string): QueryRow[] {
  if (sql === 'SELECT 1 FROM dual') return [{}]

  if (sql.includes('CURRENT_SCHEMA')) return oracleState.currentSchemaRows
  if (sql.includes('FROM all_users')) return oracleState.schemaRows
  if (sql.includes('FROM all_tab_columns') && sql.includes('DISTINCT table_name')) return oracleState.tableRows
  if (sql.includes('FROM all_tab_columns')) {
    return oracleState.columns
  }
  if (sql.includes('FROM all_sdo_geom_metadata') && sql.includes('ORDER BY column_name')) {
    return oracleState.metadataRows
  }
  if (sql.includes('FROM all_constraints')) return oracleState.primaryKeyRows
  if (sql.includes('TABLE(m.diminfo)')) return oracleState.spatialRows
  if (sql.includes('SDO_AGGR_MBR')) return oracleState.exactExtentRows
  if (sql.includes('WHERE "ID" = :featureKey')) return oracleState.readRows
  if (sql.includes('WHERE ROWID = CHARTOROWID(:featureKey)')) return oracleState.readRows

  return []
}

function sdoPoint(x: number, y: number): QueryRow {
  return {
    SDO_GTYPE: 2001,
    SDO_POINT: { X: x, Y: y, Z: null },
    SDO_ELEM_INFO: [],
    SDO_ORDINATES: []
  }
}

function sdoRectangle(minX: number, minY: number, maxX: number, maxY: number): QueryRow {
  return {
    SDO_GTYPE: 2003,
    SDO_POINT: null,
    SDO_ELEM_INFO: [1, 1003, 3],
    SDO_ORDINATES: [minX, minY, maxX, maxY]
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const values: T[] = []

  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return values
      values.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
}
