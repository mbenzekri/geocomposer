import type { BBox, CrsCode } from '../core/geometry.js'
import { RegistryEntry, type DescInfo, type Feature } from '../core/feature.js'
import { Source, type QueryOptions, type StreamOptions } from '../source/source-build.js'
import { Style } from '../style/style.js'
import type { StyleFn } from '../style/style-fn.js'
import { BboxFilter } from '../stream/bbox-filter.js'
import { PageFilter } from '../stream/page-filter.js'
import { Reproject } from '../stream/reproject.js'
import { Gt } from '../core/geotools.js'
import { Dict, Registry } from '../core/tools.js'
import { Crs } from '../core/crs.js'
import { MemSource } from '../source/mem-source.js'

export type PointProperties = {
    x: string
    y: string
    crs?: string
}

export type LayerJson = DescInfo & {
    source?: string
    layer?: string
    dataset?: string
    crs?: string
    extent?: BBox
    style?: string
    pointProperties?: PointProperties[]
}

export type LayerStreamOptions = Omit<StreamOptions, 'layer'>
export type LayerQueryOptions = Omit<QueryOptions, 'layer'> & {
    crs?: CrsCode
}

export class Layer extends RegistryEntry {
    static readonly registry = new Registry<Layer>('LAYER')

    readonly source: Source
    readonly dataset?: string
    readonly crs: CrsCode
    readonly extent?: BBox
    readonly pointProperties: Array<PointProperties & { crs: CrsCode }>
    private readonly styleName: string

    constructor(id: string, entry: LayerJson ) {
        Layer.validateDataReference(id, entry)
        const inheritedLayer = entry.layer ? Layer.registry.get(entry.layer) : undefined
        const styleName = Layer.resolveDefaultStyleName(id, entry, inheritedLayer)
        const crs = Layer.resolveLayerCrs(id, entry, inheritedLayer)
        const pointProperties = Layer.resolvePointProperties(id, entry, crs, inheritedLayer)
        const source = Layer.resolveSource(id, entry, inheritedLayer)

        super(id, {
            title: entry.title ?? inheritedLayer?.title,
            abstract: entry.abstract ?? inheritedLayer?.abstract
        })

        this.source = source
        this.dataset = entry.source ? entry.dataset : undefined
        this.crs = crs
        this.extent = entry.extent !== undefined
            ? Gt.normalize(entry.extent, id)
            : inheritedLayer?.extent
        this.pointProperties = pointProperties
        this.styleName = styleName
    }

    static build(layerEntries: Dict<LayerJson>): Registry<Layer> {
        const pending = new Map(Object.entries(layerEntries).filter(([name]) => !Layer.registry.has(name)))

        while (pending.size > 0) {
            let progressed = false

            for (const [name, entry] of pending) {
                if (!Layer.canBuild(entry)) continue

                const layer = new Layer(name, entry)
                Layer.registry.set(layer.id, layer)
                pending.delete(name)
                progressed = true
            }

            if (!progressed) {
                const unresolved = pending.entries().next().value
                if (!unresolved) break
                const [name, entry] = unresolved
                Layer.assertBuildable(name, entry)
            }
        }

        return Layer.registry
    }

    private static canBuild(entry: LayerJson): boolean {
        if (entry.source && entry.layer) return false
        if (entry.source) return Source.registry.has(entry.source)
        if (entry.layer) return Layer.registry.has(entry.layer)
        return false
    }

    private static assertBuildable(name: string, entry: LayerJson): never {
        if (entry.source && entry.layer) {
            throw new Error(`Layer "${name}" must define either source or layer, not both`)
        }

        if (entry.source) {
            throw new Error(`Unknown source "${entry.source}" in layer "${name}"`)
        }

        if (entry.layer) {
            throw new Error(`Unknown layer "${entry.layer}" in layer "${name}"`)
        }

        throw new Error(`Layer "${name}" must define either source or layer`)
    }

    private static validateDataReference(name: string, entry: LayerJson): void {
        if (entry.source && entry.layer) {
            throw new Error(`Layer "${name}" must define either source or layer, not both`)
        }

        if (entry.layer && entry.dataset !== undefined) {
            throw new Error(`Layer "${name}" cannot override dataset when it references layer "${entry.layer}"`)
        }
    }

    private static resolveSource(name: string, entry: LayerJson, inheritedLayer: Layer | undefined): Source {
        if (entry.source) return Source.registry.get(entry.source)

        if (!entry.layer || !inheritedLayer) {
            throw new Error(`Layer "${name}" must define either source or layer`)
        }

        if (Source.registry.has(name)) {
            throw new Error(`Cannot create memory source for layer "${name}" because source "${name}" already exists`)
        }

        const source = new MemSource(name, inheritedLayer)
        Source.registry.set(name, source)
        return source
    }

    private static resolvePointProperties(
        name: string,
        entry: LayerJson,
        crs: CrsCode,
        inheritedLayer: Layer | undefined
    ): Array<PointProperties & { crs: CrsCode }> {
        if (entry.pointProperties === undefined && inheritedLayer) {
            return inheritedLayer.pointProperties.map((pp) => ({ ...pp }))
        }

        const pointProperties: Array<PointProperties & { crs: CrsCode }> = []
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

        return pointProperties
    }

    get style(): StyleFn {
        return this.resolveStyle(this.styleName)
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
                limit: options.limit,
                offset: options.offset,
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
        let output = options.bbox
            ? reprojected.pipeThrough(new BboxFilter(options.bbox))
            : reprojected

        if (options.offset !== undefined || options.limit !== undefined) {
            output = output.pipeThrough(new PageFilter({
                offset: options.offset,
                limit: options.limit
            }))
        }

        return output
    }

    resolveStyle(name: string | undefined): StyleFn {
        const styleName = name ?? this.styleName

        if (!Style.registry.has(styleName)) {
            throw new Error(`Unknown style "${styleName}"`)
        }

        return Style.registry.get(styleName).style
    }

    private static resolveDefaultStyleName(name: string, entry: LayerJson, inheritedLayer: Layer | undefined): string {
        const styleName = entry.style ?? inheritedLayer?.styleName ?? 'default'

        if (!Style.registry.has(styleName)) {
            throw new Error(`Unknown style "${styleName}" in layer "${name}"`)
        }

        return styleName
    }

    private static resolveLayerCrs(name: string, entry: LayerJson, inheritedLayer: Layer | undefined): CrsCode {
        if (inheritedLayer) {
            if (!entry.crs) return inheritedLayer.crs

            const crs = Layer.resolveCrs(entry.crs, `Layer "${name}" crs`)
            if (crs !== inheritedLayer.crs) {
                throw new Error(`Layer "${name}" cannot override crs "${inheritedLayer.crs}" from layer "${inheritedLayer.id}" with "${crs}"`)
            }

            return inheritedLayer.crs
        }

        if (!entry.crs) {
            throw new Error(`Layer "${name}" must define crs`)
        }

        return Layer.resolveCrs(entry.crs, `Layer "${name}" crs`)
    }

    private static resolveCrs(crs: string, label: string): CrsCode {
        if (!Crs.registry.has(crs)) {
            throw new Error(`${label} "${crs}" is not declared in projections`)
        }

        return Crs.registry.get(crs).code
    }

}
