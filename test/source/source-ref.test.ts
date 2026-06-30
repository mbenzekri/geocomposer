import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Feature, SourceRef } from '../../src/core/feature.js'
import type { Layer } from '../../src/layer/layer.js'
import { GeoJsonSource } from '../../src/source/geojson-source.js'
import { GmlSource } from '../../src/source/gml-source.js'
import { ShpSource } from '../../src/source/shp-source.js'

type FileSourceRef = SourceRef & {
  storage: 'file'
  offset: number
  byteLength: number
}

const rootDir = process.cwd()
const layer = {
  id: 'world',
  crs: 'EPSG:4326'
} as Layer

describe('file sourceRef contracts', () => {
  test('GeoJSON sourceRef byte range is a parseable feature and read() roundtrips it', async () => {
    const filePath = resolve(rootDir, 'data/world.geojson')
    const source = new GeoJsonSource('world-geojson', filePath, undefined, 97)
    await source.open()
    try {
      const feature = await readFirst(source.stream({ layer }))
      const sourceRef = assertFileRef(feature, 'world-geojson')
      const slice = await readSlice(filePath, sourceRef)

      expect(slice.toString('utf8', 0, 1)).toBe('{')
      expect(slice.toString('utf8', slice.length - 1)).toBe('}')

      const parsed = JSON.parse(slice.toString('utf8')) as { type?: unknown }
      expect(parsed.type).toBe('Feature')

      const reread = await source.read(sourceRef, { layer })
      expect(reread).not.toBeNull()
      expect(reread?.properties).toEqual(feature.properties)
      expect(reread?.geometry).toEqual(feature.geometry)
      assertSameFileRef(reread?.sourceRef, sourceRef)
    } finally {
      await source.close()
    }
  })

  test('GML sourceRef byte range is a complete feature element and read() roundtrips it', async () => {
    const filePath = resolve(rootDir, 'data/world.gml')
    const source = new GmlSource('world-gml', filePath, { highWaterMark: 257 })
    await source.open()
    try {
      const feature = await readFirst(source.stream({ layer }))
      const sourceRef = assertFileRef(feature, 'world-gml')
      const slice = await readSlice(filePath, sourceRef)
      const text = slice.toString('utf8')

      expect(text.startsWith('<ogr:featureMember>')).toBe(true)
      expect(text.endsWith('</ogr:featureMember>')).toBe(true)
      expect(feature.id).toBe('world.0')

      const reread = await source.read(sourceRef, { layer })
      expect(reread).not.toBeNull()
      expect(reread?.properties).toEqual(feature.properties)
      expect(reread?.geometry).toEqual(feature.geometry)
      assertSameFileRef(reread?.sourceRef, sourceRef)
    } finally {
      await source.close()
    }
  })

  test('Shapefile sourceRef covers the full SHP record and related DBF record', async () => {
    const shpPath = resolve(rootDir, 'data/shapefile/world.shp')
    const dbfPath = resolve(rootDir, 'data/shapefile/world.dbf')
    const source = new ShpSource('world-shp', shpPath, dbfPath, undefined, 29)

    await source.open()
    try {
      const feature = await readFirst(source.stream({ layer }))
      const sourceRef = assertFileRef(feature, 'world-shp')
      const dbfRef = assertRelatedFileRef(sourceRef, 'dbf', 'world-shp')
      const shpSlice = await readSlice(shpPath, sourceRef)
      const dbfSlice = await readSlice(dbfPath, dbfRef)

      expect(sourceRef.offset).toBe(100)
      expect(sourceRef.recordIndex).toBe(0)
      expect(shpSlice.readInt32BE(0)).toBe(1)
      expect(shpSlice.readInt32BE(4) * 2 + 8).toBe(sourceRef.byteLength)
      expect(dbfSlice[0]).toBe(0x20)
      expect(feature.properties?.featurecla).toBe('Admin-0 country')

      const reread = await source.read(sourceRef, { layer })
      expect(reread).not.toBeNull()
      expect(reread?.properties).toEqual(feature.properties)
      expect(reread?.geometry).toEqual(feature.geometry)
      assertSameFileRef(reread?.sourceRef, sourceRef)
    } finally {
      await source.close()
    }
  })
})

async function readFirst(stream: ReadableStream<Feature>): Promise<Feature> {
  const reader = stream.getReader()

  try {
    const result = await reader.read()
    expect(result.done).toBe(false)
    if (result.done) {
      throw new Error('Expected stream to contain at least one feature')
    }
    return result.value
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function assertFileRef(feature: Feature, sourceId: string): FileSourceRef {
  expect(feature.sourceRef, 'feature.sourceRef must be defined').toBeDefined()
  const sourceRef = feature.sourceRef

  if (!isFileSourceRef(sourceRef)) {
    throw new Error('feature.sourceRef must be a file byte range')
  }

  expect(sourceRef.storage).toBe('file')
  expect(sourceRef.sourceId).toBe(sourceId)
  expect(sourceRef.offset).toBeGreaterThanOrEqual(0)
  expect(sourceRef.byteLength).toBeGreaterThan(0)

  return sourceRef
}

function assertRelatedFileRef(sourceRef: SourceRef, key: string, sourceId: string): FileSourceRef {
  const related = sourceRef.related?.[key]
  expect(related, `sourceRef.related.${key} must be defined`).toBeDefined()

  if (!isFileSourceRef(related)) {
    throw new Error(`sourceRef.related.${key} must be a file byte range`)
  }

  expect(related.storage).toBe('file')
  expect(related.sourceId).toBe(sourceId)
  expect(related.byteLength).toBeGreaterThan(0)

  return related
}

function assertSameFileRef(actual: SourceRef | undefined, expected: FileSourceRef): void {
  expect(actual, 'reread feature.sourceRef must be defined').toBeDefined()

  if (!isFileSourceRef(actual)) {
    throw new Error('reread feature.sourceRef must be a file byte range')
  }

  expect(actual.storage).toBe(expected.storage)
  expect(actual.sourceId).toBe(expected.sourceId)
  expect(actual.offset).toBe(expected.offset)
  expect(actual.byteLength).toBe(expected.byteLength)
  expect(actual.recordIndex).toBe(expected.recordIndex)
}

function isFileSourceRef(sourceRef: SourceRef | undefined): sourceRef is FileSourceRef {
  return sourceRef?.storage === 'file'
    && typeof sourceRef.offset === 'number'
    && typeof sourceRef.byteLength === 'number'
}

async function readSlice(filePath: string, sourceRef: FileSourceRef): Promise<Buffer> {
  const file = await readFile(filePath)
  const end = sourceRef.offset + sourceRef.byteLength

  expect(end).toBeLessThanOrEqual(file.length)
  return file.subarray(sourceRef.offset, end)
}
