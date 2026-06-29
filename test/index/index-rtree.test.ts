import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import { Crs } from '../../src/core/crs.js'
import { Indexer } from '../../src/index/indexer.js'
import { IndexRtree } from '../../src/index/index-rtree.js'
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-rtree-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {
    recursive: true,
    force: true
  })
})

describe('IndexRtree', () => {
  it('streams records whose feature bbox intersects the query bbox', async () => {
    const geojsonPath = writeGeoJson('rtree.geojson', [
      featureJson('inside', [1, 2]),
      featureJson('outside', [10, 11]),
      featureJson('edge', [2, 3])
    ])
    const source = registerSource(new GeoJsonSource('rtree', geojsonPath, 'utf8', 16))
    const layer = new Layer('rtree', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    const rtree = layer.indexes.get(IndexRtree.NAME) as IndexRtree

    expect(rtree).toBeInstanceOf(IndexRtree)
    expect(materializeBbox(await collect(rtree.stream([0, 0, 2, 3]))))
      .toMatchObject([{ id: 'inside' }, { id: 'edge' }])
    expect(() => rtree.stream())
      .toThrow('IndexRtree.stream requires a bbox')
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

function materializeBbox(features: Feature[]): Feature[] {
  for (const feature of features) void feature.bbox
  return features
}
