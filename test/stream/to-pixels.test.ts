import { describe, expect, test } from 'vitest'
import { toPixels } from '../../src/stream/to-pixels.js'

describe('toPixels', () => {
  const bbox: [number, number, number, number] = [0, 0, 100, 100]

  test('returns null for null geometry', () => {
    expect(toPixels(null, bbox, 10, 10)).toBeNull()
  })

  test('converts all geometry types to pixel coordinates', () => {
    expect(toPixels({
      type: 'Point',
      coordinates: [50, 50, 12]
    }, bbox, 10, 10)).toEqual({
      type: 'Point',
      coordinates: [5, 5, 12]
    })

    expect(toPixels({
      type: 'LineString',
      coordinates: [[0, 100], [100, 0]]
    }, bbox, 10, 10)).toEqual({
      type: 'LineString',
      coordinates: [[0, 0], [10, 10]]
    })

    expect(toPixels({
      type: 'Polygon',
      coordinates: [[[0, 100], [100, 100], [100, 0], [0, 100]]]
    }, bbox, 10, 10)).toEqual({
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]]
    })

    expect(toPixels({
      type: 'MultiPoint',
      coordinates: [[0, 100], [100, 0]]
    }, bbox, 10, 10)).toEqual({
      type: 'MultiPoint',
      coordinates: [[0, 0], [10, 10]]
    })

    expect(toPixels({
      type: 'MultiLineString',
      coordinates: [
        [[0, 100], [100, 0]],
        [[50, 50], [100, 50]]
      ]
    }, bbox, 10, 10)).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [[0, 0], [10, 10]],
        [[5, 5], [10, 5]]
      ]
    })

    expect(toPixels({
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 100], [100, 100], [100, 0], [0, 100]]],
        [[[0, 50], [50, 50], [50, 0], [0, 50]]]
      ]
    }, bbox, 10, 10)).toEqual({
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [10, 0], [10, 10], [0, 0]]],
        [[[0, 5], [5, 5], [5, 10], [0, 5]]]
      ]
    })
  })
})
