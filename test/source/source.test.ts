import { describe, expect, test, vi } from 'vitest'
import type { DescInfo, Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import {
  DbSource,
  FeatureSource,
  Source,
  hasSourceConfigType,
  toStream,
  type FeatureTransform,
  type StreamOptions
} from '../../src/source/source.js'

const layer = {
  id: 'source-layer',
  crs: 'EPSG:4326'
} as Layer

describe('Source', () => {
  test('throws for uninitialized factory methods and resolves index config', () => {
    expect(() => Source.build({})).toThrow('Source.build is not initialized')
    expect(() => Source.create('x', {})).toThrow('Source.create is not initialized')

    expect(new TestFeatureSource('plain').indexes).toBeUndefined()
    expect(new TestFeatureSource('indexed', { indexes: true } as any).indexes).toBe(true)
    expect(new TestFeatureSource('configured', { indexes: { properties: ['id'] } } as any).indexes)
      .toEqual({ properties: ['id'] })
  })

  test('readById scans streams and query applies bbox, property and paging filters', async () => {
    const source = new TestFeatureSource('features', {}, [
      feature('a', [0, 0], 1),
      feature('b', [2, 2], 5),
      feature('c', [4, 4], 9)
    ])

    await expect(source.readById('b', { layer })).resolves.toMatchObject({ id: 'b' })
    await expect(source.readById('missing', { layer })).resolves.toBeNull()

    await expect(readAll(source.query({
      layer,
      bbox: [0, 0, 5, 5],
      propertyFilter: { property: 'rank', op: '>', value: 1 },
      offset: 1,
      limit: 1
    }))).resolves.toMatchObject([{ id: 'c' }])
  })

  test('maps transforms, extent, reads and stream abort reasons', async () => {
    const controller = new AbortController()
    const source = new TestFeatureSource('mapped', {}, [
      feature('a', [1, 2], 1, { storage: 'mem', sourceId: 'mapped', featureIndex: 4 })
    ], async (item: Feature) => ({
      ...item,
      properties: { ...item.properties, transformed: true }
    }))

    await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 1, 2])
    await expect(source.read({ storage: 'mem', sourceId: 'mapped', featureIndex: 0 }, { layer }))
      .resolves.toMatchObject({
        crs: 'EPSG:4326',
        properties: { transformed: true },
        sourceRef: {
          storage: 'mem',
          sourceId: 'mapped',
          featureIndex: 4,
          recordIndex: 0
        }
      })

    controller.abort('stop')
    await expect(readAll(source.stream({ layer, signal: controller.signal }))).rejects.toThrow('stop')
  })
})

describe('DbSource', () => {
  test('requires readById to be implemented without scanning and resolves dataset ids', async () => {
    const source = new TestDbSource('db')

    await expect(source.readById('1', { layer })).rejects.toThrow('test-db source must implement readById without a full scan')
    expect(source.dataset({ ...layer, dataset: 'custom' } as Layer)).toBe('custom')
    expect(source.dataset(layer)).toBe('source-layer')
  })
})

describe('hasSourceConfigType', () => {
  test('recognizes plain typed config objects', () => {
    expect(hasSourceConfigType({ type: 'csv' }, 'csv')).toBe(true)
    expect(hasSourceConfigType({ type: 'geojson' }, 'csv')).toBe(false)
    expect(hasSourceConfigType(null, 'csv')).toBe(false)
    expect(hasSourceConfigType([], 'csv')).toBe(false)
  })
})

describe('toStream', () => {
  test('streams values, propagates iterator errors and cancels iterators', async () => {
    await expect(readAll(toStream(asyncValues([1, 2])))).resolves.toEqual([1, 2])
    await expect(readAll(toStream(failingValues()))).rejects.toThrow('boom')

    const returned = vi.fn()
    const reader = toStream({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: 1 }
          },
          return: returned
        }
      }
    } as AsyncIterable<number>).getReader()
    await reader.read()
    await reader.cancel()

    expect(returned).toHaveBeenCalled()
  })
})

class TestFeatureSource extends FeatureSource {
  readonly type = 'test-feature'
  readonly storage = 'mem' as const

  constructor(
    id: string,
    info: DescInfo = {},
    private readonly features: Feature[] = [],
    transform?: FeatureTransform
  ) {
    super(id, info, transform)
  }

  protected async *streamFeatures(_options: StreamOptions): AsyncIterable<Feature> {
    yield* this.features
  }

  protected async readFeature(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
    return this.features[0] ?? null
  }
}

class TestDbSource extends DbSource {
  readonly type = 'test-db'

  constructor(id: string) {
    super(id)
  }

  async getExtent(_layer: Layer): Promise<BBox | null> {
    return null
  }

  protected async *streamFeatures(_options: StreamOptions): AsyncIterable<Feature> {}

  protected async readFeature(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
    return null
  }

  dataset(layer: Layer): string {
    return this.resolveDatasetId(layer)
  }
}

function feature(id: string, coordinates: [number, number], rank: number, sourceRef?: SourceRef): Feature {
  return {
    type: 'Feature',
    id,
    properties: { rank },
    geometry: {
      type: 'Point',
      coordinates
    },
    layer,
    sourceRef
  }
}

async function *asyncValues<T>(values: T[]): AsyncIterable<T> {
  yield* values
}

async function *failingValues(): AsyncIterable<number> {
  throw new Error('boom')
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
