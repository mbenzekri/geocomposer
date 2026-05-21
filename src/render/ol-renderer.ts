import {
    Canvas,
    CanvasRenderingContext2D,
    createCanvas,
    loadImage
} from 'canvas'
import './openlayers-node-shim.js'
import ImageState from 'ol/ImageState.js'
import { toContext } from 'ol/render.js'
import Style from 'ol/style/Style.js'
import type { BBox } from '../core/types.js'
import type { Feature } from '../geometry/feature.js'
import type { Geometry } from '../geometry/geometry.js'
import type { StyleFn } from '../style/style-fn.js'
import { getStyleTextRenderStep, type TextRenderStep } from '../style/text-render-step.js'
import { toPixels } from '../transform/to-pixels.js'
import { OlGeometryAdapter } from './ol-geometry-adapter.js'

type OlGeometry = ReturnType<OlGeometryAdapter['toGeometry']>
type DeferredTextRenderStep = Exclude<TextRenderStep, 'layer'>

type DeferredTextRenderItem = {
    geometry: OlGeometry
    style: Style
}

export type DeferredTextRenderQueue = Record<DeferredTextRenderStep, DeferredTextRenderItem[]>

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
        private readonly resolution: number,
        private readonly deferredText: DeferredTextRenderQueue = createDeferredTextRenderQueue()
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

            await this.drawResolvedStyle(style, renderGeometry)
        }
    }

    async drawDeferredText(step: DeferredTextRenderStep): Promise<void> {
        const items = this.deferredText[step].splice(0)

        for (const item of items) {
            await this.drawResolvedStyle(item.style, item.geometry, true)
        }
    }

    private async drawResolvedStyle(
        style: Style,
        geometry: OlGeometry,
        forceLayerStep = false
    ): Promise<void> {
        const text = style.getText()
        const step = forceLayerStep ? 'layer' : getStyleTextRenderStep(style)

        if (text && step !== 'layer') {
            const immediateStyle = cloneStyleWithoutText(style)
            if (immediateStyle) {
                await this.renderStyle(immediateStyle, geometry)
            }

            const deferredStyle = cloneTextOnlyStyle(style)
            if (deferredStyle) {
                this.deferredText[step].push({
                    geometry: cloneGeometry(geometry),
                    style: deferredStyle
                })
            }
            return
        }

        await this.renderStyle(style, geometry)
    }

    private async renderStyle(style: Style, geometry: OlGeometry): Promise<void> {
        await waitForStyleImages(style)
        this.vectorContext.setStyle(style)
        this.vectorContext.drawGeometry(geometry)
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

export function createDeferredTextRenderQueue(): DeferredTextRenderQueue {
    return {
        map: [],
        overlay: []
    }
}

function cloneTextOnlyStyle(style: Style): Style | null {
    const text = style.getText()
    if (!text || isEmptyText(text.getText())) return null

    return new Style({
        text: text.clone(),
        zIndex: style.getZIndex()
    })
}

function cloneStyleWithoutText(style: Style): Style | null {
    if (!hasNonTextRenderer(style)) return null

    const clone = style.clone()
    clone.setText(null as never)
    return clone
}

function hasNonTextRenderer(style: Style): boolean {
    return !!(
        style.getFill()
        || style.getImage()
        || style.getStroke()
        || style.getRenderer()
    )
}

function isEmptyText(text: string | string[] | undefined): boolean {
    if (text == null) return true
    if (Array.isArray(text)) return text.every((item) => item === '')
    return text === ''
}

function cloneGeometry(geometry: OlGeometry): OlGeometry {
    const clone = (geometry as { clone?: () => OlGeometry }).clone
    return clone ? clone.call(geometry) : geometry
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
