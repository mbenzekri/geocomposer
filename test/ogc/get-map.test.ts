import { describe, expect, test, vi } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { Layer, LayerQueryOptions } from '../../src/layer/layer.js'
import { getMap } from '../../src/ogc/get-map.js'
import { createDynamicStyleFn } from '../../src/style/dynamic-style.js'
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

    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      bbox: [0, 1, 2, 3],
      crs: 'EPSG:3857',
      limit: 2
    }))
  })

  test('skips source access when dynamic style scales exclude the render scale', async () => {
    const style = await createDynamicStyleFn('off-scale', {
      scales: [0, 1],
      static: {
        one: {
          fill: {
            color: '#ff0000'
          }
        }
      }
    })
    const query = vi.fn((_options: LayerQueryOptions) => new ReadableStream<Feature>({
      start(controller) {
        controller.close()
      }
    }))
    const layer = {
      id: 'parcelle',
      source: { id: 'parcelle' },
      crs: 'EPSG:3857',
      style,
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

    expect(query).not.toHaveBeenCalled()
  })

  test('encodes JPEG output when requested', async () => {
    const style: StyleFn = () => null
    const layer = {
      id: 'parcelle',
      source: { id: 'parcelle' },
      crs: 'EPSG:2154',
      style,
      query: () => new ReadableStream<Feature>({
        start(controller) {
          controller.close()
        }
      })
    } as unknown as Layer

    const image = await getMap({
      layers: [layer],
      styles: [style],
      bbox: [0, 1, 2, 3],
      width: 32,
      height: 32,
      crs: 'EPSG:3857',
      format: 'image/jpeg'
    })

    expect(image.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  })

  test('encodes WebP output from canvas pixels when requested', async () => {
    const style: StyleFn = () => null
    const layer = {
      id: 'parcelle',
      source: { id: 'parcelle' },
      crs: 'EPSG:2154',
      style,
      query: () => new ReadableStream<Feature>({
        start(controller) {
          controller.close()
        }
      })
    } as unknown as Layer

    const image = await getMap({
      layers: [layer],
      styles: [style],
      bbox: [0, 1, 2, 3],
      width: 32,
      height: 32,
      crs: 'EPSG:3857',
      format: 'image/webp'
    })

    expect(image.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(image.subarray(8, 12).toString('ascii')).toBe('WEBP')
  })
})
