import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DescInfo, Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import { Crs } from '../../src/core/crs.js'
import { Config } from '../../src/config/config.js'
import { Indexer, parseFileIndexHeader } from '../../src/index/indexer.js'
import { IndexRecord } from '../../src/index/index-record.js'
import { IndexRtree } from '../../src/index/index-rtree.js'
import { Layer } from '../../src/layer/layer.js'
import {
  FileSource,
  Source,
  type SourceIndexConfig,
  type SourceFile,
  type StreamOptions
} from '../../src/source/source.js'
import { GeoJsonSource } from '../../src/source/geojson-source.js'
import { MemSource } from '../../src/source/mem-source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'
import { init } from '../test-tools.js'

const FILE_INDEX_MAGIC = 'GEOC-IDX'
const FILE_INDEX_VERSION = 1

let tmpDir: string
let createdIndexPaths: string[] = []
let openedSources: FileSource[] = []

beforeEach(() => {
  init()
  setupRegistries()
  createdIndexPaths = []
  openedSources = []
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-index-'))
})

afterEach(async () => {
  await Promise.allSettled(openedSources.reverse().map((source) => source.close()))

  for (const indexPath of createdIndexPaths) {
    fs.rmSync(indexPath, { force: true })
  }

  fs.rmSync(tmpDir, {
    recursive: true,
    force: true
  })
})

async function openSource<T extends FileSource>(source: T): Promise<T> {
  await source.open()
  openedSources.push(source)
  return source
}

