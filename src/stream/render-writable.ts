import type { Feature } from '../core/feature.js'
import type { OlRenderer } from '../render/ol-renderer.js'

export class RenderWritable extends WritableStream<Feature> {
    constructor(renderer: OlRenderer) {
        super({
            write(feature) {
                return renderer.draw(feature)
            }
        })
    }
}
