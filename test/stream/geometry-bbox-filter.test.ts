import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { Layer } from '../../src/layer/layer.js'
import { GeometryBboxFilter } from '../../src/stream/geometry-bbox-filter.js'

describe('GeometryBboxFilter', () => {
  test('keeps features without geometry', async () => {
    const layer = {} as Layer

    await expect(collect([
      {
        type: 'Feature',
        id: 'no-geometry',
        properties: {},
        layer,
        geometry: null
      }
    ], [-5, -5, 5, 5])).resolves.toEqual(['no-geometry'])
  })

  test('rejects a multipolygon whose global bbox intersects but parts do not', async () => {
    const layer = {} as Layer
    const features: Feature[] = [
      {
        type: 'Feature',
        id: 'global-bbox-only',
        properties: {},
        layer,
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
      },
      {
        type: 'Feature',
        id: 'intersects',
        properties: {},
        layer,
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-1, 1],
            [1, 1],
            [1, 3],
            [-1, 3],
            [-1, 1]
          ]]
        }
      }
    ]

    await expect(collect(features, [-5, -5, 5, 5])).resolves.toEqual(['intersects'])
  })

  test('uses feature bbox to skip exact geometry checks when bbox is outside', async () => {
    const layer = {} as Layer
    const features: Feature[] = [
      {
        type: 'Feature',
        id: 'bbox-outside',
        properties: {},
        layer,
        bbox: [20, 20, 21, 21],
        geometry: {
          type: 'Point',
          coordinates: [0, 0]
        }
      },
      {
        type: 'Feature',
        id: 'bbox-inside',
        properties: {},
        layer,
        bbox: [0, 0, 0, 0],
        geometry: {
          type: 'Point',
          coordinates: [0, 0]
        }
      }
    ]

    await expect(collect(features, [-5, -5, 5, 5])).resolves.toEqual(['bbox-inside'])
  })
})

async function collect(features: Feature[], bbox: [number, number, number, number]): Promise<Array<string | number | undefined>> {
  const reader = new ReadableStream<Feature>({
    start(controller) {
      for (const feature of features) controller.enqueue(feature)
      controller.close()
    }
  })
    .pipeThrough(new GeometryBboxFilter(bbox))
    .getReader()
  const result: Array<string | number | undefined> = []

  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return result
      result.push(item.value.id)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
