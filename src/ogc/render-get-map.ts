import type { BBox, CrsCode } from '../core/types.js'
import type { GeoSource } from '../source/geo-source.js'
import type { StyleResolver } from '../style/style-resolver.js'
import { OpenLayersCanvasRenderer } from '../render/openlayers-canvas-renderer.js'
import { RenderWritable } from '../render/render-writable.js'
import { BBoxFilterTransform } from '../transform/bbox-filter-transform.js'
import { CrsTransform } from '../transform/crs-transform.js'

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
    options.bbox,
    options.styleResolver,
    resolution
  )

  const needsReprojection = options.source.crs !== options.crs
  const projected = needsReprojection
    ? options.source
      .stream()
      .pipeThrough(new CrsTransform(options.source.crs, options.crs))
    : options.source.stream()

  await projected
    .pipeThrough(new BBoxFilterTransform(options.bbox))
    .pipeTo(new RenderWritable(renderer))

  return renderer.toPngBuffer()
}
