import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Layer, type LayerStyle } from '../layer/layer.js'
import type { WmsInfo, WmsOptions } from '../service/wms.js'
import { GeoJsonSource } from '../source/geojson-source.js'
import { GmlSource, type GmlAxisOrder } from '../source/gml-source.js'
import { GpkgSource } from '../source/gpkg-source.js'
import { MemSource } from '../source/mem-source.js'
import { ShpSource } from '../source/shp-source.js'
import type { Source } from '../source/source.js'
import { createDynamicStyleFn, type DynamicStyleJson } from '../style/dynamic-style.js'
import { defaultStyleFn } from '../style/default-style.js'
import type { StyleFn } from '../style/style-fn.js'
import type { XyzOptions } from '../service/xyz.js'
import type { WmtsInfo, WmtsOptions } from '../service/wmts.js'
import { Tileset } from '../tileset/tileset.js'
import { Gt } from '../core/geotools.js'
import { BBox, CrsCode } from '../core/geometry.js'

export type NamedConfig<T> = Record<string, T>

export type ProjectionJson = {
    title: string
}

export type GeoJsonSourceJson = {
    type: 'geojson'
    title?: string
    abstract?: string
    crs?: string
    path: string
    encoding?: BufferEncoding
    highWaterMark?: number
}

export type GmlSourceJson = {
    type: 'gml'
    title?: string
    abstract?: string
    crs?: string
    path: string
    encoding?: BufferEncoding
    highWaterMark?: number
    featureElementNames?: string[]
    geometryPropertyNames?: string[]
    axisOrder?: GmlAxisOrder
}

export type ShpSourceJson = {
    type: 'shp'
    title?: string
    abstract?: string
    crs?: string
    shpPath: string
    dbfPath: string
    dbfEncoding?: BufferEncoding
    highWaterMark?: number
}

export type GpkgSourceJson = {
    type: 'gpkg'
    title?: string
    abstract?: string
    crs?: string
    path: string
    tableName?: string
    geometryColumn?: string
    primaryKey?: string
}

export type MemSourceJson = {
    type: 'mem'
    title?: string
    abstract?: string
    source: string
}

export type SourceJson =
    | GeoJsonSourceJson
    | GmlSourceJson
    | ShpSourceJson
    | GpkgSourceJson
    | MemSourceJson

export type BuiltinStyleJson = {
    type: 'builtin'
    title?: string
    abstract?: string
}

export type DynamicStyleOptionsJson = {
    units?: 'm' | 'dd'
    dotsPerInch?: number
}

export type DynamicStyleFileJson = {
    type: 'dynamic'
    title?: string
    abstract?: string
    path: string
    options?: DynamicStyleOptionsJson
}

export type StyleJson = BuiltinStyleJson | DynamicStyleFileJson

export type PointPropertiesJson = {
    x: string,
    y: string,
    crs?: string
}
export type LayerJson = {
    title?: string
    abstract?: string
    source: string
    sourceCrs?: string
    extent?: BBox
    style?: string
    styles?: string[]
    pointProperties?: PointPropertiesJson[]
}

export type ServerJson = {
    port?: number
}

export type TilesetLayerJson = {
    layer: string
    style?: string
}

export type TilesetJson = {
    title?: string
    abstract?: string
    tileMatrixSet?: string
    format?: string
    tileSize?: number
    minZoom?: number
    maxZoom?: number
    cacheControl?: string
    layers: TilesetLayerJson[]
}

export type XyzJson = {
    path?: string
    maxScaleFactor?: number
    cache?: string
    tilesets?: string[]
}

export type WmsJson = WmsInfo & {
    path?: string
    maxWidth?: number
    maxHeight?: number
    layers?: string[]
}

export type WmtsJson = WmtsInfo & {
    path?: string
    cache?: string
    tilesets?: string[]
}

export type ServicesJson = {
    wms: WmsJson
    xyz?: XyzJson
    wmts?: WmtsJson
}

export type GeoComposerJson = {
    $schema?: string
    server?: ServerJson
    services: ServicesJson
    projections?: NamedConfig<ProjectionJson>
    sources: NamedConfig<SourceJson>
    styles?: NamedConfig<StyleJson>
    layers: NamedConfig<LayerJson>
    tilesets?: NamedConfig<TilesetJson>
}

