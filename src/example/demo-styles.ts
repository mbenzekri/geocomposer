import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCanvas } from 'canvas'
import '../render/openlayers-node-shim.js'
import { Crs } from '../core/crs.js'
import type { Feature } from '../core/feature.js'
import { Layer } from '../layer/layer.js'
import { getMap } from '../ogc/get-map.js'
import { MemSource } from '../source/mem-source.js'
import { Source } from '../source/source-build.js'
import { createDynamicStyleFn, type DynamicStyleJson } from '../style/dynamic-style.js'
import { Style } from '../style/style.js'

const pngIconPath = resolve('style-smoke/icon-source.png')
const svgIconPath = resolve('style-smoke/icon-source.svg')

class SmokeCase {
  constructor(
    readonly name: string,
    private readonly featureFactory: (layer: Layer) => Feature,
    private readonly styleFactory: () => DynamicStyleJson
  ) {}

  feature(layer: Layer): Feature {
    return this.featureFactory(layer)
  }

  createStyle() {
    return createDynamicStyleFn(this.name, this.styleFactory())
  }
}

const pointFeature = (layer: Layer): Feature => ({
  layer,
  type: 'Feature',
  id: 'point',
  properties: { label: 'Label' },
  geometry: {
    type: 'Point',
    coordinates: [0, 0]
  }
})

const lineFeature = (layer: Layer): Feature => ({
  layer,
  type: 'Feature',
  id: 'line',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: [
      [-0.8, -0.5],
      [0.8, 0.5]
    ]
  }
})

const polygonFeature = (layer: Layer): Feature => ({
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
})

