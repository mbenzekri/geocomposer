import type { BBox, CrsCode } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { createStyleContext, type StyleFn } from '../style/style-fn.js'
import { createDeferredTextRenderQueue, OlRenderer } from '../render/ol-renderer.js'
import { RenderWritable } from '../render/render-writable.js'


export type GetMapOptions = {
    layers: Layer[]
    styles: StyleFn[]
    bbox: BBox
    width: number
    height: number
    crs: CrsCode
    pixelRatio?: number
}

export async function getMap(options: GetMapOptions): Promise<Buffer> {
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
        renderer.setStyle(style)

        const features = layer.query({
            bbox: options.bbox,
            crs: options.crs
        })

        await features.pipeTo(new RenderWritable(renderer))
        await renderer.drawLayerText()
    }

    await renderer.drawDeferredText('map')
    await renderer.drawDeferredText('overlay')

    return renderer.toPngBuffer()
}

