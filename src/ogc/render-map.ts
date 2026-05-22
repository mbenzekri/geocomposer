import type { BBox, CrsCode } from '../core/types.js'
import type { Source } from '../source/source.js'
import type { StyleFn } from '../style/style-fn.js'
import { createDeferredTextRenderQueue, OlRenderer } from '../render/ol-renderer.js'
import { RenderWritable } from '../render/render-writable.js'
import { BboxFilter } from '../transform/bbox-filter.js'
import { Reproject } from '../transform/reproject.js'

export type RenderLayer = {
  source: Source
  style: StyleFn
}

export type RenderMapOptions = {
  layers: RenderLayer[]
  bbox: BBox
  width: number
  height: number
  crs: CrsCode
}

export type RenderSingleMapOptions = {
  source: Source
  bbox: BBox
  width: number
  height: number
  crs: CrsCode
  style: StyleFn
}

export async function renderMap(options: RenderMapOptions | RenderSingleMapOptions): Promise<Buffer> {
  const resolution = (options.bbox[2] - options.bbox[0]) / options.width
  const layers = 'layers' in options
    ? options.layers
    : [{ source: options.source, style: options.style }]

  if (layers.length === 0) {
    return new OlRenderer(
      options.width,
      options.height,
      options.bbox,
      () => null,
      resolution
    ).toPngBuffer()
  }

  const [firstLayer, ...remainingLayers] = layers
  const deferredText = createDeferredTextRenderQueue()
  const renderer = new OlRenderer(
    options.width,
    options.height,
    options.bbox,
    firstLayer.style,
    resolution,
    deferredText
  )
  await renderLayer(firstLayer, renderer, options)

  for (const layer of remainingLayers) {
    const layerRenderer = new OlRenderer(
      options.width,
      options.height,
      options.bbox,
      layer.style,
      resolution,
      deferredText
    )
    await renderLayer(layer, layerRenderer, options)
    renderer.drawRenderer(layerRenderer)
  }

  await renderer.drawDeferredText('map')
  await renderer.drawDeferredText('overlay')

  return renderer.toPngBuffer()
}

async function renderLayer(
  layer: RenderLayer,
  renderer: OlRenderer,
  options: RenderMapOptions | RenderSingleMapOptions
): Promise<void> {
  const needsReprojection = layer.source.crs !== options.crs
  const features = needsReprojection
    ? layer.source
      .stream()
      .pipeThrough(new Reproject(layer.source.crs, options.crs))
      .pipeThrough(new BboxFilter(options.bbox))
    : layer.source.query({ bbox: options.bbox })

  await features.pipeTo(new RenderWritable(renderer))
  await renderer.drawLayerText()
}
