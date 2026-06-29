import { createCanvas, loadImage } from 'canvas'
import CircleStyle from 'ol/style/Circle.js'
import Fill from 'ol/style/Fill.js'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import Text from 'ol/style/Text.js'
import Point from 'ol/geom/Point.js'
import ImageState from 'ol/ImageState.js'
import { describe, expect, test, vi } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { Geometry } from '../../src/core/geometry.js'
import { createDeferredTextRenderQueue, OlRenderer } from '../../src/render/ol-renderer.js'
import {
  setTextDeclutterMode,
  setTextDeclutterRank,
  setTextRenderStep
} from '../../src/style/text-render-step.js'

const bbox: [number, number, number, number] = [0, 0, 10, 10]

describe('OlRenderer', () => {
  test('handles missing geometry, missing style and null style results', async () => {
    const renderer = new OlRenderer(80, 80, bbox, 1)

    await expect(renderer.draw({ ...feature('none', null), geometry: null })).resolves.toBeUndefined()
    await expect(renderer.draw(feature('unstyled', [1, 1]))).rejects.toThrow('OlRenderer style must be set before drawing features')

    renderer.setStyle(() => null)
    await expect(renderer.draw(feature('null-style', [1, 1]))).resolves.toBeUndefined()
  })

  test('draws styles, style geometries and composed image buffers', async () => {
    const renderer = new OlRenderer(100, 100, bbox, 1)
    renderer.setStyle((item) => [
      new Style({
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: '#ff0000' }),
          stroke: new Stroke({ color: '#ffffff', width: 1 })
        })
      }),
      new Style({
        geometry: {
          type: 'Point',
          coordinates: [8, 8]
        } as any,
        image: new CircleStyle({
          radius: 4,
          fill: new Fill({ color: '#00ff00' })
        })
      }),
      new Style({
        geometry: () => new Point([50, 50]),
        image: new CircleStyle({
          radius: 3,
          fill: new Fill({ color: '#0000ff' })
        })
      }),
      new Style({
        geometry: ((styleFeature: {
          get: (name: string) => unknown
        }) => {
          return styleFeature.get('kind') === 'skip' ? null : undefined
        }) as any,
        image: new CircleStyle({
          radius: 3,
          fill: new Fill({ color: '#ffff00' })
        })
      })
    ])

    await renderer.draw(feature('styled', [2, 2], { kind: 'point' }))
    await renderer.draw(feature('skipped-geometry', [4, 4], { kind: 'skip' }))

    const overlay = new OlRenderer(100, 100, bbox, 1)
    overlay.setStyle(() => new Style({
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({ color: '#000000' })
      })
    }))
    await overlay.draw(feature('overlay', [5, 5]))
    renderer.drawRenderer(overlay)
    await renderer.drawPngBuffer(createPngBuffer('#00ffff'))

    await expect(nonTransparentPixelCount(renderer.toPngBuffer(), 100, 100)).resolves.toBeGreaterThan(0)
  })

  test('queues and renders deferred text with declutter modes', async () => {
    const queue = createDeferredTextRenderQueue()
    const renderer = new OlRenderer(120, 120, bbox, 1, queue)
    renderer.setStyle((item) => {
      const text = new Text({
        text: item.properties?.label as string,
        font: '12px sans-serif',
        fill: new Fill({ color: '#111111' }),
        stroke: new Stroke({ color: '#ffffff', width: 2 }),
        padding: [2, 4, 2, 4],
        rotation: item.properties?.rotated ? Math.PI / 6 : 0,
        textAlign: item.properties?.align as CanvasTextAlign,
        textBaseline: item.properties?.baseline as CanvasTextBaseline,
        scale: item.properties?.scale as number | undefined
      })
      setTextRenderStep(text, item.properties?.step)
      setTextDeclutterMode(text, item.properties?.mode)
      setTextDeclutterRank(text, item.properties?.rank)

      return new Style({
        image: new CircleStyle({
          radius: 3,
          fill: new Fill({ color: '#ff0000' })
        }),
        text
      })
    })

    await renderer.draw(feature('map-low', [5, 5], {
      label: 'low',
      step: 'map',
      mode: 'rank',
      rank: 1,
      align: 'right',
      baseline: 'alphabetic',
      scale: 1.2,
      rotated: true
    }))
    await renderer.draw(feature('map-high', [5, 5], {
      label: ['high', '', '\nrank'],
      step: 'map',
      mode: 'rank',
      rank: 10,
      align: 'left',
      baseline: 'top'
    }))
    await renderer.draw(feature('overlay', [1, 1], {
      label: 'overlay',
      step: 'overlay',
      mode: 'first'
    }))
    await renderer.draw(feature('layer', [8, 8], {
      label: 'layer',
      step: 'layer',
      mode: 'first',
      baseline: 'bottom'
    }))
    await renderer.draw(feature('no-box', [2, 2], {
      label: '',
      step: 'map',
      mode: 'first'
    }))

    expect(queue.map).toHaveLength(2)
    expect(queue.overlay).toHaveLength(1)

    await renderer.drawDeferredText('map')
    await renderer.drawDeferredText('overlay')
    await renderer.drawLayerText()

    expect(queue.map).toHaveLength(0)
    expect(queue.overlay).toHaveLength(0)
    await expect(nonTransparentPixelCount(renderer.toPngBuffer(), 120, 120)).resolves.toBeGreaterThan(0)
  })

  test('renders text anchors for line and polygon geometries', async () => {
    const renderer = new OlRenderer(140, 140, bbox, 1)
    renderer.setStyle((item) => {
      const text = new Text({
        text: item.properties?.label as string,
        font: '11px sans-serif',
        fill: new Fill({ color: '#222222' }),
        padding: item.properties?.padding as number[] | undefined
      })
      setTextRenderStep(text, 'map')
      setTextDeclutterMode(text, item.properties?.mode)

      return new Style({ text })
    })

    await renderer.draw(feature('line', {
      type: 'LineString',
      coordinates: [[1, 1], [9, 9]]
    }, { label: 'line', mode: 'none' }))
    await renderer.draw(feature('polygon', {
      type: 'Polygon',
      coordinates: [[[1, 1], [6, 1], [6, 6], [1, 6], [1, 1]]]
    }, { label: 'polygon', mode: 'first', padding: [1, 2] }))
    await renderer.draw(feature('multi-polygon', {
      type: 'MultiPolygon',
      coordinates: [[[[7, 7], [9, 7], [9, 9], [7, 9], [7, 7]]]]
    }, { label: 'multi', mode: 'first' }))

    await renderer.drawDeferredText('map')

    await expect(nonTransparentPixelCount(renderer.toPngBuffer(), 140, 140)).resolves.toBeGreaterThan(0)
  })

  test('renders immediate layer text and ignores empty text only styles', async () => {
    const renderer = new OlRenderer(80, 80, bbox, 1)
    renderer.setStyle((item) => {
      const text = new Text({
        text: item.properties?.label as string | string[] | undefined,
        font: '10px sans-serif',
        fill: new Fill({ color: '#333333' })
      })
      setTextRenderStep(text, item.properties?.step)
      setTextDeclutterMode(text, item.properties?.mode)

      return new Style({ text })
    })

    await renderer.draw(feature('immediate-layer-text', [5, 5], {
      label: 'direct',
      step: 'layer',
      mode: 'none'
    }))
    await renderer.draw(feature('undefined-text', [1, 1], {
      step: 'map',
      mode: 'first'
    }))
    await renderer.draw(feature('empty-array-text', [2, 2], {
      label: ['', ''],
      step: 'map',
      mode: 'first'
    }))

    await renderer.drawDeferredText('map')

    await expect(nonTransparentPixelCount(renderer.toPngBuffer(), 80, 80)).resolves.toBeGreaterThan(0)
  })

  test('rejects image styles that fail to load', async () => {
    const renderer = new OlRenderer(40, 40, bbox, 1)
    renderer.setStyle(() => new Style({
      image: {
        getImageState: () => ImageState.ERROR,
        listenImageChange: vi.fn(),
        unlistenImageChange: vi.fn(),
        load: vi.fn()
      } as any
    }))

    await expect(renderer.draw(feature('bad-image', [1, 1])))
      .rejects.toThrow('OpenLayers image style failed to load')
  })
})

function feature(
  id: string,
  geometry: [number, number] | Geometry | null,
  properties: Record<string, unknown> = {}
): Feature {
  return {
    type: 'Feature',
    id,
    properties,
    geometry: Array.isArray(geometry)
      ? {
          type: 'Point',
          coordinates: geometry
        }
      : geometry,
    layer: {} as Feature['layer']
  }
}

function createPngBuffer(color: string): Buffer {
  const canvas = createCanvas(100, 100)
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(0, 0, 100, 100)
  return canvas.toBuffer('image/png')
}

async function nonTransparentPixelCount(buffer: Buffer, width: number, height: number): Promise<number> {
  const image = await loadImage(buffer)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, width, height).data
  let count = 0

  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) count += 1
  }

  return count
}
