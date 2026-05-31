import { Buffer } from 'node:buffer'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCanvas, loadImage } from 'canvas'
import '../render/openlayers-node-shim.js'
import Style from 'ol/style/Style.js'
import Stroke from 'ol/style/Stroke.js'
import Fill from 'ol/style/Fill.js'
import CircleStyle from 'ol/style/Circle.js'
import RegularShape from 'ol/style/RegularShape.js'
import Text from 'ol/style/Text.js'
import Icon from 'ol/style/Icon.js'
import type { Feature } from '../core/feature.js'
import { Layer } from '../layer/layer.js'
import { renderMap } from '../ogc/render-map.js'
import { MemSource } from '../source/mem-source.js'
import type { StyleFn } from '../style/style-fn.js'

const pngIconPath = resolve('style-smoke/icon-source.png')
const svgIconPath = resolve('style-smoke/icon-source.svg')

type SmokeCase = {
  name: string
  feature: Feature
  style: () => Style | Style[] | Promise<Style | Style[]>
}

const pointFeature: Feature = {
  type: 'Feature',
  id: 'point',
  properties: {},
  geometry: {
    type: 'Point',
    coordinates: [0, 0]
  }
}

const lineFeature: Feature = {
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
}

const polygonFeature: Feature = {
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

const smokeCases: SmokeCase[] = [
  {
    name: 'stroke-line',
    feature: lineFeature,
    style: () => new Style({
      stroke: new Stroke({ color: '#0055ff', width: 3 })
    })
  },
  {
    name: 'fill-polygon',
    feature: polygonFeature,
    style: () => new Style({
      stroke: new Stroke({ color: '#0055ff', width: 2 }),
      fill: new Fill({ color: 'rgba(0, 85, 255, 0.2)' })
    })
  },
  {
    name: 'gradient-fill-polygon',
    feature: polygonFeature,
    style: () => new Style({
      stroke: new Stroke({ color: '#1f2937', width: 2 }),
      fill: new Fill({
        color: createLinearGradientFill() as unknown as CanvasGradient
      })
    })
  },
  {
    name: 'image-pattern-fill-polygon',
    feature: polygonFeature,
    style: async () => new Style({
      stroke: new Stroke({ color: '#1f2937', width: 2 }),
      fill: new Fill({
        color: await createImagePatternFill() as unknown as CanvasPattern
      })
    })
  },
  {
    name: 'svg-cross-pattern-fill-polygon',
    feature: polygonFeature,
    style: async () => new Style({
      stroke: new Stroke({ color: '#1f2937', width: 2 }),
      fill: new Fill({
        color: await createSvgCrossPatternFill() as unknown as CanvasPattern
      })
    })
  },
  {
    name: 'circle-point',
    feature: pointFeature,
    style: () => new Style({
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({ color: '#dc0000' }),
        stroke: new Stroke({ color: '#ffffff', width: 2 })
      })
    })
  },
  {
    name: 'regular-shape-point',
    feature: pointFeature,
    style: () => new Style({
      image: new RegularShape({
        points: 5,
        radius: 10,
        fill: new Fill({ color: '#f2b705' }),
        stroke: new Stroke({ color: '#1f2937', width: 2 })
      })
    })
  },
  {
    name: 'text-point',
    feature: pointFeature,
    style: () => [
      new Style({
        image: new CircleStyle({
          radius: 4,
          fill: new Fill({ color: '#0055ff' })
        })
      }),
      new Style({
        text: new Text({
          text: 'Label',
          font: '16px sans-serif',
          offsetY: -18,
          fill: new Fill({ color: '#111827' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 })
        })
      })
    ]
  },
  {
    name: 'icon-canvas-point',
    feature: pointFeature,
    style: () => new Style({
      image: new Icon({
        img: createIconCanvas() as unknown as HTMLCanvasElement,
        size: [24, 24]
      })
    })
  },
  {
    name: 'icon-src-point',
    feature: pointFeature,
    style: () => new Style({
      image: new Icon({
        src: pngIconPath
      })
    })
  },
  {
    name: 'icon-svg-point',
    feature: pointFeature,
    style: () => new Style({
      image: new Icon({
        src: svgIconPath
      })
    })
  },
  {
    name: 'icon-svg-img-point',
    feature: pointFeature,
    style: async () => new Style({
      image: new Icon({
        img: (await createSvgIconCanvas()) as unknown as HTMLCanvasElement,
        size: [32, 32]
      })
    })
  }
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
    const source = new MemSource(smokeCase.name, 'EPSG:4326', [smokeCase.feature])
    const olStyle = await smokeCase.style()
    const style: StyleFn = () => olStyle
    const layer = new Layer(smokeCase.name, {
      source,
      styles: [{
        name: 'default',
        style
      }],
      pointProperties: []
    })

    const image = await renderMap({
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

function createLinearGradientFill(): ReturnType<CanvasRenderingContext2D['createLinearGradient']> {
  const canvas = createCanvas(180, 140)
  const context = canvas.getContext('2d')
  const gradient = context.createLinearGradient(0, 0, 180, 140)

  gradient.addColorStop(0, '#dc2626')
  gradient.addColorStop(1, '#2563eb')

  return gradient
}

async function createImagePatternFill(): Promise<NonNullable<ReturnType<CanvasRenderingContext2D['createPattern']>>> {
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

  const pattern = context.createPattern(canvas, 'repeat')
  if (!pattern) {
    throw new Error('Unable to create canvas pattern')
  }

  return pattern
}

async function createSvgCrossPatternFill(): Promise<NonNullable<ReturnType<CanvasRenderingContext2D['createPattern']>>> {
  const tile = createCanvas(24, 24)
  const context = tile.getContext('2d')
  const cross = await loadImage(Buffer.from(createCrossSvgMarkup(), 'utf8'))

  context.fillStyle = '#f8fafc'
  context.fillRect(0, 0, 24, 24)
  context.drawImage(cross, 4, 4, 16, 16)

  const pattern = context.createPattern(tile, 'repeat')
  if (!pattern) {
    throw new Error('Unable to create SVG cross pattern')
  }

  return pattern
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

async function createSvgIconCanvas(): Promise<ReturnType<typeof createCanvas>> {
  const image = await loadImage(Buffer.from(createSvgIconMarkup(), 'utf8'))
  const canvas = createCanvas(32, 32)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, 32, 32)
  return canvas
}
