import { describe, expect, test } from 'vitest'
import { OlGeometryAdapter } from '../../src/render/ol-geometry-adapter.js'

describe('OlGeometryAdapter', () => {
  test('converts every GeoJSON geometry family to an OpenLayers geometry', () => {
    const adapter = new OlGeometryAdapter()

    expect(coordinates(adapter.toGeometry({ type: 'Point', coordinates: [1, 2] })))
      .toEqual([1, 2])
    expect(coordinates(adapter.toGeometry({ type: 'LineString', coordinates: [[1, 2], [3, 4]] })))
      .toEqual([[1, 2], [3, 4]])
    expect(coordinates(adapter.toGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })))
      .toEqual([[[0, 0], [1, 0], [1, 1], [0, 0]]])
    expect(coordinates(adapter.toGeometry({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] })))
      .toEqual([[1, 2], [3, 4]])
    expect(coordinates(adapter.toGeometry({ type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] })))
      .toEqual([[[1, 2], [3, 4]]])
    expect(coordinates(adapter.toGeometry({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] })))
      .toEqual([[[[0, 0], [1, 0], [1, 1], [0, 0]]]])
  })
})

function coordinates(geometry: unknown): unknown {
  return (geometry as { getCoordinates(): unknown }).getCoordinates()
}
