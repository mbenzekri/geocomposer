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
import type { Feature } from '../core/feature.js'
import type { Geometry, BBox } from '../core/geometry.js'
import type { StyleContext, StyleFn } from '../style/style-fn.js'
import {
    copyTextRenderMetadata,
    getStyleTextDeclutterMode,
    getStyleTextDeclutterRank,
    getStyleTextRenderStep,
    type TextDeclutterMode,
    type TextRenderStep
} from '../style/text-render-step.js'
import { toPixels } from '../transform/to-pixels.js'
import { OlGeometryAdapter } from './ol-geometry-adapter.js'

type OlGeometry = ReturnType<OlGeometryAdapter['toGeometry']>
type DeferredTextRenderStep = Exclude<TextRenderStep, 'layer'>

type DeferredTextRenderItem = {
    geometry: OlGeometry
    style: Style
}

type TextDeclutterCandidate = {
    item: DeferredTextRenderItem
    index: number
    mode: TextDeclutterMode
    rank: number
    box: TextBox
}

type TextBox = {
    minX: number
    minY: number
    maxX: number
    maxY: number
}

export type DeferredTextRenderQueue = Record<DeferredTextRenderStep, DeferredTextRenderItem[]>

export class OlRenderer {
    private readonly canvas: Canvas
    private readonly context: CanvasRenderingContext2D
    private readonly vectorContext: ReturnType<typeof toContext>
    private readonly geometryAdapter = new OlGeometryAdapter()
    private readonly layerText: DeferredTextRenderItem[] = []

    constructor(
        readonly width: number,
        readonly height: number,
        private readonly bbox: BBox,
        private readonly style: StyleFn,
        private readonly resolution: number,
        private readonly deferredText: DeferredTextRenderQueue = createDeferredTextRenderQueue(),
        private readonly styleContext?: StyleContext
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

        const styles = this.style(feature, this.resolution, this.styleContext)
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
        await this.renderTextItems(items)
    }

    async drawLayerText(): Promise<void> {
        const items = this.layerText.splice(0)
        await this.renderTextItems(items)
    }

    private async drawResolvedStyle(
        style: Style,
        geometry: OlGeometry
    ): Promise<void> {
        const text = style.getText()
        const step = getStyleTextRenderStep(style)
        const declutterMode = getStyleTextDeclutterMode(style)

        if (text && (step !== 'layer' || declutterMode !== 'none')) {
            const immediateStyle = cloneStyleWithoutText(style)
            if (immediateStyle) {
                await this.renderStyle(immediateStyle, geometry)
            }

            const deferredStyle = cloneTextOnlyStyle(style)
            if (deferredStyle) {
                this.pushTextItem(step, {
                    geometry: cloneGeometry(geometry),
                    style: deferredStyle
                })
            }
            return
        }

        await this.renderStyle(style, geometry)
    }

    private pushTextItem(step: TextRenderStep, item: DeferredTextRenderItem): void {
        if (step === 'layer') {
            this.layerText.push(item)
            return
        }

        this.deferredText[step].push(item)
    }

    private async renderStyle(style: Style, geometry: OlGeometry): Promise<void> {
        await waitForStyleImages(style)
        this.vectorContext.setStyle(style)
        this.vectorContext.drawGeometry(geometry)
    }

    private async renderTextItems(items: DeferredTextRenderItem[]): Promise<void> {
        const selectedItems = this.selectTextItems(items)

        for (const item of items) {
            if (selectedItems.has(item)) {
                await this.renderStyle(item.style, item.geometry)
            }
        }
    }

    private selectTextItems(items: DeferredTextRenderItem[]): Set<DeferredTextRenderItem> {
        const selected = new Set<DeferredTextRenderItem>()
        const candidates: TextDeclutterCandidate[] = []

        items.forEach((item, index) => {
            const mode = getStyleTextDeclutterMode(item.style)
            if (mode === 'none') {
                selected.add(item)
                return
            }

            const box = this.textBox(item.style, item.geometry)
            if (!box) {
                selected.add(item)
                return
            }

            candidates.push({
                item,
                index,
                mode,
                rank: getStyleTextDeclutterRank(item.style),
                box
            })
        })

        const orderedCandidates = candidates.some((candidate) => candidate.mode === 'rank')
            ? [...candidates].sort((a, b) => b.rank - a.rank || a.index - b.index)
            : candidates
        const occupied: TextBox[] = []

        for (const candidate of orderedCandidates) {
            if (occupied.some((box) => boxesOverlap(box, candidate.box))) {
                continue
            }

            occupied.push(candidate.box)
            selected.add(candidate.item)
        }

        return selected
    }

