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
    const timings = createTimings()
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
    for (let index = 0; index < options.layers.length; index += 1) {
        const layer = options.layers[index]
        const style = options.styles[index] ?? layer.style
        const layerStartedAt = performance.now()
        const layerTimings = createTimings()
        let featureCount = 0
        renderer.setStyle(style)

        const features = layer.query({
            bbox: options.bbox,
            crs: options.crs,
            limit: layer.maxRenderFeatures,
            timings: layerTimings
        }).pipeThrough(new TransformStream<Feature, Feature>({
            transform(feature, controller) {
                featureCount += 1
                controller.enqueue(feature)
            }
        }))

        await features.pipeTo(new RenderWritable(renderer, layerTimings))
        await measureRendering(layerTimings, () => renderer.drawLayerText())
        addTimings(timings, layerTimings)

        const layerTotalMs = performance.now() - layerStartedAt
        const layerPipelineMs = calculatePipelineMs(layerTotalMs, layerTimings)
        console.debug(`[GetMap] layer=${layer.id} source=${layer.source.id} layerCrs=${layer.crs} requestCrs=${options.crs} features=${featureCount} maxRenderFeatures=${layer.maxRenderFeatures ?? 'none'}`)
        console.debug(`[GetMap] layer=${layer.id} timing total=${formatMs(layerTotalMs)} access=${formatMs(layerTimings.accessMs)} pipeline=${formatMs(layerPipelineMs)} reprojection=${formatMs(layerTimings.reprojectionMs)} rendering=${formatMs(layerTimings.renderingMs)} read=${layerTimings.readFeatures} rendered=${layerTimings.renderedFeatures} bulks=${layerTimings.bulkCalls} useful=${formatPercent(calculateUsefulRatio(layerTimings))} throughput=${formatRate(calculateThroughput(layerTimings.renderedFeatures, layerTotalMs))}f/s`)
    }

    await measureRendering(timings, () => renderer.drawDeferredText('map'))
    await measureRendering(timings, () => renderer.drawDeferredText('overlay'))

    const image = await measureEncoding(timings, () => renderer.toPngBuffer())
    const totalMs = options.requestStartedAt === undefined
        ? performance.now() - mapStartedAt
        : Date.now() - options.requestStartedAt
    const pipelineMs = calculatePipelineMs(totalMs, timings)
    const usefulRatio = calculateUsefulRatio(timings)
    const featuresPerSecond = calculateThroughput(timings.renderedFeatures, totalMs)
    const prefix = options.traceId === undefined ? '[GetMap]' : `[GetMap ${options.traceId}]`
    console.debug(`${prefix} timing total=${formatMs(totalMs)} access=${formatMs(timings.accessMs)} pipeline=${formatMs(pipelineMs)} reprojection=${formatMs(timings.reprojectionMs)} rendering=${formatMs(timings.renderingMs)} encoding=${formatMs(timings.encodingMs)} read=${timings.readFeatures} rendered=${timings.renderedFeatures} bulks=${timings.bulkCalls} useful=${formatPercent(usefulRatio)} throughput=${formatRate(featuresPerSecond)}f/s`)

    return image
}

function createTimings(): RequestTimings {
    return {
        accessMs: 0,
        reprojectionMs: 0,
        renderingMs: 0,
        encodingMs: 0,
        readFeatures: 0,
        renderedFeatures: 0,
        bulkCalls: 0
    }
}

function addTimings(target: RequestTimings, source: RequestTimings): void {
    target.accessMs += source.accessMs
    target.reprojectionMs += source.reprojectionMs
    target.renderingMs += source.renderingMs
    target.encodingMs += source.encodingMs
    target.readFeatures += source.readFeatures
    target.renderedFeatures += source.renderedFeatures
    target.bulkCalls += source.bulkCalls
}

async function measureRendering<T>(timings: RequestTimings, action: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
        return await action()
    } finally {
        timings.renderingMs += performance.now() - startedAt
    }
}

async function measureEncoding<T>(timings: RequestTimings, action: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
        return await action()
    } finally {
        timings.encodingMs += performance.now() - startedAt
    }
}

function calculatePipelineMs(totalMs: number, timings: RequestTimings): number {
    return Math.max(0, totalMs - timings.accessMs - timings.reprojectionMs - timings.renderingMs - timings.encodingMs)
}

function calculateUsefulRatio(timings: RequestTimings): number {
    return timings.readFeatures > 0 ? timings.renderedFeatures / timings.readFeatures : 0
}

function calculateThroughput(renderedFeatures: number, totalMs: number): number {
    return totalMs > 0 ? renderedFeatures / (totalMs / 1000) : 0
}

function formatMs(value: number): string {
    return `${value.toFixed(1)}ms`
}

function formatRate(value: number): string {
    return value.toFixed(1)
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}
