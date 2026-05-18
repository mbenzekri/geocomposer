import type { BBox, CrsCode } from '../core/types.js'
import type { Source } from '../source/source.js'
import type { StyleFn } from '../style/style-fn.js'
import { OlRenderer } from '../render/ol-renderer.js'
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

  const renderer = new OlRenderer(
    options.width,
    options.height,
    options.bbox,
    layers[0]?.style ?? (() => null),
    resolution
  )

  for (const layer of layers) {
    const layerRenderer = new OlRenderer(
      options.width,
      options.height,
      options.bbox,
      layer.style,
      resolution
    )
    const needsReprojection = layer.source.crs !== options.crs
    const projected = needsReprojection
      ? layer.source
        .stream()
        .pipeThrough(new Reproject(layer.source.crs, options.crs))
      : layer.source.stream()

    await projected
      .pipeThrough(new BboxFilter(options.bbox))
      .pipeTo(new RenderWritable(layerRenderer))

    await mergeRenderer(renderer, layerRenderer)
  }

  return renderer.toPngBuffer()
}

async function mergeRenderer(base: OlRenderer, layer: OlRenderer): Promise<void> {
  await base.drawPngBuffer(layer.toPngBuffer())
}