    private textBox(style: Style, geometry: OlGeometry): TextBox | null {
        const text = style.getText()
        const anchor = labelAnchor(geometry)
        if (!text || !anchor) return null

        const lines = textToLines(text.getText())
        if (lines.length === 0) return null

        const font = text.getFont() ?? '10px sans-serif'
        this.context.save()
        this.context.font = font

        const textWidth = Math.max(...lines.map((line) => this.context.measureText(line).width))
        this.context.restore()

        const [scaleX, scaleY] = text.getScaleArray()
        const fontSize = fontSizeFromCssFont(font)
        const lineHeight = fontSize * 1.2
        const strokeWidth = text.getStroke()?.getWidth() ?? 0
        const padding = normalizePadding(text.getPadding())
        const width = textWidth * Math.abs(scaleX) + strokeWidth * 2 + padding[1] + padding[3]
        const height = lineHeight * lines.length * Math.abs(scaleY) + strokeWidth * 2 + padding[0] + padding[2]
        const x = anchor[0] + text.getOffsetX()
        const y = anchor[1] + text.getOffsetY()
        const align = text.getTextAlign() ?? 'center'
        const baseline = text.getTextBaseline() ?? 'middle'
        const left = alignedLeft(x, width, align)
        const top = alignedTop(y, height, baseline)

        return rotatedBox({
            minX: left,
            minY: top,
            maxX: left + width,
            maxY: top + height
        }, text.getRotation() ?? 0)
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
    const textClone = text.clone()
    copyTextRenderMetadata(text, textClone)

    return new Style({
        text: textClone,
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

function labelAnchor(geometry: OlGeometry): [number, number] | null {
    const candidate = geometry as {
        getType?: () => string
        getCoordinates?: () => unknown
        getCoordinateAt?: (fraction: number) => unknown
        getInteriorPoint?: () => { getCoordinates?: () => unknown }
        getInteriorPoints?: () => { getCoordinates?: () => unknown }
        getExtent?: () => number[]
    }
    const type = candidate.getType?.()

    if (type === 'Point') {
        return coordinateFromValue(candidate.getCoordinates?.())
    }

    if (type === 'LineString') {
        return coordinateFromValue(candidate.getCoordinateAt?.(0.5))
    }

    if (type === 'Polygon') {
        return coordinateFromValue(candidate.getInteriorPoint?.().getCoordinates?.())
    }

    if (type === 'MultiPolygon') {
        return coordinateFromValue(candidate.getInteriorPoints?.().getCoordinates?.())
    }

    const extent = candidate.getExtent?.()
    if (!extent || extent.length < 4 || extent.some((value) => !Number.isFinite(value))) {
        return null
    }

    return [
        (extent[0] + extent[2]) / 2,
        (extent[1] + extent[3]) / 2
    ]
}

function coordinateFromValue(value: unknown): [number, number] | null {
    if (!Array.isArray(value)) return null

    if (
        typeof value[0] === 'number'
        && typeof value[1] === 'number'
        && Number.isFinite(value[0])
        && Number.isFinite(value[1])
    ) {
        return [value[0], value[1]]
    }

    for (const item of value) {
        const coordinate = coordinateFromValue(item)
        if (coordinate) return coordinate
    }

    return null
}

function textToLines(value: string | string[] | undefined): string[] {
    if (typeof value === 'string') return value.split('\n').filter((line) => line.length > 0)
    if (!Array.isArray(value)) return []

    return value
        .filter((_item, index) => index % 2 === 0)
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
}

function normalizePadding(value: number[] | null): [number, number, number, number] {
    return [
        value?.[0] ?? 0,
        value?.[1] ?? 0,
        value?.[2] ?? 0,
        value?.[3] ?? 0
    ]
}

function fontSizeFromCssFont(font: string): number {
    const match = /(\d+(?:\.\d+)?)px/.exec(font)
    return match ? Number(match[1]) : 10
}

function alignedLeft(x: number, width: number, align: CanvasTextAlign): number {
    if (align === 'right' || align === 'end') return x - width
    if (align === 'left' || align === 'start') return x
    return x - width / 2
}

function alignedTop(y: number, height: number, baseline: CanvasTextBaseline): number {
    if (baseline === 'top' || baseline === 'hanging') return y
    if (baseline === 'bottom' || baseline === 'ideographic') return y - height
    if (baseline === 'alphabetic') return y - height * 0.8
    return y - height / 2
}

function rotatedBox(box: TextBox, rotation: number): TextBox {
    if (rotation === 0) return box

    const width = box.maxX - box.minX
    const height = box.maxY - box.minY
    const centerX = (box.minX + box.maxX) / 2
    const centerY = (box.minY + box.maxY) / 2
    const cos = Math.abs(Math.cos(rotation))
    const sin = Math.abs(Math.sin(rotation))
    const rotatedWidth = width * cos + height * sin
    const rotatedHeight = width * sin + height * cos

    return {
        minX: centerX - rotatedWidth / 2,
        minY: centerY - rotatedHeight / 2,
        maxX: centerX + rotatedWidth / 2,
        maxY: centerY + rotatedHeight / 2
    }
}

function boxesOverlap(a: TextBox, b: TextBox): boolean {
    return a.minX < b.maxX
        && a.maxX > b.minX
        && a.minY < b.maxY
        && a.maxY > b.minY
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
