import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import { Crs } from '../../src/core/crs.js'
import { findHeaderEntry, parseFileIndexHeader } from '../../src/index/indexer.js'
import { IndexRecord } from '../../src/index/index-record.js'
import { Layer } from '../../src/layer/layer.js'
import {
  FileSource,
  Source,
  type SourceFile,
  type StreamOptions
} from '../../src/source/source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'
import { init } from '../test-tools.js'

const FILE_INDEX_MAGIC = 'GEOC-IDX'
const FILE_INDEX_VERSION = 1
let tmpDir: string

beforeEach(() => {
  init()
  setupRegistries()
  tmpDir = path.join(os.tmpdir(), 'index-record')
})

describe('IndexRecord', () => {
  it('rejects invalid headers and out-of-bounds record refs', () => {
    expect(() => parseFileIndexHeader(Buffer.alloc(8)))
      .toThrow('Invalid file index: header is shorter than the fixed header')

    const badMagic = Buffer.alloc(16)
    badMagic.write('BAD-IDX!', 0, 'ascii')
    badMagic.writeUInt16LE(FILE_INDEX_VERSION, 8)
    badMagic.writeUInt32LE(16, 10)
    expect(() => parseFileIndexHeader(badMagic))
      .toThrow('Invalid file index magic "BAD-IDX!"')

    const badVersion = Buffer.alloc(16)
    badVersion.write(FILE_INDEX_MAGIC, 0, 'ascii')
    badVersion.writeUInt16LE(FILE_INDEX_VERSION + 1, 8)
    badVersion.writeUInt32LE(16, 10)
    expect(() => parseFileIndexHeader(badVersion))
      .toThrow(`Unsupported file index version ${FILE_INDEX_VERSION + 1}`)

    const badLength = Buffer.alloc(16)
    badLength.write(FILE_INDEX_MAGIC, 0, 'ascii')
    badLength.writeUInt16LE(FILE_INDEX_VERSION, 8)
    badLength.writeUInt32LE(17, 10)
    expect(() => parseFileIndexHeader(badLength))
      .toThrow('Invalid file index: header length exceeds buffer length')

    const truncated = Buffer.alloc(16)
    truncated.write(FILE_INDEX_MAGIC, 0, 'ascii')
    truncated.writeUInt16LE(FILE_INDEX_VERSION, 8)
    truncated.writeUInt32LE(16, 10)
    truncated.writeUInt16LE(1, 14)
    expect(() => parseFileIndexHeader(truncated))
      .toThrow('Invalid file index: truncated header entry')

    const truncatedAfterName = Buffer.alloc(18)
    truncatedAfterName.write(FILE_INDEX_MAGIC, 0, 'ascii')
    truncatedAfterName.writeUInt16LE(FILE_INDEX_VERSION, 8)
    truncatedAfterName.writeUInt32LE(18, 10)
    truncatedAfterName.writeUInt16LE(1, 14)
    truncatedAfterName.writeUInt8(1, 16)
    truncatedAfterName.write('r', 17, 'ascii')
    expect(() => parseFileIndexHeader(truncatedAfterName))
      .toThrow('Invalid file index: truncated header entry')

    const trailing = Buffer.alloc(17)
    trailing.write(FILE_INDEX_MAGIC, 0, 'ascii')
    trailing.writeUInt16LE(FILE_INDEX_VERSION, 8)
    trailing.writeUInt32LE(17, 10)
    expect(() => parseFileIndexHeader(trailing))
      .toThrow('Invalid file index: header contains trailing bytes')

    const validHeaderLength = 45
    const validRecordHeader = Buffer.alloc(validHeaderLength + IndexRecord.ENTRY_SIZE)
    validRecordHeader.write(FILE_INDEX_MAGIC, 0, 'ascii')
    validRecordHeader.writeUInt16LE(FILE_INDEX_VERSION, 8)
    validRecordHeader.writeUInt32LE(validHeaderLength, 10)
    validRecordHeader.writeUInt16LE(1, 14)
    validRecordHeader.writeUInt8(IndexRecord.NAME.length, 16)
    validRecordHeader.write(IndexRecord.NAME, 17, 'ascii')
    validRecordHeader.writeBigUInt64LE(BigInt(validHeaderLength), 23)
    validRecordHeader.writeBigUInt64LE(BigInt(IndexRecord.ENTRY_SIZE), 31)
    validRecordHeader.writeUInt32LE(1, 39)
    validRecordHeader.writeUInt16LE(IndexRecord.ENTRY_SIZE, 43)
    const [recordEntry] = parseFileIndexHeader(validRecordHeader)
    const source = registerSource(new TestFileSource('index-src', [
      { role: 'data', path: path.join(tmpDir, 'index.geojson') }
    ]))
    const layer = new Layer('index-layer', { source: source.id, crs: 'EPSG:4326' })
    const index = new IndexRecord(
      layer,
      'index.geojson.idx',
      'src',
      validRecordHeader.subarray(validHeaderLength),
      recordEntry
    )

    const noRecordHeader = Buffer.from(validRecordHeader.subarray(0, validHeaderLength))
    noRecordHeader.write('bboxrd', 17, 'ascii')
    expect(() => findHeaderEntry(parseFileIndexHeader(noRecordHeader), IndexRecord.NAME, 'File index does not contain a record index'))
      .toThrow('File index does not contain a record index')
    expect(() => index.sourceRef(1))
      .toThrow('Record index 1 is out of bounds')
    expect(() => new IndexRecord(layer, 'index.geojson.idx', 'src', Buffer.alloc(0), recordEntry).sourceRef(0))
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

class TestFileSource extends FileSource {
  readonly type = 'test-file'

  constructor(
    id: string,
    private readonly sourceFiles: readonly SourceFile[],
    private readonly features: Feature[] = []
  ) {
    super(id)
  }

  getFiles(): readonly SourceFile[] {
    return this.sourceFiles
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
