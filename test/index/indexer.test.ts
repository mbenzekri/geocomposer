import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Crs } from '../../src/core/crs.js'
import { Indexer, parseFileIndexHeader } from '../../src/index/indexer.js'
import { IndexRecord } from '../../src/index/index-record.js'
import { IndexRtree } from '../../src/index/index-rtree.js'
import { Layer } from '../../src/layer/layer.js'
import { GeoJsonSource } from '../../src/source/geojson-source.js'
import { Source } from '../../src/source/source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'
import { init } from '../test-tools.js'

let tmpDir: string
let openedSources: GeoJsonSource[] = []

beforeEach(() => {
  init()
  setupRegistries()
  openedSources = []
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-'))
})

afterEach(async () => {
  await Promise.allSettled(openedSources.reverse().map((source) => source.close()))
  fs.rmSync(tmpDir, {
    recursive: true,
    force: true
  })
})

async function openSource(source: GeoJsonSource): Promise<GeoJsonSource> {
  await source.open()
  openedSources.push(source)
  return source
}

describe('Indexer', () => {
  it('builds and loads record and rtree indexes for a file source', async () => {
    const geojsonPath = writeGeoJson('cities.geojson', [
      featureJson('a', [1, 2]),
      featureJson('b', [3, 4])
    ])
    const source = registerSource(await openSource(new GeoJsonSource('cities', geojsonPath, 'utf8', 16)))
    const layer = new Layer('cities', { source: source.id, crs: 'EPSG:4326' })

    expect(Indexer.resolveIndexPath(layer)).toBe(`${geojsonPath}.idx`)

    const record = await new Indexer(layer).build()
    const indexBuffer = fs.readFileSync(record.path)
    const header = parseFileIndexHeader(indexBuffer)

    expect(record).toMatchObject({
      path: `${geojsonPath}.idx`,
      sourceId: 'cities',
      recordCount: 2
    })
    expect(header.map((entry) => entry.name)).toEqual([IndexRecord.NAME, IndexRtree.NAME])
    expect(layer.indexes.get(IndexRecord.NAME)).toBe(record)
    expect(layer.indexes.get(IndexRtree.NAME)).toBeInstanceOf(IndexRtree)

    layer.indexes.clear()
    const loaded = await new Indexer(layer).load()

    expect(loaded.recordCount).toBe(2)
    expect(layer.indexes.get(IndexRecord.NAME)).toBe(loaded)
    expect(layer.indexes.get(IndexRtree.NAME)).toBeInstanceOf(IndexRtree)
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

function featureJson(id: string, coordinates: [number, number]): Record<string, unknown> {
  return {
    type: 'Feature',
    id,
    properties: { id },
    geometry: {
      type: 'Point',
      coordinates
    }
  }
}
