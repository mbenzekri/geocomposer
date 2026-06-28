import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import { Crs } from '../../src/core/crs.js'
import { Config } from '../../src/config/config.js'
import { Index } from '../../src/layer/layer-index.js'
import { Layer } from '../../src/layer/layer.js'
import {
  FILE_INDEX_MAGIC,
  FILE_INDEX_VERSION,
  IndexRecord,
  IndexRtree,
  FileSource,
  LayerFileIndexer,
  RECORD_INDEX_ENTRY_SIZE,
  RECORD_INDEX_NAME,
  RTREE_INDEX_ENTRY_SIZE,
  RTREE_INDEX_NAME,
  Source,
  type SourceFile,
  type StreamOptions
} from '../../src/source/source-build.js'
import { GeoJsonSource } from '../../src/source/geojson-source.js'
import { MemSource } from '../../src/source/mem-source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'
import { init } from '../test-tools.js'

let tmpDir: string
let createdIndexPaths: string[] = []

beforeEach(() => {
  init()
  setupRegistries()
  createdIndexPaths = []
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-index-'))
})

afterEach(() => {
  for (const indexPath of createdIndexPaths) {
    fs.rmSync(indexPath, { force: true })
  }

  fs.rmSync(tmpDir, {
    recursive: true,
    force: true
  })
})

