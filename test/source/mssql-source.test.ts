import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layer } from '../../src/layer/layer.js'

type QueryRow = Record<string, unknown>

const layer = {
  id: 'cities-layer',
  dataset: 'cities',
  crs: 'EPSG:4326'
} as Layer

const fakeMssql = {
  ConnectionPool: undefined as unknown
}

const mssqlState = {
  columns: [
    { columnName: 'id', dataType: 'int' },
    { columnName: 'geom', dataType: 'geometry' },
    { columnName: 'name', dataType: 'nvarchar' },
    { columnName: 'payload', dataType: 'varbinary' }
  ] as QueryRow[],
  primaryKeyRows: [{ columnName: 'id' }] as QueryRow[],
  sridRows: [{ srid: 4326 }] as QueryRow[],
  extentRows: [{ __extent__: polygonWkb([[1, 2], [3, 2], [3, 4], [1, 4], [1, 2]]) }] as QueryRow[],
  readRows: [{ __id__: 7, __geom__: pointWkb(2, 48), p_0: 'Paris' }] as QueryRow[],
  streamRows: [{
    __id__: 7,
    __geom__: pointWkb(2, 48),
    p_0: 'Paris',
    p_1: new Uint8Array([1, 2])
  }] as QueryRow[]
}

class FakeMssqlRequest {
  readonly inputs: QueryRow = {}
  readonly queries: Array<{ sql: string, inputs: QueryRow }> = []

  input(name: string, value: unknown): this {
    this.inputs[name] = value
    return this
  }

  async query(sqlText: string): Promise<{ recordset: QueryRow[] }> {
    this.queries.push({ sql: sqlText, inputs: { ...this.inputs } })
    return { recordset: mssqlRowsFor(sqlText) }
  }
}

class FakeMssqlPool {
  static instances: FakeMssqlPool[] = []

  readonly requests: FakeMssqlRequest[] = []
  connected = false
  closed = false