const smokeCases = [
  new SmokeCase('stroke-line', lineFeature, () => ({
    cacheKey: 'stroke-line',
    static: {
      line: {
        stroke: { color: '#0055ff', width: 3 }
      }
    }
  })),
  new SmokeCase('fill-polygon', polygonFeature, () => ({
    cacheKey: 'fill-polygon',
    static: {
      polygon: {
        stroke: { color: '#0055ff', width: 2 },
        fill: { color: 'rgba(0, 85, 255, 0.2)' }
      }
    }
  })),
  new SmokeCase('gradient-fill-polygon', polygonFeature, () => ({
    cacheKey: 'gradient-fill-polygon',
    static: {
      polygon: {
        stroke: { color: '#1f2937', width: 2 },
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
  })),
  new SmokeCase('image-pattern-fill-polygon', polygonFeature, () => ({
    cacheKey: 'image-pattern-fill-polygon',
    static: {
      polygon: {
        stroke: { color: '#1f2937', width: 2 },
        fill: {
          color: {
            type: 'CanvasPattern',
            image: createCheckerPatternDataUrl(),
            repetition: 'repeat'
          }
        }
      }
    }
  })),
  new SmokeCase('svg-cross-pattern-fill-polygon', polygonFeature, () => ({
    cacheKey: 'svg-cross-pattern-fill-polygon',
    static: {
      polygon: {
        stroke: { color: '#1f2937', width: 2 },
        fill: {
          color: {
            type: 'CanvasPattern',
            image: createCrossSvgMarkup(),
            repetition: 'repeat'
          }
        }
      }
    }
  })),
  new SmokeCase('circle-point', pointFeature, () => ({
    cacheKey: 'circle-point',
    static: {
      point: {
        image: {
          type: 'Circle',
          radius: 8,
          fill: { color: '#dc0000' },
          stroke: { color: '#ffffff', width: 2 }
        }
      }
    }
  })),
  new SmokeCase('regular-shape-point', pointFeature, () => ({
    cacheKey: 'regular-shape-point',
    static: {
      point: {
        image: {
          type: 'RegularShape',
          points: 5,
          radius: 10,
          fill: { color: '#f2b705' },
          stroke: { color: '#1f2937', width: 2 }
        }
      }
    }
  })),
  new SmokeCase('text-point', pointFeature, () => ({
    cacheKey: 'text-point',
    static: {
      point: {
        image: {
          type: 'Circle',
          radius: 4,
          fill: { color: '#0055ff' }
        }
      },
      label: {
        text: {
          text: '',
          font: '16px sans-serif',
          offsetY: -18,
          fill: { color: '#111827' },
          stroke: { color: '#ffffff', width: 3 }
        }
      }
    },
    dynamic: [
      { pointer: '#/label/text/text', value: "=> F.get('label') ?? ''" }
    ]
  })),
  new SmokeCase('icon-canvas-point', pointFeature, () => ({
    cacheKey: 'icon-canvas-point',
    static: {
      point: {
        image: {
          type: 'Icon',
          img: createIconCanvasDataUrl(),
          size: [24, 24]
        }
      }
    }
  })),
  new SmokeCase('icon-src-point', pointFeature, () => ({
    cacheKey: 'icon-src-point',
    static: {
      point: {
        image: {
          type: 'Icon',
          src: pngIconPath
        }
      }
    }
  })),
  new SmokeCase('icon-svg-point', pointFeature, () => ({
    cacheKey: 'icon-svg-point',
    static: {
      point: {
        image: {
          type: 'Icon',
          src: svgIconPath
        }
      }
    }
  })),
  new SmokeCase('icon-svg-img-point', pointFeature, () => ({
    cacheKey: 'icon-svg-img-point',
    static: {
      point: {
        image: {
          type: 'Icon',
          img: createSvgIconMarkup(),
          size: [32, 32]
        }
      }
    }
  }))
]

await mkdir('style-smoke', { recursive: true })
await Promise.all([
  ...smokeCases.map((smokeCase) => rm(`style-smoke/${smokeCase.name}.png`, { force: true })),
  rm(pngIconPath, { force: true }),
  rm(svgIconPath, { force: true })
])
await writeFile(pngIconPath, createIconCanvas().toBuffer('image/png'))
await writeFile(svgIconPath, createSvgIconMarkup())

let failed = false

for (const smokeCase of smokeCases) {
  try {
    const source = new MemSource(smokeCase.name, (layer) => [smokeCase.feature(layer)])
    const style = await smokeCase.createStyle()
    const styleName = `${smokeCase.name}-style`
    registerLayerDependencies(smokeCase.name, source, styleName, style)

    const layer = new Layer(smokeCase.name, {
      source: smokeCase.name,
      crs: 'EPSG:4326',
      style: styleName
    })

    const image = await getMap({
      layers: [layer],
      styles: [],
      bbox: [-1, -1, 1, 1],
      width: 180,
      height: 140,
      crs: 'EPSG:4326'
    })

    await writeFile(`style-smoke/${smokeCase.name}.png`, image)
    console.log(`OK   ${smokeCase.name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${smokeCase.name}`)
    console.error(error)
  }
}

if (failed) {
  process.exitCode = 1
}

function registerLayerDependencies(
  sourceName: string,
  source: Source,
  styleName: string,
  style: Awaited<ReturnType<typeof createDynamicStyleFn>>
): void {
  if (!Crs.registry.has('EPSG:4326')) {
    Crs.registry.set('EPSG:4326', new Crs('EPSG:4326', 'WGS 84', 'WGS 84'))
  }

  Source.registry.set(sourceName, source)
  Style.registry.set(styleName, { id: styleName, style })
}

function createIconCanvas(): ReturnType<typeof createCanvas> {
  const canvas = createCanvas(24, 24)
  const context = canvas.getContext('2d')

  context.fillStyle = '#f2b705'
  context.fillRect(4, 4, 16, 16)
  context.strokeStyle = '#1f2937'
  context.lineWidth = 2
  context.strokeRect(4, 4, 16, 16)

  return canvas
}

function createIconCanvasDataUrl(): string {
  return createIconCanvas().toDataURL('image/png')
}

function createCheckerPatternDataUrl(): string {
  const canvas = createCanvas(12, 12)
  const context = canvas.getContext('2d')

  context.fillStyle = '#f8fafc'
  context.fillRect(0, 0, 12, 12)
  context.fillStyle = '#2563eb'
  context.fillRect(0, 0, 6, 6)
  context.fillRect(6, 6, 6, 6)
  context.strokeStyle = 'rgba(15, 23, 42, 0.35)'
  context.lineWidth = 1
  context.strokeRect(0.5, 0.5, 11, 11)

  return canvas.toDataURL('image/png')
}

function createSvgIconMarkup(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M16 2C10.48 2 6 6.48 6 12c0 7.5 10 18 10 18s10-10.5 10-18C26 6.48 21.52 2 16 2Z" fill="#dc0000" stroke="#ffffff" stroke-width="2"/>
  <circle cx="16" cy="12" r="4" fill="#ffffff"/>
</svg>`
}

function createCrossSvgMarkup(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" fill="#111827"/>
</svg>`
}
