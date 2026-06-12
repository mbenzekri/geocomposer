import { dirname, resolve } from 'node:path'
import { Dict, Registry, Singleton } from '../core/tools.js'
import { BBox, CrsCode } from '../core/geometry.js'

import { Service } from '../service/service.js'
import { Xyz } from '../service/xyz.js'
import { Wmts } from '../service/wmts.js'
import { Wms } from '../service/wms.js'
import { Source } from '../source/source.js'
import { type GmlAxisOrder } from '../source/gml-source.js'
import type { PostgisConnectionOptions, PostgisExtentStrategy } from '../source/postgis-source.js'

import { Layer, type NamedStyle } from '../layer/layer.js'

import { createDynamicStyleFn, type DynamicStyleJson } from '../style/dynamic-style.js'
import { defaultStyleFn } from '../style/default-style.js'
import { type StyleFn } from '../style/style-fn.js'

import { Tileset } from '../tileset/tileset.js'
import type { VectorTileOptions } from '../tileset/tileset.js'
import { JsonValidator } from '../core/json-validator.js'
import { DescInfo, ServiceInfo } from '../core/feature.js'

import { EnvSolver } from './env-solver.js'
import { DefsSolver } from './defs-solver.js'
import { LogLevel} from "../core/log-level.js"


class ConfigValidator extends JsonValidator<GeoComposerJson> {
    protected transform(document: unknown): unknown {
            const envSolved = new EnvSolver().solve(document)
            const defsAndEnvSolved =  new DefsSolver().solve(envSolved)
            return defsAndEnvSolved
    }
}

class StyleValidator extends JsonValidator<DynamicStyleJson> {
    protected transform(document: unknown): unknown {
            const envSolved = new DefsSolver('dynamic style').solve(document, 'dynamic style')
            return envSolved
    }
}

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

export type GmlSourceJson = DescInfo & {
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
    logLevel?: "DEBUG" | "LOG" | "WARN" | "ERROR" | "NONE"
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
    $defs?: Dict<unknown>
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
const DYNAMIC_STYLE_SCHEMA_FILE = 'dynstyle.schema.json'

export class Config extends Singleton {

    readonly path: string
    readonly dir: string
    private _port?: number
    get port(): number { return this._port ?? 3000 }
    private loaded = false

    readonly serviceReg = new Registry<Service>('Service')
    readonly sourceReg = new Registry<Source>('Source')
    readonly layerReg = new Registry<Layer>('Layer')
    readonly styleReg = new Registry<NamedStyle>('Style')
    readonly crsReg = new Registry<CrsCode>('CRS')
    readonly tilesetReg = new Registry<Tileset>('Tileset')

    constructor(configPath: string, port?: number) {
        super()
        this.path = resolve(configPath)
        this.dir = dirname(this.path)
        this._port = port
    }


    static async load(configPath: string, port?: number): Promise<Config> {
        const path = resolve(configPath)
        return new Config(path, port).load()
    }

    async load(): Promise<this> {
        const config = Config.instance()
        if (config && config !== this) {
            throw new Error(`Config singleton already loaded from ${config.path}`)
        }

        if (this.loaded) return this
        console.log(`[CONFIG]: ${this.path} loading`)

        const fullpath = resolve(this.dir, CONFIG_SCHEMA_FILE) 
        const configValidator = new ConfigValidator(fullpath, "Configuration Schema")
        const json = configValidator.validate(this.path)
        const crs = new CrsRegistry(json.projections)
        const sources = Source.createAll(json.sources, this.dir, crs)
        const styles = await createStyles(json.styles ?? {}, this.dir)
        const layers = Layer.createAll(json.layers, sources, styles, crs)
        const tilesets = Tileset.createAll(json.tilesets ?? {}, layers)
        const wms = Wms.fromConfig(json.services.wms, crs.codes(), layers)
        const xyz = json.services.xyz ? Xyz.fromConfig(json.services.xyz, tilesets, this.dir) : undefined
        const wmts = json.services.wmts ? Wmts.fromConfig(json.services.wmts, tilesets, this.dir) : undefined

        this._port ??= json.server?.port ?? 3000
        console.log(`[CONFIG]: Server port set to ${this._port}`)

        const logLevelName = json.server?.logLevel ?? "LOG"
        const logLevel = LogLevel[logLevelName]
        console.log(`[CONFIG]: LogLevel set to ${logLevelName} = ${logLevel}`)
        console.setLevel(logLevel)

        this.serviceReg.set('wms', wms)
        xyz && this.serviceReg.set('xyz', xyz)
        wmts && this.serviceReg.set('wmts', wmts)
        this.loaded = true

        console.log(`[CONFIG]: ${this.path} loaded`)

        return this
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

    const fullpath = resolve(baseDir, DYNAMIC_STYLE_SCHEMA_FILE)
    const styleValidator = new StyleValidator(fullpath, "Dynamic Style Schema")

    for (const [name, entry] of Object.entries(styleEntries)) {
        styles.set(name, await createStyle(name, entry, baseDir, styleValidator))
    }

    return styles
}

async function createStyle(
    name: string,
    entry: StyleJson,
    baseDir: string,
    dynamicStyleValidator: JsonValidator<DynamicStyleJson>
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

function titleFromId(id: string): string {
    return id
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' ') || id
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
