import { get as getProjection, getPointResolution } from 'ol/proj.js'
import type { BBox, CrsCode } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import type { StyleContext, StyleFn } from '../style/style-fn.js'
import { createDeferredTextRenderQueue, OlRenderer } from '../render/ol-renderer.js'
import { RenderWritable } from '../render/render-writable.js'


export type RenderMapOptions = {
  layers: Layer[]
  styles: StyleFn[]
  bbox: BBox
  width: number
  height: number
  crs: CrsCode
  pixelRatio?: number
}

const DEFAULT_DPI = 25.4 / 0.28
const INCHES_PER_METER = 1000 / 25.4
const METERS_PER_DEGREE = 111319.49079327358

export async function renderMap(options: RenderMapOptions): Promise<Buffer> {
  const resolution = (options.bbox[2] - options.bbox[0]) / options.width
  const styleContext = createStyleContext(options.crs, options.bbox, resolution, options.pixelRatio ?? 1)
  const deferredText = createDeferredTextRenderQueue()
  const renderer = new OlRenderer(
    options.width,
    options.height,
    options.bbox,
    () => null,
    resolution,
    deferredText,
    styleContext
  )

  for (let index = 0; index < options.layers.length; index += 1) {
    const layer = options.layers[index]
    const layerRenderer = new OlRenderer(
      options.width,
      options.height,
      options.bbox,
      options.styles[index] ?? layer.style,
      resolution,
      deferredText,
      styleContext
    )
    await renderLayer(layer, layerRenderer, options)
    renderer.drawRenderer(layerRenderer)
  }

  await renderer.drawDeferredText('map')
  await renderer.drawDeferredText('overlay')

  return renderer.toPngBuffer()
}

function createStyleContext(
  crs: CrsCode,
  bbox: BBox,
  imageResolution: number,
  pixelRatio: number
): StyleContext {
  const viewResolution = imageResolution * pixelRatio
  const groundResolution = getGroundResolutionMeters(crs, bbox, viewResolution)

  return {
    crs,
    resolutionByUnit: {
      m: groundResolution,
      dd: groundResolution / METERS_PER_DEGREE
    },
    scaleDenominator: groundResolution * INCHES_PER_METER * DEFAULT_DPI
  }
}

function getGroundResolutionMeters(crs: CrsCode, bbox: BBox, resolution: number): number {
  const projection = getProjection(crs)
  if (projection) {
    const center: [number, number] = [
      (bbox[0] + bbox[2]) / 2,
      (bbox[1] + bbox[3]) / 2
    ]
    return getPointResolution(projection, resolution, center, 'm')
  }

  return crs.toUpperCase() === 'EPSG:4326'
    ? resolution * METERS_PER_DEGREE
    : resolution
}

async function renderLayer(
  layer: Layer,
  renderer: OlRenderer,
  options: RenderMapOptions
): Promise<void> {
  const features = layer.query({
    bbox: options.bbox,
    crs: options.crs
  })

  await features.pipeTo(new RenderWritable(renderer))
  await renderer.drawLayerText()
}