export type LoadedConfig = {
    path: string
    dir: string
    server: Required<ServerJson>
    wms: WmsOptions
    xyz?: XyzOptions
    wmts?: WmtsOptions
}

const BUILTIN_STYLES: Record<string, StyleFn> = {
    default: defaultStyleFn
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
    const path = resolve(configPath)
    const dir = dirname(path)
    const config = await readJsonFile<GeoComposerJson>(path)
    const crs = new CrsRegistry(config.projections)
    const sources = createSources(config.sources, dir, crs)
    const styles = await createStyles(config.styles ?? {}, dir)
    const layers = createLayers(config.layers, sources, styles, crs)
    const tilesets = createTilesets(config.tilesets ?? {}, layers)
    const xyz = config.services.xyz ? createXyzOptions(config.services.xyz, tilesets, dir) : undefined
    const wmts = config.services.wmts ? createWmtsOptions(config.services.wmts, tilesets, dir) : undefined
    const wmsLayers = selectLayers(config.services.wms.layers, layers, 'WMS')
    const wmsCrs = crs.codes()

    return {
        path,
        dir,
        server: {
            port: config.server?.port ?? 3000
        },
        wms: {
            path: config.services.wms.path ?? '/wms',
            maxWidth: config.services.wms.maxWidth ?? 4096,
            maxHeight: config.services.wms.maxHeight ?? 4096,
            info: {
                title: config.services.wms.title,
                abstract: config.services.wms.abstract,
                onlineResource: config.services.wms.onlineResource
            },
            ...(wmsCrs.length > 0 ? { crs: wmsCrs } : {}),
            layers: wmsLayers
        },
        ...(xyz ? { xyz } : {}),
        ...(wmts ? { wmts } : {})
    }
}

async function readJsonFile<T>(path: string): Promise<T> {
    let text: string

    try {
        text = await readFile(path, 'utf8')
    } catch (error) {
        throw new Error(`Unable to read JSON file ${path}: ${String(error)}`)
    }

    try {
        return JSON.parse(text) as T
    } catch (error) {
        throw new Error(`Invalid JSON in ${path}: ${String(error)}`)
    }
}

function createSources(
    sourceEntries: NamedConfig<SourceJson>,
    baseDir: string,
    crs: CrsRegistry
): Map<string, Source> {
    const sourceEntriesByName = new Map(Object.entries(sourceEntries))
    const sources = new Map<string, Source>()
    const creating = new Set<string>()

    const resolveSource = (name: string): Source => {
        const existing = sources.get(name)
        if (existing) return existing

        const entry = sourceEntriesByName.get(name)
        if (!entry) {
            throw new Error(`Unknown source "${name}"`)
        }

        if (creating.has(name)) {
            throw new Error(`Circular source reference involving "${name}"`)
        }

        creating.add(name)
        try {
            const source = createSource(name, entry, baseDir, crs, resolveSource)
            sources.set(name, source)
            return source
        } finally {
            creating.delete(name)
        }
    }

    for (const name of sourceEntriesByName.keys()) {
        resolveSource(name)
    }

    return sources
}

function createSource(
    name: string,
    entry: SourceJson,
    baseDir: string,
    crs: CrsRegistry,
    resolveSource: (name: string) => Source
): Source {
    switch (entry.type) {
        case 'geojson':
            return new GeoJsonSource(name, resolve(baseDir, entry.path), {
                crs: crs.resolve(entry.crs),
                encoding: entry.encoding,
                highWaterMark: entry.highWaterMark
            })

        case 'gml':
            return new GmlSource(name, resolve(baseDir, entry.path), {
                crs: crs.resolve(entry.crs),
                encoding: entry.encoding,
                highWaterMark: entry.highWaterMark,
                featureElementNames: entry.featureElementNames,
                geometryPropertyNames: entry.geometryPropertyNames,
                axisOrder: entry.axisOrder
            })

        case 'shp':
            return new ShpSource(
                name,
                resolve(baseDir, entry.shpPath),
                resolve(baseDir, entry.dbfPath),
                {
                    crs: crs.resolve(entry.crs),
                    dbfEncoding: entry.dbfEncoding,
                    highWaterMark: entry.highWaterMark
                }
            )

        case 'gpkg':
            return new GpkgSource(name, resolve(baseDir, entry.path), {
                crs: crs.resolve(entry.crs),
                tableName: entry.tableName,
                geometryColumn: entry.geometryColumn,
                primaryKey: entry.primaryKey
            })

        case 'mem':
            return new MemSource(name, resolveSource(entry.source))
    }
}

