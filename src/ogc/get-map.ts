import type { BBox, CrsCode } from '../core/geometry.js'
import type { Feature } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { createStyleContext, type StyleFn } from '../style/style-fn.js'
import { createDeferredTextRenderQueue, OlRenderer } from '../render/ol-renderer.js'
import { RenderWritable } from '../stream/render-writable.js'
import type { RequestTimings } from '../source/source.js'
import { jpegBackground, jpegQuality } from '../config/config.js'


export type GetMapOptions = {
    layers: Layer[]
    styles: StyleFn[]
    bbox: BBox
    width: number
    height: number
    crs: CrsCode
    pixelRatio?: number
    format?: 'image/png' | 'image/jpeg'
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
        renderer.setTimings(layerTimings)

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

        await measureStream(layerTimings, () => features.pipeTo(new RenderWritable(renderer, layerTimings)))
        await measureTextRendering(layerTimings, () => renderer.drawLayerText())
        renderer.setTimings(null)
        addTimings(timings, layerTimings)

        const layerTotalMs = performance.now() - layerStartedAt
        const layerPipelineMs = calculateOtherMs(layerTotalMs, layerTimings)
        const layerStreamOtherMs = calculateStreamOtherMs(layerTimings)
        console.debug(`[GetMap] layer=${layer.id} source=${layer.source.id} layerCrs=${layer.crs} requestCrs=${options.crs} features=${featureCount} maxRenderFeatures=${layer.maxRenderFeatures ?? 'none'}`)
        console.debug(`[GetMap] layer=${layer.id} timing total=${formatMs(layerTotalMs)} access=${formatMs(layerTimings.accessMs)} pipeline=${formatMs(layerPipelineMs)} reprojection=${formatMs(layerTimings.reprojectionMs)} rendering=${formatMs(layerTimings.renderingMs)} stream=${formatMs(layerTimings.streamMs)} streamOther=${formatMs(layerStreamOtherMs)} draw=${formatMs(layerTimings.drawMs)} drawGeometry=${formatMs(layerTimings.drawGeometryMs)} text=${formatMs(layerTimings.textMs)} read=${layerTimings.readFeatures} rendered=${layerTimings.renderedFeatures} bulks=${layerTimings.bulkCalls} useful=${formatPercent(calculateUsefulRatio(layerTimings))} throughput=${formatRate(calculateThroughput(layerTimings.renderedFeatures, layerTotalMs))}f/s`)
    }

    renderer.setTimings(timings)
    await measureTextRendering(timings, () => renderer.drawDeferredText('map'))
    await measureTextRendering(timings, () => renderer.drawDeferredText('overlay'))
    renderer.setTimings(null)

    const image = await measureEncoding(timings, () => encodeImage(renderer, options.format ?? 'image/png'))
    const totalMs = options.requestStartedAt === undefined
        ? performance.now() - mapStartedAt
        : Date.now() - options.requestStartedAt
    const pipelineMs = calculateOtherMs(totalMs, timings)
    const streamOtherMs = calculateStreamOtherMs(timings)
    const usefulRatio = calculateUsefulRatio(timings)
    const featuresPerSecond = calculateThroughput(timings.renderedFeatures, totalMs)
    const prefix = options.traceId === undefined ? '[GetMap]' : `[GetMap ${options.traceId}]`
    console.debug(`${prefix} timing total=${formatMs(totalMs)} access=${formatMs(timings.accessMs)} pipeline=${formatMs(pipelineMs)} reprojection=${formatMs(timings.reprojectionMs)} rendering=${formatMs(timings.renderingMs)} encoding=${formatMs(timings.encodingMs)} stream=${formatMs(timings.streamMs)} streamOther=${formatMs(streamOtherMs)} draw=${formatMs(timings.drawMs)} drawGeometry=${formatMs(timings.drawGeometryMs)} text=${formatMs(timings.textMs)} read=${timings.readFeatures} rendered=${timings.renderedFeatures} bulks=${timings.bulkCalls} useful=${formatPercent(usefulRatio)} throughput=${formatRate(featuresPerSecond)}f/s`)

    return image
}

function createTimings(): RequestTimings {
    return {
        accessMs: 0,
        reprojectionMs: 0,
        streamMs: 0,
        drawMs: 0,
        drawGeometryMs: 0,
        textMs: 0,
        renderingMs: 0,
        encodingMs: 0,
        readFeatures: 0,
        renderedFeatures: 0,
        bulkCalls: 0
    }
}

function encodeImage(renderer: OlRenderer, format: 'image/png' | 'image/jpeg'): Buffer {
    if (format === 'image/jpeg') {
        return renderer.toJpegBuffer(jpegQuality / 100, jpegBackground)
    }
    return renderer.toPngBuffer()
}

function addTimings(target: RequestTimings, source: RequestTimings): void {
    target.accessMs += source.accessMs
    target.reprojectionMs += source.reprojectionMs
    target.streamMs += source.streamMs
    target.drawMs += source.drawMs
    target.drawGeometryMs += source.drawGeometryMs
    target.textMs += source.textMs
    target.renderingMs += source.renderingMs
    target.encodingMs += source.encodingMs
    target.readFeatures += source.readFeatures
    target.renderedFeatures += source.renderedFeatures
    target.bulkCalls += source.bulkCalls
}

async function measureStream<T>(timings: RequestTimings, action: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
        return await action()
    } finally {
        timings.streamMs += performance.now() - startedAt
    }
}

async function measureTextRendering<T>(timings: RequestTimings, action: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
        return await action()
    } finally {
        const elapsedMs = performance.now() - startedAt
        timings.textMs += elapsedMs
        timings.renderingMs += elapsedMs
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

function calculateOtherMs(totalMs: number, timings: RequestTimings): number {
    return Math.max(0, totalMs - timings.accessMs - timings.reprojectionMs - timings.renderingMs - timings.encodingMs)
}

function calculateStreamOtherMs(timings: RequestTimings): number {
    return Math.max(0, timings.streamMs - timings.accessMs - timings.reprojectionMs - timings.drawMs)
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
