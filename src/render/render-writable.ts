import type { GeoFeature } from '../geometry/geo-feature.js'
import type { OpenLayersCanvasRenderer } from './openlayers-canvas-renderer.js'

export class RenderWritable extends WritableStream<GeoFeature> {
    constructor(renderer: OpenLayersCanvasRenderer) {
        super({
            write(feature) {
                return renderer.draw(feature)
            }
        })
    }
}
