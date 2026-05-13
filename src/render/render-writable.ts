import type { PixelFeature } from '../transform/world-to-pixel-transform.js'
import type { OpenLayersCanvasRenderer } from './openlayers-canvas-renderer.js'

export class RenderWritable extends WritableStream<PixelFeature> {
  constructor(renderer: OpenLayersCanvasRenderer) {
    super({
      write(feature) {
        renderer.draw(feature)
      }
    })
  }
}