async function createStyles(
    styleEntries: NamedConfig<StyleJson>,
    baseDir: string
): Promise<Map<string, LayerStyle>> {
    const styles = new Map<string, LayerStyle>([
        [
            'default',
            {
                name: 'default',
                title: 'Default',
                style: defaultStyleFn
            }
        ]
    ])

    for (const [name, entry] of Object.entries(styleEntries)) {
        styles.set(name, await createStyle(name, entry, baseDir))
    }

    return styles
}

async function createStyle(name: string, entry: StyleJson, baseDir: string): Promise<LayerStyle> {
    switch (entry.type) {
        case 'builtin':
            if (!BUILTIN_STYLES[name]) {
                throw new Error(`Unknown builtin style "${name}"`)
            }

            return {
                name,
                title: entry.title ?? titleFromId(name),
                summary: entry.abstract,
                style: BUILTIN_STYLES[name]
            }

        case 'dynamic': {
            const json = await readJsonFile<DynamicStyleJson>(resolve(baseDir, entry.path))
            const style = await createDynamicStyleFn(name, json, {
                units: entry.options?.units,
                dotsPerInch: entry.options?.dotsPerInch
            })
            return {
                name,
                title: entry.title ?? json.title ?? titleFromId(name),
                summary: entry.abstract,
                style
            }
        }
    }
}

function createLayers(
    layerEntries: NamedConfig<LayerJson>,
    sources: Map<string, Source>,
    styles: Map<string, LayerStyle>,
    crsReg: CrsRegistry
): Layer[] {
    return Object.entries(layerEntries).map(([name, entry]) => {
        const source = sources.get(entry.source)
        if (!source) {
            throw new Error(`Unknown source "${entry.source}" in layer "${name}"`)
        }

        const defaultStyleId = entry.style ?? entry.styles?.[0] ?? 'default'
        const styleIds = unique([defaultStyleId, ...(entry.styles ?? [])])

        const layerStyles = styleIds.map((styleId) => {
            const style = styles.get(styleId)
            if (!style) {
                throw new Error(`Unknown style "${styleId}" in layer "${name}"`)
            }

            return style
        })
        const sourceCrs = normalizeSourceCrs(entry.sourceCrs, source, name, crsReg)
        const pointProperties = []
        for (let pp of entry.pointProperties ?? []) {
            const crs = normalizeSourceCrs(pp.crs, source, name, crsReg)
            pointProperties.push({ x: pp.x, y: pp.y, crs })
        }
        console.log(`----- Point Properties: ${JSON.stringify(pointProperties)}`)
        return new Layer(name, {
            title: entry.title,
            summary: entry.abstract,
            source,
            sourceCrs,
            extent: Gt.normalize(entry.extent, name),
            styles: layerStyles,
            pointProperties
        })
    })
}

function createXyzOptions(xyz: XyzJson, tilesets: Tileset[], baseDir: string): XyzOptions {
    return {
        path: xyz.path,
        maxScaleFactor: xyz.maxScaleFactor,
        cache: xyz.cache ? resolve(baseDir, xyz.cache) : undefined,
        tilesets: selectTilesets(xyz.tilesets, tilesets, 'XYZ')
    }
}

function createWmtsOptions(wmts: WmtsJson, tilesets: Tileset[], baseDir: string): WmtsOptions {
    return {
        path: wmts.path,
        info: {
            title: wmts.title,
            abstract: wmts.abstract,
            onlineResource: wmts.onlineResource
        },
        cache: wmts.cache ? resolve(baseDir, wmts.cache) : undefined,
        tilesets: selectTilesets(wmts.tilesets, tilesets, 'WMTS')
    }
}

function createTilesets(tilesetEntries: NamedConfig<TilesetJson>, layers: Layer[]): Tileset[] {
    const layersByName = new Map(layers.map((layer) => [layer.name, layer]))
    return Object.entries(tilesetEntries).map(([name, entry]) => createTileset(name, entry, layersByName))
}

