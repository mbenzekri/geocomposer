import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import type { Layer, LayerQueryOptions } from '../../src/layer/layer.js'
import { getInfo, InfoFormatter } from '../../src/ogc/get-feature-info.js'

describe('getInfo', () => {
  test('returns unformatted hit context and filters features by query point', async () => {
    const layer = layerWithFeatures('places', [
      point('hit', [4.5, 5.5], { name: 'center' }),
      point('miss', [9, 9], { name: 'outside' })
    ])

    const result = await getInfo({
      layers: [layer],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 10,
      tolerancePixels: 1
    })

    expect(result.coordinate).toEqual([4.5, 5.5])
    expect(result.pixel).toEqual({ i: 4, j: 4 })
    expect(result.hits.map((feature) => feature.id)).toEqual(['hit'])
    expect(layer.queries).toEqual([{
      bbox: [3.5, 4.5, 5.5, 6.5],
      crs: 'EPSG:4326',
      signal: expect.any(AbortSignal)
    }])
  })

  test('formats GeoJSON and normalizes bigint property values', async () => {
    const layer = layerWithFeatures('assets', [
      point('asset-1', [4.5, 5.5], {
        label: 'raw',
        rank: 3,
        count: 12n,
        nested: { value: 34n },
        list: [56n]
      })
    ])

    const result = await getInfo({
      layers: [layer],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 10,
      tolerancePixels: 1,
      formatted: true,
      infoFormat: 'application/geo+json'
    })

    expect(result.contentType).toBe('application/geo+json; charset=utf-8')
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: { name: 'EPSG:4326' }
      },
      queryPoint: {
        type: 'Point',
        coordinates: [4.5, 5.5],
        crs: 'EPSG:4326',
        pixel: { i: 4, j: 4 }
      },
      numberReturned: 1,
      features: [{
        type: 'Feature',
        id: 'asset-1',
        layer: 'assets',
        properties: {
          label: 'raw',
          rank: 3,
          count: '12',
          nested: { value: '34' },
          list: ['56']
        },
        geometry: {
          type: 'Point',
          coordinates: [4.5, 5.5]
        }
      }]
    })
  })

  test('formats XML with escaped layer, id, property and geometry values', async () => {
    const layer = layerWithFeatures('layer<&>', [
      point('id<&>', [4.5, 5.5], {
        'name<&>': 'A&B',
        nil: null,
        enabled: true
      })
    ])

    const result = await getInfo({
      layers: [layer],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 10,
      tolerancePixels: 1,
      formatted: true,
      infoFormat: 'text/xml'
    })

    expect(result.contentType).toBe('text/xml; charset=utf-8')
    expect(result.body).toContain('<FeatureInfoResponse version="1.3.0" crs="EPSG:4326" numberReturned="1">')
    expect(result.body).toContain('<Layer name="layer&lt;&amp;&gt;">')
    expect(result.body).toContain('<Feature id="id&lt;&amp;&gt;">')
    expect(result.body).toContain('<Property name="name&lt;&amp;&gt;" type="string">A&amp;B</Property>')
    expect(result.body).toContain('<Property name="nil" nil="true"/>')
    expect(result.body).toContain('<Property name="enabled" type="boolean">true</Property>')
    expect(result.body).toContain('<Geometry type="Point" encoding="GeoJSON">')
  })

  test('formats XML aliases, layer groups and complex property values', async () => {
    const first = layerWithFeatures('first', [
      point('without-geometry', [4.5, 5.5], {
        array: [1, 'two'],
        object: { nested: true },
        count: 12n
      })
    ])
    const second = layerWithFeatures('second', [
      point('second-1', [4.5, 5.5], null)
    ])

    const result = await getInfo({
      layers: [first, second],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 10,
      formatted: true,
      infoFormat: 'application/xml'
    })

    expect(result.contentType).toBe('application/xml; charset=utf-8')
    expect(result.body).toContain('</Layer><Layer name="second">')
    expect(result.body).toContain('<Property name="array" type="array">[1,&quot;two&quot;]</Property>')
    expect(result.body).toContain('<Property name="object" type="object">{&quot;nested&quot;:true}</Property>')
    expect(result.body).toContain('<Property name="count" type="bigint">12</Property>')
    expect(result.body).toContain('<Properties/>')
  })

  test('formats application/json and omits optional GeoJSON feature fields', async () => {
    const layer = layerWithFeatures('empty-properties', [
      {
        type: 'Feature',
        properties: null,
        layer: undefined as unknown as Layer,
        geometry: {
          type: 'Point',
          coordinates: [4.5, 5.5]
        }
      }
    ])

    const result = await getInfo({
      layers: [layer],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 10,
      formatted: true,
      infoFormat: 'application/json'
    })

    const feature = JSON.parse(result.body).features[0]
    expect(result.contentType).toBe('application/json; charset=utf-8')
    expect(feature).toEqual({
      type: 'Feature',
      layer: 'empty-properties',
      properties: {},
      geometry: {
        type: 'Point',
        coordinates: [4.5, 5.5]
      }
    })
  })

  test('stops collecting hits at featureCount across layers', async () => {
    const first = layerWithFeatures('first', [
      point('first-1', [4.5, 5.5], {}),
      point('first-2', [4.5, 5.5], {})
    ])
    const second = layerWithFeatures('second', [
      point('second-1', [4.5, 5.5], {})
    ])

    const result = await getInfo({
      layers: [first, second],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 1,
      tolerancePixels: 1
    })

    expect(result.hits.map((feature) => feature.id)).toEqual(['first-1'])
    expect(first.queries).toHaveLength(1)
    expect(second.queries).toHaveLength(0)
  })

  test('returns no hits and does not query layers when featureCount is zero', async () => {
    const layer = layerWithFeatures('places', [
      point('hit', [4.5, 5.5], {})
    ])

    const result = await getInfo({
      layers: [layer],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 0
    })

    expect(result.hits).toEqual([])
    expect(layer.queries).toHaveLength(0)
  })

  test('propagates layer stream failures', async () => {
    const layer = {
      id: 'broken',
      query(): ReadableStream<Feature> {
        return new ReadableStream<Feature>({
          start(controller) {
            controller.error(new Error('query failed'))
          }
        })
      }
    } as unknown as Layer

    await expect(getInfo({
      layers: [layer],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 1
    })).rejects.toThrow('query failed')
  })

  test('rejects formatter result when formatting throws or stream aborts', async () => {
    class ThrowingFormatter extends InfoFormatter {
      format(): string {
        throw new Error('format failed')
      }
    }

    const closing = new ThrowingFormatter().writableStream({
      crs: 'EPSG:4326',
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      pixel: { i: 0, j: 0 },
      coordinate: [0.5, 9.5],
      featureCount: 1
    })
    await expect(closing.getWriter().close()).rejects.toThrow('format failed')
    await expect(closing.result).rejects.toThrow('format failed')

    const aborted = new ThrowingFormatter().writableStream({
      crs: 'EPSG:4326',
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      pixel: { i: 0, j: 0 },
      coordinate: [0.5, 9.5],
      featureCount: 1
    })
    await aborted.abort(new Error('aborted'))
    await expect(aborted.result).rejects.toThrow('aborted')
  })

  test('formatter writable stream ignores writes after the feature limit', async () => {
    class IdFormatter extends InfoFormatter<string[]> {
      format(result: { hits: Feature[] }): string[] {
        return result.hits.map((feature) => String(feature.id))
      }
    }

    const stream = new IdFormatter().writableStream({
      crs: 'EPSG:4326',
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      pixel: { i: 0, j: 0 },
      coordinate: [0.5, 9.5],
      featureCount: 0
    })
    const writer = stream.getWriter()
    await writer.write(point('ignored', [4.5, 5.5], {}))
    await writer.close()

    await expect(stream.result).resolves.toEqual([])
  })

  test('rejects unsupported formatted info formats', async () => {
    await expect(getInfo({
      layers: [],
      bbox: [0, 0, 10, 10],
      width: 10,
      height: 10,
      crs: 'EPSG:4326',
      i: 4,
      j: 4,
      featureCount: 1,
      formatted: true,
      infoFormat: 'text/plain'
    })).rejects.toThrow('Unsupported INFO_FORMAT: text/plain')

    expect(InfoFormatter.normalizeInfoFormat('application/json')).toBe('application/json')
  })
})

type TestLayer = Layer & {
  queries: LayerQueryOptions[]
}

function layerWithFeatures(id: string, features: Feature[]): TestLayer {
  const queries: LayerQueryOptions[] = []
  const layer = {
    id,
    queries,
    query(options: LayerQueryOptions): ReadableStream<Feature> {
      queries.push(options)

      return new ReadableStream<Feature>({
        start(controller) {
          for (const feature of features) {
            if (options.signal?.aborted) break
            controller.enqueue({ ...feature, layer: layer as unknown as Layer })
          }
          controller.close()
        }
      })
    }
  }

  return layer as TestLayer
}

function point(
  id: string,
  coordinates: [number, number],
  properties: Feature['properties'],
  geometry: Feature['geometry'] = {
    type: 'Point',
    coordinates
  }
): Feature {
  return {
    type: 'Feature',
    id,
    properties,
    layer: undefined as unknown as Layer,
    bbox: pointBbox(coordinates),
    geometry
  }
}

function pointBbox(coordinates: [number, number]): BBox {
  return [coordinates[0], coordinates[1], coordinates[0], coordinates[1]]
}