  constructor(readonly config: unknown) {
    FakeMssqlPool.instances.push(this)
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  request(): FakeMssqlRequest {
    const request = new FakeMssqlRequest()
    this.requests.push(request)
    return request
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

beforeEach(() => {
  vi.resetModules()
  fakeMssql.ConnectionPool = FakeMssqlPool
  FakeMssqlPool.instances = []
  mssqlState.columns = [
    { columnName: 'id', dataType: 'int' },
    { columnName: 'geom', dataType: 'geometry' },
    { columnName: 'name', dataType: 'nvarchar' },
    { columnName: 'payload', dataType: 'varbinary' }
  ]
  mssqlState.primaryKeyRows = [{ columnName: 'id' }]
  mssqlState.sridRows = [{ srid: 4326 }]
  mssqlState.extentRows = [{ __extent__: polygonWkb([[1, 2], [3, 2], [3, 4], [1, 4], [1, 2]]) }]
  mssqlState.readRows = [{ __id__: 7, __geom__: pointWkb(2, 48), p_0: 'Paris' }]
  mssqlState.streamRows = [{
    __id__: 7,
    __geom__: pointWkb(2, 48),
    p_0: 'Paris',
    p_1: new Uint8Array([1, 2])
  }]
})

describe('MssqlSource', () => {
  it('streams features with database sourceRef and closes resources', async () => {
    vi.doMock('mssql', () => ({
      default: fakeMssql
    }))

    const { MssqlSource } = await import('../../src/source/mssql-source.js')
    const source = new MssqlSource('mssql-test', {
      connection: {
        server: 'localhost',
        port: 1433,
        database: 'geocdb',
        user: 'geocuser',
        password: 'secret',
        encrypt: false,
        trustServerCertificate: true
      },
      schema: 'geoc',
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
      name: 'Paris',
      payload: 'AQI='
    })
    expect(features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [2, 48]
    })
    expect(features[0].sourceRef).toEqual({
      storage: 'database',
      sourceId: 'mssql-test',
      schemaName: 'geoc',
      tableName: 'cities',
      rowId: 7,
      primaryKey: 'id',
      geometryColumn: 'geom',
      recordIndex: 0
    })

    await source.close()
    expect(FakeMssqlPool.instances[0].closed).toBe(true)
  })

  it('uses exact extent, readById and config helpers', async () => {
    vi.doMock('mssql', () => ({
      default: fakeMssql
    }))

    const { MssqlSource } = await import('../../src/source/mssql-source.js')

    expect(MssqlSource.acceptsConfig({ type: 'mssql' })).toBe(true)
    expect(MssqlSource.acceptsConfig({ type: 'postgis' })).toBe(false)

    const source = MssqlSource.fromConfig('mssql-config-test', {
      type: 'mssql',
      title: 'MSSQL title',
      abstract: 'MSSQL abstract',
      connection: {
        host: 'localhost',
        port: 1433,
        database: 'geocdb',
        user: 'geocuser',
        password: 'secret',
        poolMin: 0,
        poolMax: 2,
        connectionTimeoutMillis: 3,
        requestTimeoutMillis: 4,
        encrypt: false,
        trustServerCertificate: true
      },
      schema: 'geoc',
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

    expect(source.title).toBe('MSSQL title')
    expect(FakeMssqlPool.instances[0].config).toMatchObject({
      server: 'localhost',
      port: 1433,
      database: 'geocdb',
      user: 'geocuser',
      password: 'secret',
      connectionTimeout: 3,
      requestTimeout: 4,
      pool: {
        min: 0,
        max: 2
      },
      options: {
        encrypt: false,
        trustServerCertificate: true
      }
    })
    await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 3, 4])
    await expect(source.readById('7', { layer })).resolves.toMatchObject({
      id: 7,
      properties: { name: 'Paris' },
      sourceRef: {
        storage: 'database',
        sourceId: 'mssql-config-test',
        schemaName: 'geoc',
        tableName: 'cities',
        rowId: 7
      }
    })

    await source.close()
  })

  it('parses URI connection strings and connectionString object options', async () => {
    vi.doMock('mssql', () => ({
      default: fakeMssql
    }))

    const { MssqlSource } = await import('../../src/source/mssql-source.js')
    const source = new MssqlSource('mssql-url-test', {
      connection: {
        connectionString: 'mssql://geo%20user:geo%20pass@localhost:1433/geocdb',
        poolMin: 0,
        poolMax: 2,
        connectionTimeoutMillis: 3,
        requestTimeoutMillis: 4
      },
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id'
        }
      }
    })

    await source.open()

    expect(FakeMssqlPool.instances[0].config).toMatchObject({
      server: 'localhost',
      port: 1433,
      database: 'geocdb',
      user: 'geo user',
      password: 'geo pass',
      connectionTimeout: 3,
      requestTimeout: 4,
      pool: {
        min: 0,
        max: 2
      },
      options: {
        encrypt: false,
        trustServerCertificate: true
      }
    })

    await source.close()
  })

  it('covers extent none, sourceRef validation and requested property errors', async () => {
    vi.doMock('mssql', () => ({
      default: fakeMssql
    }))

    const { MssqlSource } = await import('../../src/source/mssql-source.js')
    const source = new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      schema: 'geoc',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id',
          properties: ['name']
        }
      },
      extentStrategy: 'none'
    })

    await source.open()

    await expect(source.getExtent(layer)).resolves.toBeNull()
    await expect(readAll(source.query({ layer, properties: ['missing'] }))).rejects.toThrow('property column "missing"')
    await expect(source.read({
      storage: 'mem',
      sourceId: 'mssql-test',
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
      sourceId: 'mssql-test',
      schemaName: 'other',
      tableName: 'cities',
      rowId: 7
    }, { layer })).rejects.toThrow('targets schema')
    await expect(source.read({
      storage: 'database',
      sourceId: 'mssql-test',
      tableName: 'other',
      rowId: 7
    }, { layer })).rejects.toThrow('targets table')

    await source.close()
  })

  it('cleans up when open fails and reports metadata errors', async () => {
    vi.doMock('mssql', () => ({
      default: fakeMssql
    }))

    const { MssqlSource } = await import('../../src/source/mssql-source.js')

    mssqlState.columns = []
    await expect(new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('was not found')
    expect(FakeMssqlPool.instances.at(-1)?.closed).toBe(true)

    mssqlState.columns = [{ columnName: 'id', dataType: 'int' }]
    await expect(new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('no geometry column')

    mssqlState.columns = [
      { columnName: 'id', dataType: 'int' },
      { columnName: 'geom', dataType: 'geometry' },
      { columnName: 'geom2', dataType: 'geometry' }
    ]
    await expect(new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('multiple geometry columns')

    mssqlState.columns = [
      { columnName: 'id', dataType: 'int' },
      { columnName: 'geom', dataType: 'varbinary' }
    ]
    await expect(new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      datasets: { cities: { tableName: 'cities', geometryColumn: 'geom' } }
    }).open()).rejects.toThrow('not a geometry/geography column')

    mssqlState.columns = [
      { columnName: 'id', dataType: 'int' },
      { columnName: 'geom', dataType: 'geometry' }
    ]
    mssqlState.primaryKeyRows = []
    await expect(new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('has no primary key')

    mssqlState.primaryKeyRows = [{ columnName: 'id' }, { columnName: 'other' }]
    await expect(new MssqlSource('mssql-test', {
      connection: 'mssql://geocuser:secret@localhost:1433/geocdb',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('composite primary key')

    await expect(new MssqlSource('invalid-url-test', {
      connection: 'Server=localhost',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('Invalid MSSQL GeoComposer connection string')
  })
})

function mssqlRowsFor(sqlText: string): QueryRow[] {
  if (sqlText === 'SELECT 1') return [{ '': 1 }]
  if (sqlText.includes('FROM sys.columns')) return mssqlState.columns
  if (sqlText.includes('FROM sys.indexes')) return mssqlState.primaryKeyRows
  if (sqlText.includes('.STSrid AS srid')) return mssqlState.sridRows
  if (sqlText.includes('EnvelopeAggregate')) return mssqlState.extentRows
  if (sqlText.includes('WHERE [id] = @featureKey')) return mssqlState.readRows
  if (sqlText.includes('OFFSET @__offset__ ROWS')) return mssqlState.streamRows

  return []
}

function pointWkb(x: number, y: number): Uint8Array {
  const buffer = Buffer.alloc(21)
  buffer[0] = 1
  buffer.writeUInt32LE(1, 1)
  buffer.writeDoubleLE(x, 5)
  buffer.writeDoubleLE(y, 13)
  return buffer
}

function polygonWkb(points: Array<[number, number]>): Uint8Array {
  const buffer = Buffer.alloc(13 + points.length * 16)
  buffer[0] = 1
  buffer.writeUInt32LE(3, 1)
  buffer.writeUInt32LE(1, 5)
  buffer.writeUInt32LE(points.length, 9)
  let offset = 13

  for (const [x, y] of points) {
    buffer.writeDoubleLE(x, offset)
    buffer.writeDoubleLE(y, offset + 8)
    offset += 16
  }

  return buffer
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
