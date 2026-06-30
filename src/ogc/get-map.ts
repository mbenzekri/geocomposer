import type { BBox, CrsCode } from '../core/geometry.js'
import type { Feature } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { createStyleContext, type StyleFn } from '../style/style-fn.js'
import { createDeferredTextRenderQueue, OlRenderer } from '../render/ol-renderer.js'
import { RenderWritable } from '../stream/render-writable.js'
import type { RequestTimings } from '../source/source.js'


export type GetMapOptions = {
    layers: Layer[]
    styles: StyleFn[]
    bbox: BBox
    width: number
    height: number
    crs: CrsCode
    pixelRatio?: number
    traceId?: number
    requestStartedAt?: number
}

export async function getMap(options: GetMapOptions): Promise<Buffer> {
    const mapStartedAt = performance.now()
    const timings: RequestTimings = {
        accessMs: 0,
        renderingMs: 0
    }
    const resolution = (options.bbox[2] - options.bbox[0]) / options.width
    const styleContext = createStyleContext(options.crs, options.bbox, resolution, options.pixelRatio ?? 1)
    const deferredText = createDeferredTextRenderQueue()
    const renderer = new OlRenderer(
        options.width,
        options.height,
        options.bbox,
        resolution,
        deferredText,
        styleContext
    )
    let totalFeatureCount = 0

    for (let index = 0; index < options.layers.length; index += 1) {
        const layer = options.layers[index]
        const style = options.styles[index] ?? layer.style
        let featureCount = 0
        renderer.setStyle(style)

        const features = layer.query({
            bbox: options.bbox,
            crs: options.crs,
            limit: layer.maxRenderFeatures,
            timings
        }).pipeThrough(new TransformStream<Feature, Feature>({
            transform(feature, controller) {
                featureCount += 1
                totalFeatureCount += 1
                controller.enqueue(feature)
            }
        }))

        await features.pipeTo(new RenderWritable(renderer, timings))
        await measureRendering(timings, () => renderer.drawLayerText())
        console.debug(`[GetMap] layer=${layer.id} source=${layer.source.id} layerCrs=${layer.crs} requestCrs=${options.crs} features=${featureCount} maxRenderFeatures=${layer.maxRenderFeatures ?? 'none'}`)
    }

    await measureRendering(timings, () => renderer.drawDeferredText('map'))
    await measureRendering(timings, () => renderer.drawDeferredText('overlay'))

    const image = await measureRendering(timings, () => renderer.toPngBuffer())
    const totalMs = options.requestStartedAt === undefined
        ? performance.now() - mapStartedAt
        : Date.now() - options.requestStartedAt
    const transformMs = Math.max(0, totalMs - timings.accessMs - timings.renderingMs)
    const featuresPerSecond = totalMs > 0 ? totalFeatureCount / (totalMs / 1000) : 0
    const prefix = options.traceId === undefined ? '[GetMap]' : `[GetMap ${options.traceId}]`
    console.debug(`${prefix} timing total=${formatMs(totalMs)} access=${formatMs(timings.accessMs)} transform=${formatMs(transformMs)} rendering=${formatMs(timings.renderingMs)} features=${totalFeatureCount} throughput=${formatRate(featuresPerSecond)}f/s`)

    return image
}

async function measureRendering<T>(timings: RequestTimings, action: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
        return await action()
    } finally {
        timings.renderingMs += performance.now() - startedAt
    }
}

function formatMs(value: number): string {
    return `${value.toFixed(1)}ms`
}

function formatRate(value: number): string {
    return value.toFixed(1)
}