describe('LayerFileIndexer', () => {
  it('derives an .idx path from the primary source file while preserving the extension', () => {
    const geojson = registerSource(new GeoJsonSource('cities', path.join(tmpDir, 'cities.geojson')))
    const geojsonLayer = new Layer('cities', { source: geojson.id, crs: 'EPSG:4326' })

    expect(LayerFileIndexer.resolveIndexPath(geojsonLayer))
      .toBe(path.join(tmpDir, 'cities.geojson.idx'))

    const shp = registerSource(new TestFileSource('roads', [
      { role: 'attributes', path: path.join(tmpDir, 'roads.dbf') },
      { role: 'geometry', path: path.join(tmpDir, 'roads.shp') }
    ]))
    const shpLayer = new Layer('roads', { source: shp.id, crs: 'EPSG:4326' })

    expect(LayerFileIndexer.resolveIndexPath(shpLayer))
      .toBe(path.join(tmpDir, 'roads.shp.idx'))

    const metadata = registerSource(new TestFileSource('metadata', [
      { role: 'metadata', path: path.join(tmpDir, 'metadata.json') }
    ]))
    const metadataLayer = new Layer('metadata', { source: metadata.id, crs: 'EPSG:4326' })

    expect(LayerFileIndexer.resolveIndexPath(metadataLayer))
      .toBe(path.join(tmpDir, 'metadata.json.idx'))

    const urlPath = path.join(tmpDir, 'url.geojson')
    const urlSource = registerSource(new TestFileSource('url-source', [
      { role: 'data', path: new URL(`file://${urlPath}`) }
    ]))
    const urlLayer = new Layer('url-layer', { source: urlSource.id, crs: 'EPSG:4326' })

    expect(LayerFileIndexer.resolveIndexPath(urlLayer))
      .toBe(`${urlPath}.idx`)
  })

  it('streams a layer once and writes the record index binary layout', async () => {
    const geojsonPath = writeGeoJson('cities.geojson', [
      featureJson('a', [1, 2]),
      featureJson('b', [3, 4]),
      featureJson('c', [5, 6])
    ])
    const source = registerSource(new GeoJsonSource('cities', geojsonPath, 'utf8', 16))
    const layer = new Layer('cities', { source: source.id, crs: 'EPSG:4326' })
    const streamed = await collect(layer.stream())

    const index = await new LayerFileIndexer(layer).build()
    const indexBuffer = fs.readFileSync(index.path)
    const recordIndex = index.recordIndex

    expect(index).toMatchObject({
      path: `${geojsonPath}.idx`,
      sourceId: 'cities',
      recordCount: 3
    })
    expect(layer.indexes.get('record')).toBe(index)
    expect(layer.indexes.get('rtree')).toBeInstanceOf(IndexRtree)
    expect(indexBuffer.subarray(0, 8).toString('ascii')).toBe(FILE_INDEX_MAGIC)
    expect(indexBuffer.readUInt16LE(8)).toBe(FILE_INDEX_VERSION)
    expect(recordIndex).toEqual({
      name: RECORD_INDEX_NAME,
      offset: indexBuffer.readUInt32LE(10),
      byteLength: 3 * RECORD_INDEX_ENTRY_SIZE,
      recordCount: 3,
      entrySize: RECORD_INDEX_ENTRY_SIZE
    })
    const rtreeIndex = index.indexes.find((item) => item.name === RTREE_INDEX_NAME)
    expect(rtreeIndex).toEqual({
      name: RTREE_INDEX_NAME,
      offset: recordIndex.offset + recordIndex.byteLength,
      byteLength: expect.any(Number),
      recordCount: expect.any(Number),
      entrySize: RTREE_INDEX_ENTRY_SIZE
    })
    expect(rtreeIndex?.byteLength).toBe((rtreeIndex?.recordCount ?? 0) * RTREE_INDEX_ENTRY_SIZE)
    expect(indexBuffer.length).toBe((rtreeIndex?.offset ?? 0) + (rtreeIndex?.byteLength ?? 0))

    for (let index = 0; index < streamed.length; index += 1) {
      const entryOffset = recordIndex.offset + index * RECORD_INDEX_ENTRY_SIZE
      const sourceRef = assertFileRef(streamed[index].sourceRef)
      expect(Number(indexBuffer.readBigUInt64LE(entryOffset))).toBe(sourceRef.offset)
      expect(indexBuffer.readUInt32LE(entryOffset + 8)).toBe(sourceRef.byteLength)
    }

    await expect(index.get(1)).resolves.toEqual(streamed[1])
    expect(materializeBbox(await collect(index.stream([2, 0])))).toEqual(materializeBbox([streamed[2], streamed[0]]))
    const rtree = layer.indexes.get('rtree') as IndexRtree
    expect(materializeBbox(await collect(rtree.stream([0, 0, 4, 5])))).toEqual(materializeBbox([streamed[0], streamed[1]]))
  })

  it('rejects layers that are not backed by a FileSource', async () => {
    const source = registerSource(new MemSource('mem', [feature('a')]))
    const layer = new Layer('mem-layer', { source: source.id, crs: 'EPSG:4326' })

    expect(() => LayerFileIndexer.resolveIndexPath(layer))
      .toThrow('Layer "mem-layer" source "mem" is not a FileSource')
    await expect(new LayerFileIndexer(layer).build())
      .rejects.toThrow('Layer "mem-layer" source "mem" is not a FileSource')
  })

  it('rejects FileSource instances without source files', () => {
    const source = registerSource(new TestFileSource('empty', []))
    const layer = new Layer('empty-layer', { source: source.id, crs: 'EPSG:4326' })

    expect(() => LayerFileIndexer.resolveIndexPath(layer))
      .toThrow('FileSource "empty" for layer "empty-layer" has no source files')
  })

  it('rejects streamed features without a valid file sourceRef', async () => {
    const noRef = registerSource(new TestFileSource('missing-ref', [
      { role: 'data', path: path.join(tmpDir, 'missing.geojson') }
    ], [feature('a')]))
    const noRefLayer = new Layer('missing-ref', { source: noRef.id, crs: 'EPSG:4326' })

    await expect(new LayerFileIndexer(noRefLayer).build())
      .rejects.toThrow('Layer "missing-ref" streamed a feature without sourceRef')

    const memRef = registerSource(new TestFileSource('mem-ref', [
      { role: 'data', path: path.join(tmpDir, 'mem.geojson') }
    ], [feature('a', { storage: 'mem', sourceId: 'mem-ref', featureIndex: 0 })]))
    const memRefLayer = new Layer('mem-ref', { source: memRef.id, crs: 'EPSG:4326' })

    await expect(new LayerFileIndexer(memRefLayer).build())
      .rejects.toThrow('Layer "mem-ref" streamed a feature with non-file sourceRef storage "mem"')

    const invalidOffset = registerSource(new TestFileSource('invalid-offset', [
      { role: 'data', path: path.join(tmpDir, 'offset.geojson') }
    ], [feature('a', { storage: 'file', sourceId: 'invalid-offset', offset: -1, byteLength: 4 })]))
    const invalidOffsetLayer = new Layer('invalid-offset', { source: invalidOffset.id, crs: 'EPSG:4326' })

    await expect(new LayerFileIndexer(invalidOffsetLayer).build())
      .rejects.toThrow('Layer "invalid-offset" streamed a feature with invalid sourceRef offset')

    const invalidLength = registerSource(new TestFileSource('invalid-length', [
      { role: 'data', path: path.join(tmpDir, 'length.geojson') }
    ], [feature('a', { storage: 'file', sourceId: 'invalid-length', offset: 0, byteLength: 0x1_0000_0000 })]))
    const invalidLengthLayer = new Layer('invalid-length', { source: invalidLength.id, crs: 'EPSG:4326' })

    await expect(new LayerFileIndexer(invalidLengthLayer).build())
      .rejects.toThrow('Layer "invalid-length" streamed a feature with invalid sourceRef byteLength')

    const multipleSources = registerSource(new TestFileSource('multiple-sources', [
      { role: 'data', path: path.join(tmpDir, 'multiple.geojson') }
    ], [
      feature('a', { storage: 'file', sourceId: 'multiple-a', offset: 0, byteLength: 4 }),
      feature('b', { storage: 'file', sourceId: 'multiple-b', offset: 4, byteLength: 4 })
    ]))
    const multipleSourcesLayer = new Layer('multiple-sources', { source: multipleSources.id, crs: 'EPSG:4326' })

    await expect(new LayerFileIndexer(multipleSourcesLayer).build())
      .rejects.toThrow('Layer "multiple-sources" streamed features from multiple file sources')
  })

  it('indexes every world FileSource layer from data and reads all features through record entries', async () => {
    init()
    await Config.load('config/config.json', 0)

    for (const layerId of ['world', 'world-gml', 'world-shp']) {
      const layer = Layer.registry.get(layerId)
      expect(layer.source).toBeInstanceOf(FileSource)
      expect(layer.source.indexes).toBe(true)

      const indexPath = LayerFileIndexer.resolveIndexPath(layer)
      const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null
      fs.rmSync(indexPath, { force: true })

      try {
        const streamed = await collect(layer.stream())
        const index = await new LayerFileIndexer(layer).build()

        expect(index.path).toBe(indexPath)
        expect(index.recordCount).toBe(streamed.length)
        expect(index.recordIndex.name).toBe(RECORD_INDEX_NAME)
        expect(index.recordIndex.recordCount).toBe(streamed.length)
        expect(streamed.length).toBeGreaterThan(0)
        expect(materializeBbox(await collect(index.stream()))).toEqual(materializeBbox(streamed))
        const rtree = layer.indexes.get('rtree') as IndexRtree
        const worldBbox: BBox = [-180, -90, 180, 90]
        expect(materializeBbox(await collect(rtree.stream(worldBbox)))).toEqual(materializeBbox(streamed))
        await expect(rtree.get(streamed[0].bbox!)).resolves.toEqual(streamed[0])

        for (let record = 0; record < streamed.length; record += 1) {
          const streamedRef = assertFileRef(streamed[record].sourceRef)
          expect(index.sourceRef(record).sourceId).toBe(streamedRef.sourceId)
          const read = await index.get(record)
          if (read) void read.bbox
          expect(read).toEqual(streamed[record])
        }
      } finally {
        if (existingIndex) fs.writeFileSync(indexPath, existingIndex)
        else fs.rmSync(indexPath, { force: true })
      }
    }
  })
})