function createTileset(
    name: string,
    entry: TilesetJson,
    layersByName: Map<string, Layer>
): Tileset {
    const layerRefs = normalizeTilesetLayers(name, entry)
    if (layerRefs.length === 0) {
        throw new Error(`Tileset "${name}" must reference at least one configured layer`)
    }

    return new Tileset({
        name,
        title: entry.title,
        summary: entry.abstract,
        tileMatrixSet: entry.tileMatrixSet,
        format: entry.format,
        tileSize: entry.tileSize,
        minZoom: entry.minZoom,
        maxZoom: entry.maxZoom,
        cacheControl: entry.cacheControl,
        layers: layerRefs.map((ref) => {
            const layer = layersByName.get(ref.layer)
            if (!layer) {
                throw new Error(`Unknown layer "${ref.layer}" in tileset "${name}"`)
            }

            validateTilesetLayerStyle(layer, ref.style, name)

            return layer
        }),
        styles: layerRefs.map((ref) => {
            const layer = layersByName.get(ref.layer)
            if (!layer) {
                throw new Error(`Unknown layer "${ref.layer}" in tileset "${name}"`)
            }

            validateTilesetLayerStyle(layer, ref.style, name)

            return ref.style ?? "default"
        })
    })
}

function normalizeTilesetLayers(name: string, entry: TilesetJson): TilesetLayerJson[] {
    if (!entry.layers || entry.layers.length === 0) {
        throw new Error(`Tileset "${name}" must define at least one entry in "layers"`)
    }

    return entry.layers.map((ref) => ({
        layer: ref.layer,
        style: ref.style
    }))
}

function validateTilesetLayerStyle(layer: Layer, styleName: string | undefined, tilesetName: string): void {
    try {
        layer.resolveStyle(styleName)
    } catch (error) {
        if (!styleName) throw error
        throw new Error(`Unknown style "${styleName}" for layer "${layer.name}" in tileset "${tilesetName}"`)
    }
}

function selectTilesets(tilesetNames: string[] | undefined, tilesets: Tileset[], serviceName: string): Tileset[] {
    if (!tilesetNames) {
        if (tilesets.length === 0) {
            throw new Error(`${serviceName} service requires at least one configured tileset`)
        }

        return tilesets
    }

    const tilesetsByName = new Map(tilesets.map((tileset) => [tileset.name, tileset]))
    const selected = tilesetNames.map((name) => {
        const tileset = tilesetsByName.get(name)
        if (!tileset) {
            throw new Error(`Unknown tileset "${name}" in ${serviceName} service`)
        }

        return tileset
    })

    if (selected.length === 0) {
        throw new Error(`${serviceName} service requires at least one tileset`)
    }

    return selected
}

function selectLayers(layerNames: string[] | undefined, layers: Layer[], serviceName: string): Layer[] {
    if (!layerNames) return layers

    const layersByName = new Map(layers.map((layer) => [layer.name, layer]))
    return layerNames.map((name) => {
        const layer = layersByName.get(name)
        if (!layer) {
            throw new Error(`Unknown layer "${name}" in ${serviceName} service`)
        }

        return layer
    })
}

function normalizeSourceCrs(
    sourceCrs: string | undefined,
    source: Source,
    layerName: string,
    crs: CrsRegistry
): CrsCode {
    const resolved = crs.resolve(sourceCrs) ?? source.crs

    if (resolved !== source.crs) {
        throw new Error(`Layer "${layerName}" sourceCrs "${resolved}" does not match source "${source.id}" CRS "${source.crs}"`)
    }

    return resolved
}

function titleFromId(id: string): string {
    return id
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' ') || id
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)]
}

class CrsRegistry {
    private readonly refs = new Map<string, CrsCode>()

    constructor(entries: NamedConfig<ProjectionJson> = {}) {
        for (const name of Object.keys(entries)) {
            this.refs.set(name, name)
        }
    }

    resolve(name: string | undefined): CrsCode | undefined {
        if (!name) return undefined
        return this.refs.get(name) ?? name
    }

    codes(): CrsCode[] {
        return [...new Set(this.refs.values())]
    }
}
