import type { Feature } from '../geometry/feature.js'
import type { OlRenderer } from './ol-renderer.js'

export class RenderWritable extends WritableStream<Feature> {
    constructor(renderer: OlRenderer) {
        super({
            write(feature) {
                return renderer.draw(feature)
            }
        })
    }
}
