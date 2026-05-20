import {
    Canvas,
    CanvasRenderingContext2D,
    createCanvas,
    loadImage
} from 'canvas'
import './openlayers-node-shim.js'
import ImageState from 'ol/ImageState.js'
import { toContext } from 'ol/render.js'
import type Style from 'ol/style/Style.js'
import type { BBox } from '../core/types.js'
import type { Feature } from '../geometry/feature.js'
import type { Geometry } from '../geometry/geometry.js'
import type { StyleFn } from '../style/style-fn.js'
import { toPixels } from '../transform/to-pixels.js'
import { OlGeometryAdapter } from './ol-geometry-adapter.js'

export class OlRenderer {
    private readonly canvas: Canvas
    private readonly context: CanvasRenderingContext2D
    private readonly vectorContext: ReturnType<typeof toContext>
    private readonly geometryAdapter = new OlGeometryAdapter()

    constructor(
        readonly width: number,
        readonly height: number,
        private readonly bbox: BBox,
        private readonly style: StyleFn,
        private readonly resolution: number
    ) {
        this.canvas = createCanvas(width, height)
        this.context = this.canvas.getContext('2d')

        Object.assign(this.canvas, {
            style: {
                width: `${width}px`,
                height: `${height}px`
            }
        })

        Object.assign(this.context, {
            canvas: this.canvas
        })

        this.vectorContext = toContext(this.context as unknown as globalThis.CanvasRenderingContext2D, {
            size: [width, height]
        })
    }

    async draw(feature: Feature): Promise<void> {
        if (!feature.geometry) return

        const styles = this.style(feature, this.resolution)
        if (!styles) return

        const pixelGeometry = toPixels(feature.geometry, this.bbox, this.width, this.height)
        if (!pixelGeometry) return

        const geometry = this.geometryAdapter.toGeometry(pixelGeometry)
        const styleList = Array.isArray(styles) ? styles : [styles]
        const featureLike = {
            get: (property: string) => feature.properties?.[property],
            getGeometry: () => geometry,
            getId: () => feature.id,
            getProperties: () => feature.properties ?? {}
        }

        for (const style of styleList) {
            const renderGeometry = this.resolveStyleGeometry(style, featureLike, geometry)
            if (!renderGeometry) continue

            await waitForStyleImages(style)
            this.vectorContext.setStyle(style)
            this.vectorContext.drawGeometry(renderGeometry)
        }
    }

    private resolveStyleGeometry(
        style: Style,
        featureLike: {
            get: (property: string) => unknown
            getGeometry: () => ReturnType<OlGeometryAdapter['toGeometry']>
            getId: () => Feature['id']
            getProperties: () => Feature['properties']
        },
        defaultGeometry: ReturnType<OlGeometryAdapter['toGeometry']>
    ): ReturnType<OlGeometryAdapter['toGeometry']> | null {
        if (style.getGeometry() == null) return defaultGeometry

        const styleGeometry = style.getGeometryFunction()(featureLike as never)
        if (!styleGeometry) return null

        if (isGeoComposerGeometry(styleGeometry)) {
            const pixelGeometry = toPixels(styleGeometry, this.bbox, this.width, this.height)
            return pixelGeometry ? this.geometryAdapter.toGeometry(pixelGeometry) : null
        }

        return styleGeometry as ReturnType<OlGeometryAdapter['toGeometry']>
    }

    toPngBuffer(): Buffer {
        return this.canvas.toBuffer('image/png')
    }

    drawRenderer(renderer: OlRenderer): void {
        this.context.drawImage(renderer.canvas, 0, 0)
    }

    async drawPngBuffer(imageBuffer: Buffer): Promise<void> {
        const image = await loadImage(imageBuffer)
        this.context.drawImage(image, 0, 0)
    }
}

function isGeoComposerGeometry(value: unknown): value is Geometry {
    if (typeof value !== 'object' || value === null) return false

    const geometry = value as { type?: unknown; coordinates?: unknown }
    return typeof geometry.type === 'string' && 'coordinates' in geometry
}

function waitForStyleImages(style: Style): Promise<void> {
    const imageStyle = style.getImage()
    if (!imageStyle) return Promise.resolve()

    const state = imageStyle.getImageState()
    if (state === ImageState.LOADED || state === ImageState.EMPTY) {
        return Promise.resolve()
    }

    if (state === ImageState.ERROR) {
        return Promise.reject(new Error('OpenLayers image style failed to load'))
    }

    return new Promise((resolve, reject) => {
        const onChange = () => {
            const nextState = imageStyle.getImageState()

            if (nextState === ImageState.LOADED || nextState === ImageState.EMPTY) {
                imageStyle.unlistenImageChange(onChange)
                resolve()
                return
            }

            if (nextState === ImageState.ERROR) {
                imageStyle.unlistenImageChange(onChange)
                reject(new Error('OpenLayers image style failed to load'))
            }
        }

        imageStyle.listenImageChange(onChange)
        imageStyle.load()
        onChange()
    })
}
