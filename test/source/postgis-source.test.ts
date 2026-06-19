import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layer } from '../../src/layer/layer.js'

type QueryRow = Record<string, unknown>

const layer = {
  id: 'cities-layer',
  dataset: 'cities',
  crs: 'EPSG:4326'
} as Layer

const postgisState = {
  columns: [
    { column_name: 'id' },
    { column_name: 'geom' },
    { column_name: 'name' },
    { column_name: 'payload' }
  ] as QueryRow[],
  geometryRows: [{ f_geometry_column: 'geom' }] as QueryRow[],
  geometryExists: true,
  primaryKeyRows: [{ column_name: 'id' }] as QueryRow[],
  sridRows: [{ srid: 4326 }] as QueryRow[],
  estimatedExtentRows: [{ min_x: 1, min_y: 2, max_x: 3, max_y: 4 }] as QueryRow[],
  exactExtentRows: [{ min_x: '1', min_y: 2n, max_x: 3, max_y: 4 }] as QueryRow[],
  readRows: [{ __id__: 7, __geom__: pointWkb(2, 48), p_0: 'Paris' }] as QueryRow[]
}

class FakePostgisCursor {
  static rows: QueryRow[] = []

  readonly sql: string
  readonly params: unknown[]
  private offset = 0
  closed = false

  constructor(sql: string, params: unknown[]) {
    this.sql = sql
    this.params = params
  }

