import {
    Canvas,
    CanvasRenderingContext2D,
    createCanvas
} from 'canvas'
import './openlayers-node-shim.js'
import ImageState from 'ol/ImageState.js'
import { toContext } from 'ol/render.js'
import type Style from 'ol/style/Style.js'
import type { BBox } from '../core/types.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import type { StyleResolver } from '../style/style-resolver.js'
import { transformGeometryToPixels } from '../transform/world-to-pixel-transform.js'
import { OlGeometryAdapter } from './ol-geometry-adapter.js'

export class OpenLayersCanvasRenderer {
    private readonly canvas: Canvas
    private readonly context: CanvasRenderingContext2D
    private readonly vectorContext: ReturnType<typeof toContext>
    private readonly geometryAdapter = new OlGeometryAdapter()

    constructor(
        readonly width: number,
        readonly height: number,
        private readonly bbox: BBox,
        private readonly styleResolver: StyleResolver,
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

    async draw(feature: GeoFeature): Promise<void> {
        if (!feature.geometry) return

        const styles = this.styleResolver(feature, this.resolution)
        if (!styles) return

        const pixelGeometry = transformGeometryToPixels(feature.geometry, this.bbox, this.width, this.height)
        if (!pixelGeometry) return

        const geometry = this.geometryAdapter.toGeometry(pixelGeometry)
        const styleList = Array.isArray(styles) ? styles : [styles]

        for (const style of styleList) {
            await waitForStyleImages(style)
            this.vectorContext.setStyle(style)
            this.vectorContext.drawGeometry(geometry)
        }
    }

    toPngBuffer(): Buffer {
        return this.canvas.toBuffer('image/png')
    }
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