describe('Index', () => {
  it('returns null when get reads an empty stream', async () => {
    const source = registerSource(new MemSource('empty-index-source', []))
    const layer = new Layer('empty-index-layer', { source: source.id, crs: 'EPSG:4326' })
    const index = new EmptyIndex(layer)

    await expect(index.get()).resolves.toBeNull()
  })
})

describe('IndexRecord', () => {
  it('rejects invalid headers', () => {
    expect(() => IndexRecord.parseHeader(Buffer.alloc(8)))
      .toThrow('Invalid file index: header is shorter than the fixed header')

    const badMagic = Buffer.alloc(16)
    badMagic.write('BAD-IDX!', 0, 'ascii')
    badMagic.writeUInt16LE(FILE_INDEX_VERSION, 8)
    badMagic.writeUInt32LE(16, 10)
    expect(() => IndexRecord.parseHeader(badMagic))
      .toThrow('Invalid file index magic "BAD-IDX!"')

    const badVersion = Buffer.alloc(16)
    badVersion.write(FILE_INDEX_MAGIC, 0, 'ascii')
    badVersion.writeUInt16LE(FILE_INDEX_VERSION + 1, 8)
    badVersion.writeUInt32LE(16, 10)
    expect(() => IndexRecord.parseHeader(badVersion))
      .toThrow(`Unsupported file index version ${FILE_INDEX_VERSION + 1}`)

    const badLength = Buffer.alloc(16)
    badLength.write(FILE_INDEX_MAGIC, 0, 'ascii')
    badLength.writeUInt16LE(FILE_INDEX_VERSION, 8)
    badLength.writeUInt32LE(17, 10)
    expect(() => IndexRecord.parseHeader(badLength))
      .toThrow('Invalid file index: header length exceeds buffer length')

    const truncated = Buffer.alloc(16)
    truncated.write(FILE_INDEX_MAGIC, 0, 'ascii')
    truncated.writeUInt16LE(FILE_INDEX_VERSION, 8)
    truncated.writeUInt32LE(16, 10)
    truncated.writeUInt16LE(1, 14)
    expect(() => IndexRecord.parseHeader(truncated))
      .toThrow('Invalid file index: truncated index descriptor')

    const truncatedAfterName = Buffer.alloc(18)
    truncatedAfterName.write(FILE_INDEX_MAGIC, 0, 'ascii')
    truncatedAfterName.writeUInt16LE(FILE_INDEX_VERSION, 8)
    truncatedAfterName.writeUInt32LE(18, 10)
    truncatedAfterName.writeUInt16LE(1, 14)
    truncatedAfterName.writeUInt8(1, 16)
    truncatedAfterName.write('r', 17, 'ascii')
    expect(() => IndexRecord.parseHeader(truncatedAfterName))
      .toThrow('Invalid file index: truncated index descriptor')

    const trailing = Buffer.alloc(17)
    trailing.write(FILE_INDEX_MAGIC, 0, 'ascii')
    trailing.writeUInt16LE(FILE_INDEX_VERSION, 8)
    trailing.writeUInt32LE(17, 10)
    expect(() => IndexRecord.parseHeader(trailing))
      .toThrow('Invalid file index: header contains trailing bytes')

    const validHeaderLength = 45
    const validRecordHeader = Buffer.alloc(validHeaderLength + RECORD_INDEX_ENTRY_SIZE)
    validRecordHeader.write(FILE_INDEX_MAGIC, 0, 'ascii')
    validRecordHeader.writeUInt16LE(FILE_INDEX_VERSION, 8)
    validRecordHeader.writeUInt32LE(validHeaderLength, 10)
    validRecordHeader.writeUInt16LE(1, 14)
    validRecordHeader.writeUInt8(RECORD_INDEX_NAME.length, 16)
    validRecordHeader.write(RECORD_INDEX_NAME, 17, 'ascii')
    validRecordHeader.writeBigUInt64LE(BigInt(validHeaderLength), 23)
    validRecordHeader.writeBigUInt64LE(BigInt(RECORD_INDEX_ENTRY_SIZE), 31)
    validRecordHeader.writeUInt32LE(1, 39)
    validRecordHeader.writeUInt16LE(RECORD_INDEX_ENTRY_SIZE, 43)
    const [recordIndex] = IndexRecord.parseHeader(validRecordHeader)
    const source = registerSource(new TestFileSource('index-src', [
      { role: 'data', path: path.join(tmpDir, 'index.geojson') }
    ]))
    const layer = new Layer('index-layer', { source: source.id, crs: 'EPSG:4326' })
    const index = new IndexRecord(layer, 'index.geojson.idx', 'src', validRecordHeader, [recordIndex])

    expect(() => new IndexRecord(layer, 'index.geojson.idx', 'src', validRecordHeader, [{ ...recordIndex, name: 'bbox' }]))
      .toThrow('File index does not contain a record index')
    expect(() => index.sourceRef(1))
      .toThrow('Record index 1 is out of bounds')
    expect(() => new IndexRecord(layer, 'index.geojson.idx', 'src', Buffer.alloc(validHeaderLength), [recordIndex]).sourceRef(0))
      .toThrow('Invalid record index: entry exceeds buffer length')
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

class TestFileSource extends FileSource {
  readonly type = 'test-file'

  constructor(
    id: string,
    private readonly files: readonly SourceFile[],
    private readonly features: Feature[] = []
  ) {
    super(id)
  }

  getFiles(): readonly SourceFile[] {
    return this.files
  }

  async getExtent(_layer: Layer): Promise<BBox | null> {
    return null
  }

  protected async *streamFeatures(_options: StreamOptions): AsyncIterable<Feature> {
    yield* this.features
  }

  protected async readFeature(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
    return null
  }
}

class EmptyIndex extends Index<void> {
  constructor(layer: Layer) {
    super('empty', layer)
  }

  stream(): ReadableStream<Feature> {
    return new ReadableStream({
      start(controller) {
        controller.close()
      }
    })
  }
}
