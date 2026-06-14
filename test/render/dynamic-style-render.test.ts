import { createCanvas, loadImage } from 'canvas'
import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import { getMap } from '../../src/ogc/get-map.js'
import { Layer } from '../../src/layer/layer.js'
import { MemSource } from '../../src/source/mem-source.js'
import { createDynamicStyleFn, type DynamicStyleJson } from '../../src/style/dynamic-style.js'

describe('dynamic style rendering', () => {
  test('linear gradient fill renders a measurable color transition inside a polygon', async () => {
    const layer = await renderLayer('gradient-fill-polygon', polygonFeature, {
      cacheKey: 'gradient-fill-polygon',
      static: {
        polygon: {
          fill: {
            color: {
              type: 'LinearGradient',
              x0: 0,
              y0: 0,
              x1: 180,
              y1: 140,
              colorStops: [
                { offset: 0, color: '#dc2626' },
                { offset: 1, color: '#2563eb' }
              ]
            }
          }
        }
      }
    })

    const image = await getMap({
      layers: [layer],
      styles: [],
      bbox: [-1, -1, 1, 1],
      width: 180,
      height: 140,
      crs: 'EPSG:4326'
    })
    const pixels = await pngPixels(image, 180, 140)
    const left = pixelAt(pixels, 55, 70, 180)
    const right = pixelAt(pixels, 125, 70, 180)

    expect(left.a).toBeGreaterThan(0)
    expect(right.a).toBeGreaterThan(0)
    expect(left.r).toBeGreaterThan(right.r)
    expect(right.b).toBeGreaterThan(left.b)
  })
})

async function renderLayer(
  name: string,
  featureFactory: (layer: Layer) => Feature,
  styleJson: DynamicStyleJson
): Promise<Layer> {
  const source = new MemSource(name, (layer) => [featureFactory(layer)])
  const style = await createDynamicStyleFn(name, styleJson)

  return new Layer(name, {
    source,
    crs: 'EPSG:4326',
    styles: [{ name: 'default', style }],
    pointProperties: []
  })
}

function polygonFeature(layer: Layer): Feature {
  return {
    layer,
    type: 'Feature',
    id: 'polygon',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-0.6, -0.4],
          [0.6, -0.4],
          [0.6, 0.4],
          [-0.6, 0.4],
          [-0.6, -0.4]
        ]
      ]
    }
  }
}

async function pngPixels(buffer: Buffer, width: number, height: number): Promise<Uint8ClampedArray> {
  const image = await loadImage(buffer)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')

  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, width, height).data
}

function pixelAt(
  pixels: Uint8ClampedArray,
  x: number,
  y: number,
  width: number
): { r: number, g: number, b: number, a: number } {
  const offset = (y * width + x) * 4

  return {
    r: pixels[offset],
    g: pixels[offset + 1],
    b: pixels[offset + 2],
    a: pixels[offset + 3]
  }
}