  async read(size: number): Promise<QueryRow[]> {
    const rows = FakePostgisCursor.rows.slice(this.offset, this.offset + size)
    this.offset += rows.length
    return rows
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakePostgisClient {
  released = false
  readonly queries: Array<{ sql: string, params: unknown[] }> = []

  query(input: string | FakePostgisCursor, params: unknown[] = []): Promise<{ rows: QueryRow[] }> | FakePostgisCursor {
    if (input instanceof FakePostgisCursor) return input

    this.queries.push({ sql: input, params })
    return Promise.resolve({ rows: postgisRowsFor(input) })
  }

  release(): void {
    this.released = true
  }
}

class FakePostgisPool {
  static instances: FakePostgisPool[] = []

  readonly config: unknown
  readonly clients: FakePostgisClient[] = []
  readonly queries: Array<{ sql: string, params: unknown[] }> = []
  ended = false

  constructor(config: unknown) {
    this.config = config
    FakePostgisPool.instances.push(this)
  }

  async connect(): Promise<FakePostgisClient> {
    const client = new FakePostgisClient()
    this.clients.push(client)
    return client
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: QueryRow[] }> {
    this.queries.push({ sql, params })
    return { rows: postgisRowsFor(sql) }
  }

  async end(): Promise<void> {
    this.ended = true
  }
}

beforeEach(() => {
  vi.resetModules()
  FakePostgisPool.instances = []
  FakePostgisCursor.rows = []
  postgisState.columns = [
    { column_name: 'id' },
    { column_name: 'geom' },
    { column_name: 'name' },
    { column_name: 'payload' }
  ]
  postgisState.geometryRows = [{ f_geometry_column: 'geom' }]
  postgisState.geometryExists = true
  postgisState.primaryKeyRows = [{ column_name: 'id' }]
  postgisState.sridRows = [{ srid: 4326 }]
  postgisState.estimatedExtentRows = [{ min_x: 1, min_y: 2, max_x: 3, max_y: 4 }]
  postgisState.exactExtentRows = [{ min_x: '1', min_y: 2n, max_x: 3, max_y: 4 }]
  postgisState.readRows = [{ __id__: 7, __geom__: pointWkb(2, 48), p_0: 'Paris' }]
})

describe('PostgisSource', () => {
  it('streams features with database sourceRef and closes resources', async () => {
    vi.doMock('pg', () => ({
      default: { Pool: FakePostgisPool },
      Pool: FakePostgisPool
    }))
    vi.doMock('pg-cursor', () => ({
      default: FakePostgisCursor
    }))

    const { PostgisSource } = await import('../../src/source/postgis-source.js')
    const source = new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      schema: 'public',
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

    FakePostgisCursor.rows = [{
      __id__: 7,
      __geom__: pointWkb(2, 48),
      p_0: 'Paris',
      p_1: new Uint8Array([1, 2])
    }]

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
      sourceId: 'postgis-test',
      schemaName: 'public',
      tableName: 'cities',
      rowId: 7,
      primaryKey: 'id',
      geometryColumn: 'geom',
      recordIndex: 0
    })

    await source.close()
    expect(FakePostgisPool.instances[0].ended).toBe(true)
  })

  it('uses estimated extent and readById queries', async () => {
    vi.doMock('pg', () => ({
      default: { Pool: FakePostgisPool },
      Pool: FakePostgisPool
    }))
    vi.doMock('pg-cursor', () => ({
      default: FakePostgisCursor
    }))

    const { PostgisSource } = await import('../../src/source/postgis-source.js')
    const source = new PostgisSource('postgis-test', {
      connection: { connectionString: 'postgres://user:pass@localhost:5432/db', applicationName: 'tests' },
      schema: 'public',
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
      properties: { name: 'Paris' },
      sourceRef: {
        storage: 'database',
        sourceId: 'postgis-test',
        schemaName: 'public',
        tableName: 'cities',
        rowId: 7
      }
    })

    await source.close()
  })

  it('supports config helpers, automatic metadata and full stream/read paths', async () => {
    vi.doMock('pg', () => ({
      default: { Pool: FakePostgisPool },
      Pool: FakePostgisPool
    }))
    vi.doMock('pg-cursor', () => ({
      default: FakePostgisCursor
    }))

    const { PostgisSource } = await import('../../src/source/postgis-source.js')

    expect(PostgisSource.acceptsConfig({ type: 'postgis' })).toBe(true)
    expect(PostgisSource.acceptsConfig({ type: 'oracle' })).toBe(false)

    const source = PostgisSource.fromConfig('postgis-config-test', {
      type: 'postgis',
      title: 'PostGIS title',
      abstract: 'PostGIS abstract',
      connection: {
        host: 'localhost',
        port: 5432,
        database: 'db',
        user: 'user',
        password: 'pass',
        ssl: false,
        max: 2,
        connectionTimeoutMillis: 1,
        idleTimeoutMillis: 2,
        statementTimeoutMillis: 3,
        queryTimeoutMillis: 4,
        applicationName: 'unit'
      },
      datasets: { cities: 'cities' },
      extentStrategy: 'exact'
    })

    FakePostgisCursor.rows = [{
      __id__: BigInt(Number.MAX_SAFE_INTEGER) + 5n,
      __geom__: null,
      p_0: BigInt(Number.MAX_SAFE_INTEGER) + 6n,
      p_1: 'Paris',
      p_2: new DataView(new Uint8Array([4, 5]).buffer)
    }]
    postgisState.readRows = []

    await source.open()
    await source.open()

    expect(source.title).toBe('PostGIS title')
    expect(FakePostgisPool.instances[0].config).toMatchObject({
      host: 'localhost',
      port: 5432,
      database: 'db',
      user: 'user',
      password: 'pass',
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 1,
      idleTimeoutMillis: 2,
      statement_timeout: 3,
      query_timeout: 4,
      application_name: 'unit'
    })
    await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 3, 4])

    const features = await readAll(source.stream({ layer }))
    expect(features[0]).toMatchObject({
      id: String(BigInt(Number.MAX_SAFE_INTEGER) + 5n),
      geometry: null,
      properties: {
        id: String(BigInt(Number.MAX_SAFE_INTEGER) + 6n),
        name: 'Paris',
        payload: 'BAU='
      }
    })

    await expect(source.read(features[0].sourceRef!, { layer })).resolves.toBeNull()

    await source.close()
    await source.close()
  })

  it('covers extent none, sourceRef validation and requested property errors', async () => {
    vi.doMock('pg', () => ({
      default: { Pool: FakePostgisPool },
      Pool: FakePostgisPool
    }))
    vi.doMock('pg-cursor', () => ({
      default: FakePostgisCursor
    }))

    const { PostgisSource } = await import('../../src/source/postgis-source.js')
    const source = new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
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
    await expect(readAll(source.query({ layer, properties: ['missing'] }))).rejects.toThrow('Invalid PostGIS source property column')
    await expect(source.read({
      storage: 'mem',
      sourceId: 'postgis-test',
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
      sourceId: 'postgis-test',
      schemaName: 'other',
      tableName: 'cities',
      rowId: 7
    }, { layer })).rejects.toThrow('targets schema')
    await expect(source.read({
      storage: 'database',
      sourceId: 'postgis-test',
      tableName: 'other',
      rowId: 7
    }, { layer })).rejects.toThrow('targets table')
    await expect(source.query({ layer: { ...layer, dataset: 'missing' } as Layer }).getReader().read()).rejects.toThrow('Item missing not found')

    await source.close()
  })

  it('cleans up when open fails and reports metadata errors', async () => {
    vi.doMock('pg', () => ({
      default: { Pool: FakePostgisPool },
      Pool: FakePostgisPool
    }))
    vi.doMock('pg-cursor', () => ({
      default: FakePostgisCursor
    }))

    const { PostgisSource } = await import('../../src/source/postgis-source.js')

    postgisState.columns = []
    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('was not found')
    expect(FakePostgisPool.instances.at(-1)?.ended).toBe(true)

    postgisState.columns = [{ column_name: 'id' }, { column_name: 'geom' }]
    postgisState.geometryRows = []
    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('no geometry column')

    postgisState.geometryRows = [{ f_geometry_column: 'geom' }, { f_geometry_column: 'geom2' }]
    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('multiple geometry columns')

    postgisState.geometryRows = [{ f_geometry_column: 'geom' }]
    postgisState.geometryExists = false
    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: { tableName: 'cities', geometryColumn: 'geom' } }
    }).open()).rejects.toThrow('not registered')

    postgisState.geometryExists = true
    postgisState.primaryKeyRows = []
    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('has no primary key')

    postgisState.primaryKeyRows = [{ column_name: 'id' }, { column_name: 'other' }]
    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: 'cities' }
    }).open()).rejects.toThrow('composite primary key')

    await expect(new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: { tableName: 'cities', primaryKey: 'missing' } }
    }).open()).rejects.toThrow('primary key "missing"')

    expect(() => new PostgisSource('postgis-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: { cities: { tableName: '' } }
    })).toThrow('tableName must not be empty')
  })

  it('covers null reads, geometry buffers, aborts and numeric fallbacks', async () => {
    vi.doMock('pg', () => ({
      default: { Pool: FakePostgisPool },
      Pool: FakePostgisPool
    }))
    vi.doMock('pg-cursor', () => ({
      default: FakePostgisCursor
    }))

    const { PostgisSource } = await import('../../src/source/postgis-source.js')
    const source = new PostgisSource('postgis-extra-test', {
      connection: 'postgres://user:pass@localhost:5432/db',
      datasets: {
        cities: {
          tableName: 'cities',
          geometryColumn: 'geom',
          primaryKey: 'id',
          properties: ['name', 'payload']
        }
      },
      extentStrategy: 'estimated'
    })

    postgisState.sridRows = [{ srid: 0 }]
    postgisState.estimatedExtentRows = [{ min_x: null, min_y: 2, max_x: 3, max_y: 4 }]
    postgisState.readRows = [{
      __id__: undefined,
      __geom__: exactArrayBuffer(pointWkb(3, 4)),
      p_0: 5n,
      p_1: exactArrayBuffer(new Uint8Array([9, 10]))
    }]

    await source.open()
    await expect(source.getExtent(layer)).resolves.toBeNull()
    await expect(source.readById('missing', { layer })).resolves.toMatchObject({
      id: 0,
      properties: {
        name: 5,
        payload: 'CQo='
      },
      geometry: {
        type: 'Point',
        coordinates: [3, 4]
      }
    })

    postgisState.readRows = []
    await expect(source.readById('missing', { layer })).resolves.toBeNull()

    postgisState.readRows = [{
      __id__: 'bad',
      __geom__: Buffer.concat([pointWkb(1, 2), Buffer.from([0])]),
      p_0: 'bad',
      p_1: null
    }]
    await expect(source.readById('bad', { layer })).rejects.toThrow('trailing bytes')

    FakePostgisCursor.rows = [{ __id__: 1, __geom__: pointWkb(1, 2), p_0: 'Paris', p_1: null }]
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(source.query({ layer, signal: controller.signal }).getReader().read()).rejects.toThrow('stop')

    FakePostgisCursor.rows = []
    await expect(readAll(source.query({ layer: { ...layer, crs: 'CRS:84' } as Layer, bbox: [1, 2, 3, 4] }))).resolves.toEqual([])

    await source.close()
  })
})

function postgisRowsFor(sql: string): QueryRow[] {
  if (sql === 'SELECT 1') return [{ '?column?': 1 }]

  if (sql.includes('FROM information_schema.columns')) {
    return postgisState.columns
  }

  if (sql.includes('SELECT EXISTS')) return [{ exists: postgisState.geometryExists }]
  if (sql.includes('FROM geometry_columns') && sql.includes('f_geometry_column')) return postgisState.geometryRows
  if (sql.includes('FROM information_schema.table_constraints')) return postgisState.primaryKeyRows
  if (sql.includes('Find_SRID')) return postgisState.sridRows
  if (sql.includes('ST_EstimatedExtent')) return postgisState.estimatedExtentRows
  if (sql.includes('ST_Extent')) return postgisState.exactExtentRows
  if (sql.includes('WHERE "id" = $1')) return postgisState.readRows

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
