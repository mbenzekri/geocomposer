import type { Feature } from '../core/feature.js'
import type { OlRenderer } from '../render/ol-renderer.js'
import type { RequestTimings } from '../source/source.js'

export class RenderWritable extends WritableStream<Feature> {
    constructor(renderer: OlRenderer, timings?: RequestTimings) {
        const requestTimings = timings
        super({
            write: async (feature) => {
                const startedAt = performance.now()
                try {
                    await renderer.draw(feature)
                } finally {
                    if (requestTimings) requestTimings.renderingMs += performance.now() - startedAt
                }
            }
        })
    }
}