describe('Indexer', () => {
  it('derives an .idx path from the primary source file while preserving the extension', () => {
    const geojson = registerSource(new GeoJsonSource('cities', path.join(tmpDir, 'cities.geojson')))
    const geojsonLayer = new Layer('cities', { source: geojson.id, crs: 'EPSG:4326' })

    expect(Indexer.resolveIndexPath(geojsonLayer))
      .toBe(path.join(tmpDir, 'cities.geojson.idx'))

    const shp = registerSource(new TestFileSource('roads', [
      { role: 'attributes', path: path.join(tmpDir, 'roads.dbf') },
      { role: 'geometry', path: path.join(tmpDir, 'roads.shp') }
    ]))
    const shpLayer = new Layer('roads', { source: shp.id, crs: 'EPSG:4326' })

    expect(Indexer.resolveIndexPath(shpLayer))
      .toBe(path.join(tmpDir, 'roads.shp.idx'))

    const metadata = registerSource(new TestFileSource('metadata', [
      { role: 'metadata', path: path.join(tmpDir, 'metadata.json') }
    ]))
    const metadataLayer = new Layer('metadata', { source: metadata.id, crs: 'EPSG:4326' })

    expect(Indexer.resolveIndexPath(metadataLayer))
      .toBe(path.join(tmpDir, 'metadata.json.idx'))

    const urlPath = path.join(tmpDir, 'url.geojson')
    const urlSource = registerSource(new TestFileSource('url-source', [
      { role: 'data', path: new URL(`file://${urlPath}`) }
    ]))
    const urlLayer = new Layer('url-layer', { source: urlSource.id, crs: 'EPSG:4326' })

    expect(Indexer.resolveIndexPath(urlLayer))
      .toBe(`${urlPath}.idx`)
  })

  it('streams a layer once and writes the record index binary layout', async () => {
    const geojsonPath = writeGeoJson('cities.geojson', [
      featureJson('a', [1, 2]),
      featureJson('b', [3, 4]),
      featureJson('c', [5, 6])
    ])
    const source = registerSource(await openSource(new GeoJsonSource('cities', geojsonPath, 'utf8', 16)))
    const layer = new Layer('cities', { source: source.id, crs: 'EPSG:4326' })
    const streamed = await collect(layer.stream())

    const index = await new Indexer(layer).build()
    const indexBuffer = fs.readFileSync(index.path)
    const header = parseFileIndexHeader(indexBuffer)
    const recordEntry = index.entry

    expect(index).toMatchObject({
      path: `${geojsonPath}.idx`,
      sourceId: 'cities',
      recordCount: 3
    })
    expect(layer.indexes.get('record')).toBe(index)
    expect(layer.indexes.get('rtree')).toBeInstanceOf(IndexRtree)
    expect(indexBuffer.subarray(0, 8).toString('ascii')).toBe(FILE_INDEX_MAGIC)
    expect(indexBuffer.readUInt16LE(8)).toBe(FILE_INDEX_VERSION)
    expect(recordEntry).toEqual({
      name: IndexRecord.NAME,
      offset: indexBuffer.readUInt32LE(10),
      byteLength: 3 * IndexRecord.ENTRY_SIZE,
      recordCount: 3,
      entrySize: IndexRecord.ENTRY_SIZE
    })
    const rtreeEntry = header.find((item) => item.name === IndexRtree.NAME)
    expect(rtreeEntry).toEqual({
      name: IndexRtree.NAME,
      offset: recordEntry.offset + recordEntry.byteLength,
      byteLength: expect.any(Number),
      recordCount: expect.any(Number),
      entrySize: IndexRtree.ENTRY_SIZE
    })
    expect(rtreeEntry?.byteLength).toBe((rtreeEntry?.recordCount ?? 0) * IndexRtree.ENTRY_SIZE)
    expect(indexBuffer.length).toBe((rtreeEntry?.offset ?? 0) + (rtreeEntry?.byteLength ?? 0))

    for (let index = 0; index < streamed.length; index += 1) {
      const entryOffset = recordEntry.offset + index * IndexRecord.ENTRY_SIZE
      const sourceRef = assertFileRef(streamed[index].sourceRef)
      expect(Number(indexBuffer.readBigUInt64LE(entryOffset))).toBe(sourceRef.offset)
      expect(indexBuffer.readUInt32LE(entryOffset + 8)).toBe(sourceRef.byteLength)
    }

    await expect(index.get(1)).resolves.toEqual(streamed[1])
    expect(materializeBbox(await collect(index.stream([2, 0])))).toEqual(materializeBbox([streamed[2], streamed[0]]))
    const rtree = layer.indexes.get('rtree') as IndexRtree
    expect(materializeBbox(await collect(rtree.stream([0, 0, 4, 5])))).toEqual(materializeBbox([streamed[0], streamed[1]]))
  })

  it('loads an existing index file and uses the rtree for bbox queries', async () => {
    const geojsonPath = writeGeoJson('indexed.geojson', [
      featureJson('a', [1, 2]),
      featureJson('b', [10, 11])
    ])
    const source = registerSource(await openSource(new GeoJsonSource('indexed', geojsonPath, 'utf8', 16)))
    const layer = new Layer('indexed', { source: source.id, crs: 'EPSG:4326' })

    await new Indexer(layer).build()
    layer.indexes.clear()

    const loaded = await new Indexer(layer).load()
    expect(loaded.recordCount).toBe(2)
    expect(layer.indexes.get(IndexRecord.NAME)).toBe(loaded)
    expect(layer.indexes.get(IndexRtree.NAME)).toBeInstanceOf(IndexRtree)

    source.stream = vi.fn(() => {
      throw new Error('full stream should not be used')
    })

    const features = await collect(layer.query({ bbox: [0, 0, 2, 3] }))

    expect(features).toHaveLength(1)
    expect(features[0].id).toBe('a')
    await expect(collect(layer.query({
      bbox: [0, 0, 20, 20],
      propertyFilter: { property: 'id', op: '==', value: 'b' }
    }))).resolves.toMatchObject([{ id: 'b' }])
    expect(source.stream).not.toHaveBeenCalled()
  })

  it('builds clustered GeoJSON rtree indexes from a mirror file', async () => {
    const geojsonPath = writeGeoJson('clustered.geojson', [
      featureJson('east', [100, 0]),
      featureJson('west', [-100, 0]),
      featureJson('center', [0, 0])
    ])
    const clusteredPath = `${geojsonPath}.clustered.geojson`
    const source = registerSource(await openSource(new GeoJsonSource('clustered', geojsonPath, 'utf8', 16, undefined, {
      indexes: {
        rtree: {
          chunkSize: 1,
          clustered: true
        }
      }
    })))
    const layer = new Layer('clustered', { source: source.id, crs: 'EPSG:4326' })

    const index = await new Indexer(layer).build()

    expect(fs.existsSync(clusteredPath)).toBe(true)
    expect(index.path).toBe(`${clusteredPath}.idx`)
    expect(Indexer.resolveIndexPath(layer)).toBe(`${clusteredPath}.idx`)

    const mirrored = JSON.parse(fs.readFileSync(clusteredPath, 'utf8')) as { features: Array<{ id: string }> }
    expect(mirrored.features.map((feature) => feature.id).sort()).toEqual(['center', 'east', 'west'])

    const reread = await collect(index.stream())
    expect(reread.map((feature) => feature.id).sort()).toEqual(['center', 'east', 'west'])

    for (const feature of reread) {
      const sourceRef = assertFileRef(feature.sourceRef)
      const slice = fs.readFileSync(clusteredPath).subarray(sourceRef.offset, sourceRef.offset + sourceRef.byteLength)
      expect(JSON.parse(slice.toString('utf8')).id).toBe(feature.id)
    }
  })

  it('uses the clustered GeoJSON mirror as the active file for every FileSource', async () => {
    const originalPath = path.join(tmpDir, 'generic-source.dat')
    fs.writeFileSync(originalPath, 'original')
    const source = registerSource(new TestFileSource('generic-clustered', [
      { role: 'data', path: originalPath }
    ], [
      pointFeature('east', [100, 0], { rank: 3 }),
      pointFeature('west', [-100, 0], { rank: 1 }),
      pointFeature('center', [0, 0], { rank: 2 })
    ], {
      rtree: {
        chunkSize: 1,
        clustered: true
      },
      properties: ['rank']
    }))
    const layer = new Layer('generic-clustered', { source: source.id, crs: 'EPSG:4326' })

    const index = await new Indexer(layer).build()
    const clusteredPath = `${originalPath}.clustered.geojson`

    expect(index.path).toBe(`${clusteredPath}.idx`)
    expect(source.files).toEqual([{ role: 'data', path: clusteredPath }])
    expect(source.getFiles()).toEqual([{ role: 'data', path: originalPath }])

    source.originalReadCount = 0
    const streamed = await collect(layer.stream())
    expect(streamed.map((feature) => feature.id).sort()).toEqual(['center', 'east', 'west'])
    expect(source.originalReadCount).toBe(0)

    const read = await index.get(0)
    expect(read?.sourceRef?.sourceId).toBe(source.id)
    expect(read?.geometry?.type).toBe('Point')
  })

  it('fails clearly when an expected index file is missing', async () => {
    const geojsonPath = writeGeoJson('missing-index.geojson', [
      featureJson('a', [1, 2])
    ])
    const source = registerSource(new GeoJsonSource('missing-index', geojsonPath, 'utf8', 16))
    const layer = new Layer('missing-index', { source: source.id, crs: 'EPSG:4326' })

    await expect(new Indexer(layer).load())
      .rejects.toThrow(`Layer "missing-index" expects index file "${geojsonPath}.idx" but it does not exist`)
  })

  it('rejects layers that are not backed by a FileSource', async () => {
    const source = registerSource(new MemSource('mem', [feature('a')]))
    const layer = new Layer('mem-layer', { source: source.id, crs: 'EPSG:4326' })

    expect(() => Indexer.resolveIndexPath(layer))
      .toThrow('Layer "mem-layer" source "mem" is not a FileSource')
    await expect(new Indexer(layer).build())
      .rejects.toThrow('Layer "mem-layer" source "mem" is not a FileSource')
  })

  it('rejects FileSource instances without source files', () => {
    const source = registerSource(new TestFileSource('empty', []))
    const layer = new Layer('empty-layer', { source: source.id, crs: 'EPSG:4326' })

    expect(() => Indexer.resolveIndexPath(layer))
      .toThrow('FileSource "empty" for layer "empty-layer" has no source files')
  })

  it('rejects streamed features without a valid file sourceRef', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'missing.geojson'), '')
    await fs.promises.writeFile(path.join(tmpDir, 'mem.geojson'), '')
    await fs.promises.writeFile(path.join(tmpDir, 'offset.geojson'), '')
    await fs.promises.writeFile(path.join(tmpDir, 'length.geojson'), '')
    await fs.promises.writeFile(path.join(tmpDir, 'multiple.geojson'), '')

    const noRef = registerSource(new TestFileSource('missing-ref', [
      { role: 'data', path: path.join(tmpDir, 'missing.geojson') }
    ], [feature('a')]))
    const noRefLayer = new Layer('missing-ref', { source: noRef.id, crs: 'EPSG:4326' })

    await expect(new Indexer(noRefLayer).build())
      .rejects.toThrow('Layer "missing-ref" streamed a feature without sourceRef')

    const memRef = registerSource(new TestFileSource('mem-ref', [
      { role: 'data', path: path.join(tmpDir, 'mem.geojson') }
    ], [feature('a', { storage: 'mem', sourceId: 'mem-ref', featureIndex: 0 })]))
    const memRefLayer = new Layer('mem-ref', { source: memRef.id, crs: 'EPSG:4326' })

    await expect(new Indexer(memRefLayer).build())
      .rejects.toThrow('Layer "mem-ref" streamed a feature with non-file sourceRef storage "mem"')

    const invalidOffset = registerSource(new TestFileSource('invalid-offset', [
      { role: 'data', path: path.join(tmpDir, 'offset.geojson') }
    ], [feature('a', { storage: 'file', sourceId: 'invalid-offset', offset: -1, byteLength: 4 })]))
    const invalidOffsetLayer = new Layer('invalid-offset', { source: invalidOffset.id, crs: 'EPSG:4326' })

    await expect(new Indexer(invalidOffsetLayer).build())
      .rejects.toThrow('Layer "invalid-offset" streamed a feature with invalid sourceRef offset')

    const invalidLength = registerSource(new TestFileSource('invalid-length', [
      { role: 'data', path: path.join(tmpDir, 'length.geojson') }
    ], [feature('a', { storage: 'file', sourceId: 'invalid-length', offset: 0, byteLength: 0x1_0000_0000 })]))
    const invalidLengthLayer = new Layer('invalid-length', { source: invalidLength.id, crs: 'EPSG:4326' })

    await expect(new Indexer(invalidLengthLayer).build())
      .rejects.toThrow('Layer "invalid-length" streamed a feature with invalid sourceRef byteLength')

    const multipleSources = registerSource(new TestFileSource('multiple-sources', [
      { role: 'data', path: path.join(tmpDir, 'multiple.geojson') }
    ], [
      feature('a', { storage: 'file', sourceId: 'multiple-a', offset: 0, byteLength: 4 }),
      feature('b', { storage: 'file', sourceId: 'multiple-b', offset: 4, byteLength: 4 })
    ]))
    const multipleSourcesLayer = new Layer('multiple-sources', { source: multipleSources.id, crs: 'EPSG:4326' })

    await expect(new Indexer(multipleSourcesLayer).build())
      .rejects.toThrow('Layer "multiple-sources" streamed features from multiple file sources')
  })

  it('indexes every world FileSource layer from data and reads all features through record entries', async () => {
    init()
    await Config.load('config/config.json', 0)

    for (const layerId of ['world', 'world-gml', 'world-shp']) {
      const layer = Layer.registry.get(layerId)
      expect(layer.source).toBeInstanceOf(FileSource)
      expect(layer.source.indexes).toBe(true)

      const indexPath = Indexer.resolveIndexPath(layer)
      const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null
      fs.rmSync(indexPath, { force: true })

      try {
        await layer.source.open()
        const streamed = await collect(layer.stream())
        const index = await new Indexer(layer).build()

        expect(index.path).toBe(indexPath)
        expect(index.recordCount).toBe(streamed.length)
        expect(index.entry.name).toBe(IndexRecord.NAME)
        expect(index.entry.recordCount).toBe(streamed.length)
        expect(streamed.length).toBeGreaterThan(0)
        expect(materializeBbox(await collect(index.stream()))).toEqual(materializeBbox(streamed))
        const rtree = layer.indexes.get('rtree') as IndexRtree
        const worldBbox: BBox = [-180, -90, 180, 90]
        expect(sortByRecordIndex(materializeBbox(await collect(rtree.stream(worldBbox)))))
          .toEqual(sortByRecordIndex(materializeBbox(streamed)))
        expect(materializeBbox(await collect(rtree.stream(streamed[0].bbox!))))
          .toContainEqual(streamed[0])

        for (let record = 0; record < streamed.length; record += 1) {
          const streamedRef = assertFileRef(streamed[record].sourceRef)
          expect(index.sourceRef(record).sourceId).toBe(streamedRef.sourceId)
          const read = await index.get(record)
          if (read) void read.bbox
          expect(read).toEqual(streamed[record])
        }
      } finally {
        await layer.source.close()
        if (existingIndex) fs.writeFileSync(indexPath, existingIndex)
        else fs.rmSync(indexPath, { force: true })
      }
    }
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

function featureJson(id: string, coordinates: [number, number], properties: Record<string, unknown> = { id }): Record<string, unknown> {
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

function feature(id: string, sourceRef?: SourceRef): Feature {
  return {
    type: 'Feature',
    id,
    properties: null,
    geometry: null,
    layer: undefined as unknown as Layer,
    sourceRef
  }
}

function pointFeature(id: string, coordinates: [number, number], properties: Record<string, unknown>): Feature {
  return {
    type: 'Feature',
    id,
    properties,
    geometry: {
      type: 'Point',
      coordinates
    },
    layer: undefined as unknown as Layer
  }
}

function assertFileRef(sourceRef: SourceRef | undefined): SourceRef & { offset: number, byteLength: number } {
  if (!sourceRef || sourceRef.storage !== 'file') {
    throw new Error('Expected a file sourceRef')
  }

  return sourceRef as SourceRef & { offset: number, byteLength: number }
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

function sortByRecordIndex(features: Feature[]): Feature[] {
  return [...features].sort((left, right) => recordIndex(left) - recordIndex(right))
}

function recordIndex(feature: Feature): number {
  const index = feature.sourceRef?.recordIndex
  if (typeof index !== 'number') {
    throw new Error(`Expected feature "${feature.id ?? '?'}" to have a recordIndex`)
  }

  return index
}

class TestFileSource extends FileSource {
  readonly type = 'test-file'
  originalReadCount = 0

  constructor(
    id: string,
    private readonly sourceFiles: readonly SourceFile[],
    private readonly features: Feature[] = [],
    indexes?: SourceIndexConfig
  ) {
    super(id, indexes ? { indexes } as DescInfo & { indexes: SourceIndexConfig } : undefined)
  }

  getFiles(): readonly SourceFile[] {
    return this.sourceFiles
  }

  async getExtent(_layer: Layer): Promise<BBox | null> {
    return null
  }

  protected async *streamFeatures(_options: StreamOptions): AsyncIterable<Feature> {
    this.originalReadCount += 1
    yield* this.features
  }

  protected async readFeature(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
    return null
  }
}
