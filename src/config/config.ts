import { dirname, resolve } from 'node:path'
import { Layer, type NamedStyle } from '../layer/layer.js'
import { Service } from '../service/service.js'
import { GeoJsonSource } from '../source/geojson-source.js'
import { GmlSource, type GmlAxisOrder } from '../source/gml-source.js'
import { GpkgSource } from '../source/gpkg-source.js'
import { MemSource } from '../source/mem-source.js'
import { PostgisSource, type PostgisConnectionOptions, type PostgisExtentStrategy } from '../source/postgis-source.js'
import { ShpSource } from '../source/shp-source.js'
import type { Source } from '../source/source.js'
import { createDynamicStyleFn, type DynamicStyleJson } from '../style/dynamic-style.js'
import { defaultStyleFn } from '../style/default-style.js'
import type { StyleFn } from '../style/style-fn.js'
import { Xyz, type XyzOptions } from '../service/xyz.js'
import { Wmts, type WmtsOptions } from '../service/wmts.js'
import { Wms, WmsOptions } from '../service/wms.js'
import { Tileset } from '../tileset/tileset.js'
import type { VectorTileOptions } from '../tileset/tileset.js'
import { Gt } from '../core/geotools.js'
import { Dict, Registry, Singleton } from '../core/tools.js'
import { BBox, CrsCode } from '../core/geometry.js'
import { JsonSchemaValidator } from './json-schema-validator.js'
import { DescInfo, ServiceInfo } from '../core/feature.js'
import { ConfigEnvResolver } from './config-env-resolver.js'


export type ProjectionJson = {
    title: string
}

export type GeoJsonSourceJson = DescInfo & {
    type: 'geojson'
    path: string
    crs?: string
    encoding?: BufferEncoding
    highWaterMark?: number
}

export type GmlSourceJson = DescInfo &  {
    type: 'gml'
    crs?: string
    path: string
    encoding?: BufferEncoding
    highWaterMark?: number
    featureElementNames?: string[]
    geometryPropertyNames?: string[]
    axisOrder?: GmlAxisOrder
}

export type ShpSourceJson = DescInfo & {
    type: 'shp'
    crs?: string
    shpPath: string
    dbfPath: string
    dbfEncoding?: BufferEncoding
    highWaterMark?: number
}

export type GpkgSourceJson = DescInfo & {
    type: 'gpkg'
    crs?: string
    path: string
    tableName?: string
    geometryColumn?: string
    primaryKey?: string
}

export type PostgisSourceJson = DescInfo & {
    type: 'postgis'
    crs?: string
    connection: PostgisConnectionOptions
    schema?: string
    tableName: string
    geometryColumn?: string
    primaryKey?: string
    srid?: number
    properties?: string[]
    batchSize?: number
    extentStrategy?: PostgisExtentStrategy
}

export type MemSourceJson = DescInfo & {
    type: 'mem'
    source: string
}

export type SourceJson =
    | GeoJsonSourceJson
    | GmlSourceJson
    | ShpSourceJson
    | GpkgSourceJson
    | PostgisSourceJson
    | MemSourceJson

export type BuiltinStyleJson = DescInfo & {
    type: 'builtin'
}

export type DynamicStyleOptionsJson = {
    units?: 'm' | 'dd'
    dotsPerInch?: number
}

export type DynamicStyleFileJson = DescInfo & {
    type: 'dynamic'
    path: string
    options?: DynamicStyleOptionsJson
}

export type StyleJson = BuiltinStyleJson | DynamicStyleFileJson

