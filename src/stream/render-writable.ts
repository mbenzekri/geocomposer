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
                    if (requestTimings) requestTimings.renderedFeatures += 1
                } finally {
                    if (requestTimings) {
                        const elapsedMs = performance.now() - startedAt
                        requestTimings.drawMs += elapsedMs
                        requestTimings.renderingMs += elapsedMs
                    }
                }
            }
        })
    }
}
