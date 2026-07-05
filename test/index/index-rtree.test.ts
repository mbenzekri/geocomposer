import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let openedSources: GeoJsonSource[] = []

beforeEach(() => {
  init()
  setupRegistries()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-rtree-'))
  openedSources = []
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

describe('IndexRtree', () => {
  it('streams records whose feature bbox intersects the query bbox', async () => {
    const geojsonPath = writeGeoJson('rtree.geojson', [
      featureJson('inside', [1, 2]),
      featureJson('outside', [10, 11]),
      featureJson('edge', [2, 3])
    ])
    const source = registerSource(await openSource(new GeoJsonSource('rtree', geojsonPath, 'utf8', 16)))
    const layer = new Layer('rtree', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    const rtree = layer.indexes.get(IndexRtree.NAME) as IndexRtree
    const bulk = vi.spyOn(source, 'bulk')

    expect(rtree).toBeInstanceOf(IndexRtree)
    expect(materializeBbox(await collect(rtree.stream([0, 0, 2, 3]))))
      .toMatchObject([{ id: 'inside' }, { id: 'edge' }])
    expect(bulk).toHaveBeenCalledTimes(2)
    expect(bulk).toHaveBeenNthCalledWith(1, 0, 0, expect.objectContaining({ layer }))
    expect(bulk).toHaveBeenNthCalledWith(2, 2, 2, expect.objectContaining({ layer }))
    expect(() => rtree.stream())
      .toThrow('IndexRtree.stream requires a bbox')
  })

  it('traverses a multi-level rtree and returns only intersecting ranges', async () => {
    const features = Array.from({ length: 2_000 }, (_value, index) => featureJson(`p${index}`, [index, 0]))
    const geojsonPath = writeGeoJson('rtree-large.geojson', features)
    const source = registerSource(await openSource(new GeoJsonSource('rtree-large', geojsonPath, 'utf8', 64)))
    const layer = new Layer('rtree-large', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    const rtree = layer.indexes.get(IndexRtree.NAME) as IndexRtree
    const ranges = rtree.ranges([1050, -1, 1050, 1])
    const allRanges = rtree.ranges([-1, -1, 2000, 1])
    const expectedRanges = Array.from(
      { length: 40 },
      (_value, index) => [index * 50, index * 50 + 49]
    ).flat()

    expect(rtree.entry.recordCount).toBeGreaterThan(20)
    expect(sortRanges(allRanges)).toEqual(expectedRanges)
    expect(ranges).toEqual([1050, 1099])
    expect((await collect(rtree.stream([1050, -1, 1050, 1]))).map((feature) => feature.id)).toEqual(['p1050'])
  })

  it('uses configured rtree chunk size when building ranges', async () => {
    const features = Array.from({ length: 30 }, (_value, index) => featureJson(`p${index}`, [index, 0]))
    const geojsonPath = writeGeoJson('rtree-chunk-size.geojson', features)
    const source = registerSource(await openSource(new GeoJsonSource(
      'rtree-chunk-size',
      geojsonPath,
      'utf8',
      64,
      undefined,
      { indexes: { rtree: { chunkSize: 5 } } }
    )))
    const layer = new Layer('rtree-chunk-size', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    const rtree = layer.indexes.get(IndexRtree.NAME) as IndexRtree

    expect(rtree.ranges([12, -1, 12, 1])).toEqual([10, 14])
  })

  it('builds a clustered rtree from a gzip GeoJSON source', async () => {
    const geojsonPath = writeGeoJsonGzip('rtree-gzip.geojson.gz', [
      featureJson('inside', [1, 2]),
      featureJson('outside', [10, 11])
    ])
    const source = registerSource(await openSource(new GeoJsonSource(
      'rtree-gzip',
      geojsonPath,
      'utf8',
      16,
      undefined,
      {
        gzip: true,
        indexes: {
          rtree: {
            clustered: true
          }
        }
      }
    )))
    const layer = new Layer('rtree-gzip', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    const rtree = layer.indexes.get(IndexRtree.NAME) as IndexRtree

    expect(rtree).toBeInstanceOf(IndexRtree)
    expect((await collect(rtree.stream([0, 0, 2, 3]))).map((feature) => feature.id)).toEqual(['inside'])
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

function writeGeoJsonGzip(name: string, features: Record<string, unknown>[]): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, gzipSync(JSON.stringify({
    type: 'FeatureCollection',
    features
  })))
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

function sortRanges(ranges: number[]): number[] {
  const pairs: Array<[number, number]> = []
  for (let index = 0; index < ranges.length; index += 2) {
    pairs.push([ranges[index], ranges[index + 1]])
  }

  return pairs.sort((a, b) => a[0] - b[0]).flat()
}
