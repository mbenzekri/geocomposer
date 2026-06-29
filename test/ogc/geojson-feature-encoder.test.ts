import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import { GeoJsonFeatureEncoder } from '../../src/ogc/geojson-feature-encoder.js'

describe('GeoJsonFeatureEncoder', () => {
  test('encodes feature collections with ids, bbox and normalized JSON values', () => {
    const layer = {} as Feature['layer']
    const features: Feature[] = [
      {
        type: 'Feature',
        id: 'a',
        layer,
        properties: {
          name: 'A',
          count: 12n,
          nested: { values: [1n, 'x'] }
        },
        geometry: { type: 'Point', coordinates: [1, 2] },
        bbox: [1, 2, 1, 2]
      },
      {
        type: 'Feature',
        layer,
        properties: null,
        geometry: null,
        sourceRef: { storage: 'mem', sourceId: 'mem', featureIndex: 7 }
      }
    ]

    const encoded = new GeoJsonFeatureEncoder(['name', 'count', 'nested']).collection(features, {
      timeStamp: '2026-06-29T00:00:00.000Z',
      links: [{ href: '/items' }]
    })

    expect(encoded).toMatchObject({
      type: 'FeatureCollection',
      numberReturned: 2,
      bbox: [1, 2, 1, 2],
      features: [
        {
          type: 'Feature',
          id: 'a',
          properties: {
            name: 'A',
            count: '12',
            nested: { values: ['1', 'x'] }
          },
          geometry: { type: 'Point', coordinates: [1, 2] },
          bbox: [1, 2, 1, 2]
        },
        {
          type: 'Feature',
          id: '7',
          properties: null,
          geometry: null
        }
      ]
    })
  })

  test('omits collection bbox when features have no geometry', () => {
    const encoded = new GeoJsonFeatureEncoder().collection([
      {
        type: 'Feature',
        layer: {} as Feature['layer'],
        properties: {},
        geometry: null
      }
    ], { timeStamp: 'now', links: [] })

    expect(encoded).not.toHaveProperty('bbox')
  })
})
