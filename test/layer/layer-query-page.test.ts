import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import { Layer, type LayerQueryOptions } from '../../src/layer/layer.js'

describe('Layer.queryPage', () => {
  test('applies bbox exact filtering before offset and limit', async () => {
    const layer = layerWithFeatures([
      disjointMultipolygon('false-positive-1'),
      polygon('hit-1', [-2, -2, -1, -1]),
      disjointMultipolygon('false-positive-2'),
      polygon('hit-2', [0, 0, 1, 1]),
      polygon('hit-3', [2, 2, 3, 3])
    ])

    const page = await layer.queryPage({
      bbox: [-5, -5, 5, 5],
      bboxCrs: 'EPSG:4326',
      crs: 'EPSG:4326',
      limit: 1,
      offset: 1
    })

    expect(page.features.map((feature) => feature.id)).toEqual(['hit-2'])
    expect(page.hasNext).toBe(true)
    expect(page.nextOffset).toBe(2)
  })
})

function layerWithFeatures(features: Feature[]): Layer {
  const layer = {
    crs: 'EPSG:4326',
    query(options: LayerQueryOptions): ReadableStream<Feature> {
      expect(options.limit).toBeUndefined()
      expect(options.offset).toBeUndefined()

      return new ReadableStream<Feature>({
        start(controller) {
          for (const feature of features) {
            controller.enqueue({ ...feature, layer: layer as unknown as Layer })
          }
          controller.close()
        }
      })
    }
  }

  Object.setPrototypeOf(layer, Layer.prototype)
  return layer as unknown as Layer
}

function polygon(id: string, bbox: BBox): Feature {
  const [minX, minY, maxX, maxY] = bbox

  return {
    type: 'Feature',
    id,
    properties: {},
    layer: undefined as unknown as Layer,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY]
      ]]
    }
  }
}

function disjointMultipolygon(id: string): Feature {
  return {
    type: 'Feature',
    id,
    properties: {},
    layer: undefined as unknown as Layer,
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[
          [-20, 0],
          [-10, 0],
          [-10, 10],
          [-20, 10],
          [-20, 0]
        ]],
        [[
          [20, 0],
          [30, 0],
          [30, 10],
          [20, 10],
          [20, 0]
        ]]
      ]
    }
  }
}
