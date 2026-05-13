import { createCanvas } from 'canvas'
import { toContext } from 'ol/render.js'
import type { StyleResolver } from '../style/style-resolver.js'
import type { PixelFeature } from '../transform/world-to-pixel-transform.js'
import { OlGeometryAdapter } from './ol-geometry-adapter.js'

export class OpenLayersCanvasRenderer {
  private readonly canvas
  private readonly vectorContext
  private readonly geometryAdapter = new OlGeometryAdapter()

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly styleResolver: StyleResolver,
    private readonly resolution: number
  ) {
    this.canvas = createCanvas(width, height)
    const context = this.canvas.getContext('2d')

    this.vectorContext = toContext(context as unknown as CanvasRenderingContext2D, {
      size: [width, height]
    })
  }

  draw(feature: PixelFeature): void {
    if (!feature.geometry) return

    const styles = this.styleResolver(feature, this.resolution)
    if (!styles) return

    const geometry = this.geometryAdapter.toGeometry(feature.geometry)
    const styleList = Array.isArray(styles) ? styles : [styles]

    for (const style of styleList) {
      this.vectorContext.setStyle(style)
      this.vectorContext.drawGeometry(geometry)
    }
  }

  toPngBuffer(): Buffer {
    return this.canvas.toBuffer('image/png')
  }
}
