import { describe, expect, test, vi } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { Layer, LayerQueryOptions } from '../../src/layer/layer.js'
import { getMap } from '../../src/ogc/get-map.js'
import type { StyleFn } from '../../src/style/style-fn.js'

describe('getMap', () => {
  test('passes layer maxRenderFeatures as the query limit', async () => {
    const style: StyleFn = () => null
    const query = vi.fn((_options: LayerQueryOptions) => new ReadableStream<Feature>({
      start(controller) {
        controller.close()
      }
    }))
    const layer = {
      id: 'parcelle',
      source: { id: 'parcelle' },
      crs: 'EPSG:2154',
      style,
      maxRenderFeatures: 2,
      query
    } as unknown as Layer

    await getMap({
      layers: [layer],
      styles: [style],
      bbox: [0, 1, 2, 3],
      width: 256,
      height: 128,
      crs: 'EPSG:3857'
    })

    expect(query).toHaveBeenCalledWith({
      bbox: [0, 1, 2, 3],
      crs: 'EPSG:3857',
      limit: 2
    })
  })
})
