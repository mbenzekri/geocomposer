import type { BBox, CrsCode } from '../core/types.js'
import type { Source } from '../source/source.js'
import type { StyleFn } from '../style/style-fn.js'
import { OlRenderer } from '../render/ol-renderer.js'
import { RenderWritable } from '../render/render-writable.js'
import { BboxFilter } from '../transform/bbox-filter.js'
import { Reproject } from '../transform/reproject.js'

export type RenderMapOptions = {
  source: Source
  bbox: BBox
  width: number
  height: number
  crs: CrsCode
  style: StyleFn
}

export async function renderMap(options: RenderMapOptions): Promise<Buffer> {
  const resolution = (options.bbox[2] - options.bbox[0]) / options.width

  const renderer = new OlRenderer(
    options.width,
    options.height,
    options.bbox,
    options.style,
    resolution
  )

  const needsReprojection = options.source.crs !== options.crs
  const projected = needsReprojection
    ? options.source
      .stream()
      .pipeThrough(new Reproject(options.source.crs, options.crs))
    : options.source.stream()

  await projected
    .pipeThrough(new BboxFilter(options.bbox))
    .pipeTo(new RenderWritable(renderer))

  return renderer.toPngBuffer()
}