export type PointPropertiesJson = {
    x: string,
    y: string,
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

export type ServerJson = {
    port?: number
}

export type TilesetLayerJson = {
    layer: string
    style?: string
}

export type TilesetJson = DescInfo & {
    tileMatrixSet?: string
    formats: string[]
    tileSize?: number
    minZoom?: number
    maxZoom?: number
    cacheControl?: string
    vector?: VectorTileOptions
    layers: TilesetLayerJson[]
}

export type XyzJson = DescInfo & ServiceInfo & {
    maxScaleFactor?: number
    cache?: string
    tilesets?: string[]
}


export type WmsJson = DescInfo & ServiceInfo & {
    maxWidth?: number
    maxHeight?: number
    layers?: string[]
}

export type WmtsJson = DescInfo & ServiceInfo & {
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
    projections?: Dict<ProjectionJson>
    sources: Dict<SourceJson>
    styles?: Dict<StyleJson>
    layers: Dict<LayerJson>
    tilesets?: Dict<TilesetJson>
}

const BUILTIN_STYLES: Dict<StyleFn> = {
    default: defaultStyleFn
}
const CONFIG_SCHEMA_FILE = 'config.schema.json'
const DYNAMIC_STYLE_SCHEMA_FILE = 'dynamic-style.schema.json'

export class Config extends Singleton {

    readonly path: string
    readonly dir: string
    private _port?: number
    get port(): number {  return this._port ?? 3000}
    private loaded = false
    
    readonly serviceReg = new Registry<Service>('Service')
    readonly sourceReg = new Registry<Source>('Source')
    readonly layerReg = new Registry<Layer>('Layer')
    readonly styleReg = new Registry<NamedStyle>('Style')
    readonly crsReg = new Registry<CrsCode>('CRS')
    readonly tilesetReg = new Registry<Tileset>('Tileset')

    constructor(configPath: string, port?:number) {
        super()
        this.path = resolve(configPath)
        this.dir = dirname(this.path)
        this._port = port 
    }


    static async load(configPath: string, port?:number): Promise<Config> {
        const path = resolve(configPath)
        return new Config(path,port).load()
    }

    async load(): Promise<this> {
        const config = Config.instance()
        if (config && config !== this) {
            throw new Error(`Config singleton already loaded from ${config.path}`)
        }

        if (this.loaded) return this

        const configValidator = new JsonSchemaValidator<GeoComposerJson>(
            resolve(this.dir, CONFIG_SCHEMA_FILE), "Configuration Schema", {
                transform: (document) => new ConfigEnvResolver().resolve(document, this.path)
            }
        )
        const json = configValidator.validate(this.path)
        const crs = new CrsRegistry(json.projections)
        const sources = createSources(json.sources, this.dir, crs)
        const styles = await createStyles(json.styles ?? {}, this.dir)
        const layers = createLayers(json.layers, sources, styles, crs)
        const tilesets = createTilesets(json.tilesets ?? {}, layers)
        const xyz = json.services.xyz ? createXyzOptions(json.services.xyz, tilesets, this.dir) : undefined
        const wmts = json.services.wmts ? createWmtsOptions(json.services.wmts, tilesets, this.dir) : undefined
        const wmsLayers = selectLayers(json.services.wms.layers, layers, 'WMS')
        const wmsCrs = crs.codes()
        const wms = createWmsOptions(json.services.wms, wmsCrs,wmsLayers)
        this._port ??=  json.server?.port ?? 3000

        wms && this.serviceReg.set('wms', new Wms(wms))
        xyz && this.serviceReg.set('xyz', new Xyz(xyz))
        wmts && this.serviceReg.set('wmts', new Wmts(wmts))
        this.loaded = true

        console.log(`[Config]: ${this.path} loaded`)

        return this
    }
}


function createSources(
    sourceEntries: Dict<SourceJson>,
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

        case 'postgis':
            return new PostgisSource(name, {
                crs: crs.resolve(entry.crs),
                connection: entry.connection,
                schema: entry.schema,
                tableName: entry.tableName,
                geometryColumn: entry.geometryColumn,
                primaryKey: entry.primaryKey,
                srid: entry.srid,
                properties: entry.properties,
                batchSize: entry.batchSize,
                extentStrategy: entry.extentStrategy
            })

        case 'mem':
            return new MemSource(name, resolveSource(entry.source))
    }
}

