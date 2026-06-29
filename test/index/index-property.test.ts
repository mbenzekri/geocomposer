import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Crs } from '../../src/core/crs.js'
import { Indexer, findHeaderEntry, parseFileIndexHeader } from '../../src/index/indexer.js'
import { IndexProperty } from '../../src/index/index-property.js'
import { Layer } from '../../src/layer/layer.js'
import { GeoJsonSource } from '../../src/source/geojson-source.js'
import { Source } from '../../src/source/source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'
import { init } from '../test-tools.js'

let tmpDir: string

beforeEach(() => {
  init()
  setupRegistries()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-property-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {
    recursive: true,
    force: true
  })
})

describe('IndexProperty', () => {
  it('builds a uint32 record-order index and streams matching records by binary-search criteria', async () => {
    const geojsonPath = writeGeoJson('property-indexed.geojson', [
      featureJson('low', [0, 0], { rank: 1, name: 'A' }),
      featureJson('high', [1, 1], { rank: 9, name: 'C' }),
      featureJson('mid-a', [2, 2], { rank: 5, name: 'B' }),
      featureJson('missing', [3, 3], { name: 'D' }),
      featureJson('mid-b', [4, 4], { rank: 5, name: 'E' })
    ])
    const source = registerSource(new GeoJsonSource('property-indexed', geojsonPath, 'utf8', 16, undefined, {
      indexes: { properties: ['rank'] }
    }))
    const layer = new Layer('property-indexed', { source: source.id, crs: 'EPSG:4326' })

    const record = await new Indexer(layer).build()
    const indexBuffer = fs.readFileSync(record.path)
    const propertyEntry = findHeaderEntry(
      parseFileIndexHeader(indexBuffer),
      IndexProperty.indexName('rank'),
      'File index does not contain rank index'
    )

    expect(propertyEntry).toEqual({
      name: IndexProperty.indexName('rank'),
      offset: expect.any(Number),
      byteLength: 4 * IndexProperty.ENTRY_SIZE,
      recordCount: 4,
      entrySize: IndexProperty.ENTRY_SIZE
    })
    expect([
      indexBuffer.readUInt32LE(propertyEntry.offset),
      indexBuffer.readUInt32LE(propertyEntry.offset + 4),
      indexBuffer.readUInt32LE(propertyEntry.offset + 8),
      indexBuffer.readUInt32LE(propertyEntry.offset + 12)
    ]).toEqual([0, 2, 4, 1])

    const propertyIndex = layer.indexes.get(IndexProperty.indexName('rank')) as IndexProperty
    expect(propertyIndex).toBeInstanceOf(IndexProperty)
    await expect(collect(propertyIndex.stream({ property: 'rank', op: '==', value: 5 })))
      .resolves.toMatchObject([{ id: 'mid-a' }, { id: 'mid-b' }])
    await expect(collect(propertyIndex.stream({ property: 'rank', op: '<', value: 6 })))
      .resolves.toMatchObject([{ id: 'low' }, { id: 'mid-a' }, { id: 'mid-b' }])
    await expect(collect(propertyIndex.stream({ property: 'rank', op: '>', value: 5 })))
      .resolves.toMatchObject([{ id: 'high' }])
    await expect(collect(propertyIndex.stream({ property: 'rank', op: '==', value: {} })))
      .resolves.toEqual([])
    expect(() => propertyIndex.stream()).toThrow('IndexProperty.stream requires property criteria')
    expect(() => propertyIndex.stream({ property: 'other', op: '==', value: 5 }))
      .toThrow('IndexProperty "rank" cannot query property "other"')
  })

  it('loads from the file index and is selected by Layer.query without scanning the source', async () => {
    const geojsonPath = writeGeoJson('property-query.geojson', [
      featureJson('low', [0, 0], { rank: 1 }),
      featureJson('high', [1, 1], { rank: 9 }),
      featureJson('mid-a', [2, 2], { rank: 5 }),
      featureJson('mid-b', [4, 4], { rank: 5 })
    ])
    const source = registerSource(new GeoJsonSource('property-query', geojsonPath, 'utf8', 16, undefined, {
      indexes: { properties: ['rank'] }
    }))
    const layer = new Layer('property-query', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    layer.indexes.clear()
    await new Indexer(layer).load()
    source.stream = vi.fn(() => {
      throw new Error('full stream should not be used')
    })

    await expect(collect(layer.query({
      bbox: [1.5, 1.5, 5, 5],
      propertyFilter: { property: 'rank', op: '==', value: 5 },
      limit: 1
    }))).resolves.toMatchObject([{ id: 'mid-a' }])
    expect(source.stream).not.toHaveBeenCalled()
  })

  it('falls back to property filtering when no property index is loaded', async () => {
    const geojsonPath = writeGeoJson('property-scan.geojson', [
      featureJson('low', [0, 0], { rank: 1 }),
      featureJson('mid', [1, 1], { rank: 5 }),
      featureJson('high', [2, 2], { rank: 9 })
    ])
    const source = registerSource(new GeoJsonSource('property-scan', geojsonPath, 'utf8', 16))
    const layer = new Layer('property-scan', { source: source.id, crs: 'EPSG:4326' })

    await expect(collect(layer.query({
      propertyFilter: { property: 'rank', op: '>', value: 1 },
      limit: 1
    }))).resolves.toMatchObject([{ id: 'mid' }])
  })

  it('rejects mixed comparable property types', async () => {
    const geojsonPath = writeGeoJson('property-mixed.geojson', [
      featureJson('number', [0, 0], { rank: 1 }),
      featureJson('string', [1, 1], { rank: '2' })
    ])
    const source = registerSource(new GeoJsonSource('property-mixed', geojsonPath, 'utf8', 16, undefined, {
      indexes: { properties: ['rank'] }
    }))
    const layer = new Layer('property-mixed', { source: source.id, crs: 'EPSG:4326' })

    await expect(new Indexer(layer).build())
      .rejects.toThrow('Property index "rank" cannot mix number and string values')
  })

  it('rejects invalid property index names and corrupt buffers', async () => {
    const geojsonPath = writeGeoJson('property-corrupt.geojson', [
      featureJson('one', [0, 0], { rank: 1 })
    ])
    const source = registerSource(new GeoJsonSource('property-corrupt', geojsonPath, 'utf8', 16, undefined, {
      indexes: { properties: ['rank'] }
    }))
    const layer = new Layer('property-corrupt', { source: source.id, crs: 'EPSG:4326' })
    const record = await new Indexer(layer).build()

    expect(() => IndexProperty.propertyFromIndexName('rank'))
      .toThrow('Invalid property index name "rank"')

    const entry = {
      name: IndexProperty.indexName('rank'),
      offset: 0,
      byteLength: 4,
      recordCount: 1,
      entrySize: IndexProperty.ENTRY_SIZE
    }
    const emptyBuffer = new IndexProperty(layer, record, 'rank', Buffer.alloc(0), entry)
    await expect(collect(emptyBuffer.stream({ property: 'rank', op: '==', value: 1 })))
      .rejects.toThrow('Invalid property index "rank": entry exceeds buffer length')

    const invalidEntrySize = new IndexProperty(layer, record, 'rank', Buffer.alloc(4), {
      ...entry,
      byteLength: 4,
      entrySize: 2
    })
    await expect(collect(invalidEntrySize.stream({ property: 'rank', op: '==', value: 1 })))
      .rejects.toThrow('Invalid property index "rank": entry exceeds buffer length')
  })
})

function registerSource<T extends Source>(source: T): T {
  Source.registry.set(source.id, source)
  return source
}

const defaultStyle: StyleFn = () => null

function setupRegistries(): void {
  Crs.registry.set('EPSG:4326', new Crs('EPSG:4326', 'WGS 84', 'WGS 84'))
  Style.registry.set('default', { id: 'default', style: defaultStyle })
}

function writeGeoJson(name: string, features: Record<string, unknown>[]): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, JSON.stringify({
    type: 'FeatureCollection',
    features
  }))
  return filePath
}

function featureJson(id: string, coordinates: [number, number], properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'Feature',
    id,
    properties,
    geometry: {
      type: 'Point',
      coordinates
    }
  }
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
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
