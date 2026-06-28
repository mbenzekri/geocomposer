import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../../src/core/tools.js'
import type { Layer } from '../../src/layer/layer.js'
import type { Index } from '../../src/index/index.js'
import { Indexer } from '../../src/index/file-indexer.js'
import { IndexRtree } from '../../src/index/index-rtree.js'
import { CsvSource } from '../../src/source/csv-source.js'

const layer = {
  id: 'csv-layer',
  crs: 'EPSG:4326'
} as Layer

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-source-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {
    recursive: true,
    force: true
  })
})

describe('CsvSource', () => {
  it('accepts csv config entries and creates a source from config', () => {
    expect(CsvSource.acceptsConfig({
      type: 'csv',
      path: 'data.csv'
    })).toBe(true)
    expect(CsvSource.acceptsConfig({ type: 'geojson', path: 'data.geojson' })).toBe(false)
    expect(CsvSource.acceptsConfig(null)).toBe(false)

    const source = CsvSource.fromConfig('cities', {
      type: 'csv',
      path: 'cities.csv',
      geometryColumn: 'geom',
      primaryKey: 'code',
      delimiter: ';',
      indexes: true
    })

    expect(source.id).toBe('cities')
    expect(source.type).toBe('csv')
    expect(source.storage).toBe('file')
    expect(source.indexes).toBe(true)
    expect(source.getFiles()).toEqual([{ role: 'data', path: 'cities.csv' }])
  })

  it('streams typed properties and WKT geometries with file sourceRefs', async () => {
    const file = writeFile('cities.csv', [
      'id,name,population,active,empty,geometry',
      'a,Paris,2148000,true,,"POINT (2.35 48.85)"',
      'b,"Quoted, city",42,false,,"LINESTRING (0 0, 1 1)"'
    ].join('\n'))
    const source = new CsvSource('cities', file, { highWaterMark: 7 })
    const result = await readAll(source.stream({ layer }))

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      type: 'Feature',
      id: 'a',
      layer,
      crs: 'EPSG:4326',
      properties: {
        id: 'a',
        name: 'Paris',
        population: 2148000,
        active: true,
        empty: null
      },
      geometry: {
        type: 'Point',
        coordinates: [2.35, 48.85]
      },
      sourceRef: {
        storage: 'file',
        sourceId: 'cities',
        recordIndex: 0,
        offset: expect.any(Number),
        byteLength: expect.any(Number)
      }
    })
    expect(result[0].properties).not.toHaveProperty('geometry')
    expect(result[1]).toMatchObject({
      id: 'b',
      properties: {
        name: 'Quoted, city',
        population: 42,
        active: false
      },
      geometry: {
        type: 'LineString',
        coordinates: [[0, 0], [1, 1]]
      }
    })
  })

  it('reads features by sourceRef and supports custom columns', async () => {
    const file = writeFile('custom.csv', [
      'code;label;geom',
      'p1;Point 1;POINT (1 2)'
    ].join('\n'))
    const source = new CsvSource('custom', file, {
      delimiter: ';',
      primaryKey: 'code',
      geometryColumn: 'geom'
    })
    const [feature] = await readAll(source.stream({ layer }))
    const read = await source.read(feature.sourceRef!, { layer })

    expect(read).toEqual(feature)
  })

  it('converts homogeneous GeometryCollections and nulls mixed collections', async () => {
    const file = writeFile('collections.csv', [
      'id,geometry',
      'points,"GEOMETRYCOLLECTION (POINT (1 2), POINT (3 4))"',
      'mixed,"GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))"'
    ].join('\n'))
    const source = new CsvSource('collections', file)
    const result = await readAll(source.stream({ layer }))

    expect(result[0].geometry).toEqual({
      type: 'MultiPoint',
      coordinates: [[1, 2], [3, 4]]
    })
    expect(result[1].geometry).toBeNull()
  })

  it('builds record and rtree indexes', async () => {
    const file = writeFile('indexed.csv', [
      'id,geometry',
      'a,POINT (1 2)',
      'b,POINT (3 4)'
    ].join('\n'))
    const source = new CsvSource('indexed', file)
    const csvLayer = {
      id: 'indexed-layer',
      crs: 'EPSG:4326',
      source,
      indexes: new Registry<Index<any>>('INDEX'),
      stream(options = {}) {
        return source.stream({ ...options, layer: this as unknown as Layer })
      }
    } as unknown as Layer
    const index = await new Indexer(csvLayer).build()
    const rtree = csvLayer.indexes.get('rtree') as IndexRtree

    expect(index.path).toBe(`${file}.idx`)
    expect(index.recordCount).toBe(2)
    await expect(index.get(1)).resolves.toMatchObject({ id: 'b' })
    expect(await readAll(rtree.stream([0, 0, 2, 3]))).toHaveLength(1)
  })

  it('throws when the geometry column is missing', async () => {
    const file = writeFile('invalid.csv', [
      'id,wkt',
      'a,POINT (1 2)'
    ].join('\n'))
    const source = new CsvSource('invalid', file)

    await expect(readAll(source.stream({ layer })))
      .rejects.toThrow('CSV source "invalid" missing geometryColumn "geometry"')
  })
})

function writeFile(name: string, content: string): string {
  const file = path.join(tmpDir, name)
  fs.writeFileSync(file, content)
  return file
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