async function createStyles(
    styleEntries: Dict<StyleJson>,
    baseDir: string
): Promise<Map<string, NamedStyle>> {
    const styles = new Map<string, NamedStyle>([
        [
            'default',
            {
                name: 'default',
                title: 'Default',
                style: defaultStyleFn
            }
        ]
    ])
    const dynamicStyleValidator = new JsonSchemaValidator<DynamicStyleJson>(
        resolve(baseDir, DYNAMIC_STYLE_SCHEMA_FILE), "Dynamic Style Schema"
    )

    for (const [name, entry] of Object.entries(styleEntries)) {
        styles.set(name, await createStyle(name, entry, baseDir, dynamicStyleValidator))
    }

    return styles
}

async function createStyle(
    name: string,
    entry: StyleJson,
    baseDir: string,
    dynamicStyleValidator: JsonSchemaValidator<DynamicStyleJson>
): Promise<NamedStyle> {
    switch (entry.type) {
        case 'builtin':
            if (!BUILTIN_STYLES[name]) {
                throw new Error(`Unknown builtin style "${name}"`)
            }

            return {
                name,
                title: entry.title ?? titleFromId(name),
                abstract: entry.abstract,
                style: BUILTIN_STYLES[name]
            }

        case 'dynamic': {
            const stylePath = resolve(baseDir, entry.path)

            try {
                const json = dynamicStyleValidator.validate(stylePath)
                const style = await createDynamicStyleFn(name, json, {
                    units: entry.options?.units,
                    dotsPerInch: entry.options?.dotsPerInch
                })
                return {
                    name,
                    title: entry.title ?? json.title ?? titleFromId(name),
                    abstract: entry.abstract,
                    style
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`Invalid dynamic style "${name}" at ${stylePath}: ${message}`)
            }
        }
    }
}

function createLayers(
    layerEntries: Dict<LayerJson>,
    sources: Map<string, Source>,
    styles: Map<string, NamedStyle>,
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
            if (pp.x === pp.y) {
                throw new Error(`Layer "${name}" pointProperties must use different x and y properties`)
            }

            const crs = normalizeSourceCrs(pp.crs, source, name, crsReg)
            pointProperties.push({ x: pp.x, y: pp.y, crs })
        }
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


function createWmsOptions(wms: WmsJson, crs: string[],layers: Layer[]): WmsOptions {
    return {
            title: wms.title,
            abstract: wms.abstract,
            path: wms.path ?? '/wms',
            maxWidth: wms.maxWidth ?? 4096,
            maxHeight: wms.maxHeight ?? 4096,
            onlineResource: wms.onlineResource,
            crs,
            layers
        }
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
        title: wmts.title,
        abstract: wmts.abstract,
        onlineResource: wmts.onlineResource,
        cache: wmts.cache ? resolve(baseDir, wmts.cache) : undefined,
        tilesets: selectTilesets(wmts.tilesets, tilesets, 'WMTS')
    }
}

function createTilesets(tilesetEntries: Dict<TilesetJson>, layers: Layer[]): Tileset[] {
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
        formats: entry.formats,
        tileSize: entry.tileSize,
        minZoom: entry.minZoom,
        maxZoom: entry.maxZoom,
        cacheControl: entry.cacheControl,
        vector: entry.vector,
        layers: layerRefs.map((ref) => {
            const layer = layersByName.get(ref.layer)
            if (!layer) {
                throw new Error(`Unknown layer "${ref.layer}" in tileset "${name}"`)
            }

            validateTilesetNamedStyle(layer, ref.style, name)

            return layer
        }),
        styles: layerRefs.map((ref) => {
            const layer = layersByName.get(ref.layer)
            if (!layer) {
                throw new Error(`Unknown layer "${ref.layer}" in tileset "${name}"`)
            }

            validateTilesetNamedStyle(layer, ref.style, name)

            return ref.style
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

function validateTilesetNamedStyle(layer: Layer, styleName: string | undefined, tilesetName: string): void {
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

    constructor(entries: Dict<ProjectionJson> = {}) {
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
