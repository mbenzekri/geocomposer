import type { BBox, CrsCode } from '../core/geometry.js'
import type { DescInfo, Feature } from '../core/feature.js'
import type { QueryOptions, Source, StreamOptions } from '../source/source.js'
import type { NamedStyle } from '../style/style.js'
import type { StyleFn } from '../style/style-fn.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import { Reproject } from '../stream/reproject.js'
import { Gt } from '../core/geotools.js'
import { Dict, Registry } from '../core/tools.js'

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
    sourceCrs?: string
    extent?: BBox
    style?: string
    styles?: string[]
    pointProperties?: PointPropertiesJson[]
}

export type LayerOptions = {
    title?: string
    summary?: string
    source: Source
    sourceCrs?: CrsCode
    extent?: BBox
    styles: NamedStyle[]
    pointProperties: PointProperties[]
}

export type LayerStreamOptions = Omit<StreamOptions, 'layer'>
export type LayerQueryOptions = Omit<QueryOptions, 'layer'>
export class Layer {
    readonly title?: string
    readonly summary?: string
    readonly source: Source
    readonly sourceCrs: CrsCode
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
        this.sourceCrs = options.sourceCrs ?? options.source.crs
        this.extent = options.extent
        this.styles = options.styles
        this.pointProperties = options.pointProperties
    }

    static createAll(layerEntries: Dict<LayerJson>, crsReg: Registry<CrsCode>, styReg: Registry<NamedStyle>, srcReg: Registry<Source>): Registry<Layer> {
        const lyrReg = new Registry<Layer>('LAYER')

        for (const [name, entry] of Object.entries(layerEntries)) {
            const layer = Layer.create(name, entry, crsReg, styReg, srcReg, lyrReg)
            lyrReg.set(layer.name, layer)
        }
        return lyrReg
    }

    static create(
        name: string,
        entry: LayerJson,
        crsReg: Registry<CrsCode>,
        styReg: Registry<NamedStyle>,
        srcReg: Registry<Source>,
        lyrReg: Registry<Layer>,
    ): Layer {
        if (!srcReg.has(entry.source)) {
            throw new Error(`Unknown source "${entry.source}" in layer "${name}"`)
        }
        const source = srcReg.get(entry.source)
        const defaultStyleId = entry.style ?? entry.styles?.[0] ?? 'default'
        const styleIds = [...new Set([defaultStyleId, ...(entry.styles ?? [])])]
        const layerStyles = styleIds.map((styleId) => {
            if (!styReg.has(styleId)) {
                throw new Error(`Unknown style "${styleId}" in layer "${name}"`)
            }
            const style = styReg.get(styleId)
            return style
        })

        const sourceCrs = Layer.normalizeSourceCrs(entry.sourceCrs, source, name, crsReg)
        const pointProperties: PointProperties[] = []
        for (const pp of entry.pointProperties ?? []) {
            if (pp.x === pp.y) {
                throw new Error(`Layer "${name}" pointProperties must use different x and y properties`)
            }
            pointProperties.push({
                x: pp.x,
                y: pp.y,
                crs: Layer.normalizeSourceCrs(pp.crs, source, name, crsReg)
            })
        }

        return new Layer(name, {
            title: entry.title,
            summary: entry.abstract,
            source,
            sourceCrs,
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
        const crs = options.crs ?? this.sourceCrs

        if (crs === this.sourceCrs) {
            return this.source.query({
                bbox: options.bbox,
                signal: options.signal,
                properties: options.properties,
                layer: this
            })
        }

        const sourceBbox = options.bbox
            ? Gt.transformBBox(options.bbox, crs, this.sourceCrs)
            : undefined
        const input = this.source.query({
            bbox: sourceBbox,
            signal: options.signal,
            properties: options.properties,
            layer: this
        })

        const reprojected = input.pipeThrough(new Reproject(this.sourceCrs, crs))
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

    private static normalizeSourceCrs(sourceCrs: string | undefined, source: Source, layerName: string, crs: Registry<CrsCode>): CrsCode {

        const resolved = sourceCrs ? crs.get(sourceCrs) : source.crs
        if (resolved == source.crs) return resolved
        throw new Error(`Layer "${layerName}" sourceCrs "${resolved}" does not match source "${source.id}" CRS "${source.crs}"`)
    }

}

