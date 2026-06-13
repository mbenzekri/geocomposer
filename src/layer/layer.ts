import type { BBox, CrsCode } from '../core/geometry.js'
import type { DescInfo, Feature } from '../core/feature.js'
import { Source, type QueryOptions, type StreamOptions } from '../source/source-build.js'
import { Style, type NamedStyle } from '../style/style.js'
import type { StyleFn } from '../style/style-fn.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import { Reproject } from '../stream/reproject.js'
import { Gt } from '../core/geotools.js'
import { Dict, Registry } from '../core/tools.js'
import { Crs } from '../core/crs.js'

export type PointProperties = {
    x: string
    y: string
    crs: CrsCode
}

export type PointPropertiesJson = {
    x: string
    y: string
    crs?: string
}

export type LayerJson = DescInfo & {
    source: string
    crs: string
    extent?: BBox
    style?: string
    styles?: string[]
    pointProperties?: PointPropertiesJson[]
}

export type LayerOptions = {
    title?: string
    summary?: string
    source: Source
    crs: CrsCode
    extent?: BBox
    styles: NamedStyle[]
    pointProperties: PointProperties[]
}

export type LayerStreamOptions = Omit<StreamOptions, 'layer'>
export type LayerQueryOptions = Omit<QueryOptions, 'layer'> & {
    crs?: CrsCode
}
export class Layer {
    static readonly registry = new Registry<Layer>('LAYER')

    readonly title?: string
    readonly summary?: string
    readonly source: Source
    readonly crs: CrsCode
    readonly extent?: BBox
    readonly styles: readonly NamedStyle[]
    readonly pointProperties: PointProperties[]

    constructor(
        readonly name: string,
        options: LayerOptions
    ) {
        if (options.styles.length === 0) {
            throw new Error(`Layer "${name}" must define at least one style`)
        }

        this.title = options.title
        this.summary = options.summary
        this.source = options.source
        this.crs = options.crs
        this.extent = options.extent
        this.styles = options.styles
        this.pointProperties = options.pointProperties
    }

    static build(layerEntries: Dict<LayerJson>): Registry<Layer> {
        for (const [name, entry] of Object.entries(layerEntries)) {
            const layer = Layer.create(name, entry)
            Layer.registry.set(layer.name, layer)
        }
        return Layer.registry
    }

    static create(name: string,entry: LayerJson): Layer {
        if (!Source.registry.has(entry.source)) {
            throw new Error(`Unknown source "${entry.source}" in layer "${name}"`)
        }
        const source = Source.registry.get(entry.source)
        const defaultStyleId = entry.style ?? entry.styles?.[0] ?? 'default'
        const styleIds = [...new Set([defaultStyleId, ...(entry.styles ?? [])])]
        const layerStyles = styleIds.map((styleId) => {
            if (!Style.registry.has(styleId)) {
                throw new Error(`Unknown style "${styleId}" in layer "${name}"`)
            }
            const style = Style.registry.get(styleId)
            return style
        })

        const crs = Layer.resolveCrs(entry.crs, `Layer "${name}" crs`)
        const pointProperties: PointProperties[] = []
        for (const pp of entry.pointProperties ?? []) {
            if (pp.x === pp.y) {
                throw new Error(`Layer "${name}" pointProperties must use different x and y properties`)
            }
            pointProperties.push({
                x: pp.x,
                y: pp.y,
                crs: pp.crs ? Layer.resolveCrs(pp.crs, `Layer "${name}" pointProperties crs`) : crs
            })
        }

        return new Layer(name, {
            title: entry.title,
            summary: entry.abstract,
            source,
            crs,
            extent: Gt.normalize(entry.extent, name),
            styles: [...layerStyles.values()],
            pointProperties
        })
    }

    get style(): StyleFn {
        return this.styles[0].style
    }

    async getExtent(): Promise<BBox | null> {
        return this.extent ?? await this.source.getExtent(this)
    }

    stream(options: LayerStreamOptions = {}): ReadableStream<Feature> {
        return this.source.stream({ ...options, layer: this })
    }

    query(options: LayerQueryOptions = {}): ReadableStream<Feature> {
        const crs = options.crs ?? this.crs

        if (crs === this.crs) {
            return this.source.query({
                bbox: options.bbox,
                signal: options.signal,
                properties: options.properties,
                layer: this
            })
        }

        const sourceBbox = options.bbox
            ? Gt.transformBBox(options.bbox, crs, this.crs)
            : undefined
        const input = this.source.query({
            bbox: sourceBbox,
            signal: options.signal,
            properties: options.properties,
            layer: this
        })

        const reprojected = input.pipeThrough(new Reproject(this.crs, crs))
        return options.bbox
            ? reprojected.pipeThrough(new BboxFilter(options.bbox))
            : reprojected
    }

    resolveStyle(name: string | undefined): StyleFn {
        if (!name) return this.style

        const style = this.styles.find((entry) => entry.name === name)
        if (!style) {
            throw new Error(`Unknown style "${name}" for layer "${this.name}"`)
        }

        return style.style
    }

    private static resolveCrs(crs: string, label: string): CrsCode {
        if (!Crs.registry.has(crs)) {
            throw new Error(`${label} "${crs}" is not declared in projections`)
        }

        return Crs.registry.get(crs).code
    }

}
