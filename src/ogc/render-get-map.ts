import type { BBox, CrsCode } from '../core/types.js'
import type { GeoSource } from '../source/geo-source.js'
import type { StyleResolver } from '../style/style-resolver.js'
import { OpenLayersCanvasRenderer } from '../render/openlayers-canvas-renderer.js'
import { RenderWritable } from '../render/render-writable.js'
import { WorldToPixelTransform } from '../transform/world-to-pixel-transform.js'

export type RenderGetMapOptions = {
  source: GeoSource
  bbox: BBox
  width: number
  height: number
  crs: CrsCode
  styleResolver: StyleResolver
}

export async function renderGetMap(options: RenderGetMapOptions): Promise<Buffer> {
  const resolution = (options.bbox[2] - options.bbox[0]) / options.width

  const renderer = new OpenLayersCanvasRenderer(
    options.width,
    options.height,
    options.styleResolver,
    resolution
  )

  await options.source
    .query({ bbox: options.bbox, crs: options.crs })
    .pipeThrough(new WorldToPixelTransform({
      bbox: options.bbox,
      width: options.width,
      height: options.height
    }))
    .pipeTo(new RenderWritable(renderer))

  return renderer.toPngBuffer()
}
