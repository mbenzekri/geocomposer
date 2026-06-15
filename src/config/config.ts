import { dirname, resolve } from 'node:path'
import { Dict, isPlainObject, Singleton } from '../core/tools.js'

import { LogLevel} from "../core/log-level.js"
import { Crs, type CrsJson } from '../core/crs.js'

import { Service, type ServicesJson } from '../service/service-build.js'
import { Source, type SourceJson } from '../source/source-build.js'
import { Layer, type LayerJson } from '../layer/layer.js'
import { Style, type StyleJson } from '../style/style.js'
import { Tileset, type TilesetJson } from '../tileset/tileset.js'

import { JsonValidator } from '../core/json-validator.js'
import { EnvSolver } from './env-solver.js'
import { DefsSolver } from './defs-solver.js'
import configSchema from './config.schema.json' with { type: 'json' }


class ConfigValidator extends JsonValidator<GeoComposerJson> {
    constructor(schema: unknown, name: string, private readonly baseDir: string) {
        super(schema, name)
    }

    protected transform(document: unknown): unknown {
        const envSolved = new EnvSolver().solve(document)
        const defsAndEnvSolved = new DefsSolver().solve(envSolved)
        return resolveConfigPaths(defsAndEnvSolved, this.baseDir)
    }
}

export type ProjectionJson = CrsJson

export type ServerJson = {
    port?: number
    logLevel?: "DEBUG" | "LOG" | "WARN" | "ERROR" | "NONE"
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

function resolveConfigPaths(document: unknown, baseDir: string): unknown {
    if (!isPlainObject(document)) return document

    const resolved: Record<string, unknown> = { ...document }
    if (Object.hasOwn(document, 'services')) {
        resolved.services = resolveServicePaths(document.services, baseDir)
    }
    if (Object.hasOwn(document, 'sources')) {
        resolved.sources = resolveSourcePaths(document.sources, baseDir)
    }
    if (Object.hasOwn(document, 'styles')) {
        resolved.styles = resolveStylePaths(document.styles, baseDir)
    }

    return resolved
}

function resolveServicePaths(services: unknown, baseDir: string): unknown {
    if (!isPlainObject(services)) return services

    const resolved: Record<string, unknown> = { ...services }
    if (Object.hasOwn(services, 'xyz')) {
        resolved.xyz = resolveKnownPathFields(services.xyz, baseDir, ['cache'])
    }
    if (Object.hasOwn(services, 'wmts')) {
        resolved.wmts = resolveKnownPathFields(services.wmts, baseDir, ['cache'])
    }

    return resolved
}

function resolveSourcePaths(sources: unknown, baseDir: string): unknown {
    if (!isPlainObject(sources)) return sources

    const resolved: Record<string, unknown> = {}
    for (const [name, entry] of Object.entries(sources)) {
        resolved[name] = resolveSourceEntryPaths(entry, baseDir)
    }

    return resolved
}

function resolveSourceEntryPaths(entry: unknown, baseDir: string): unknown {
    if (!isPlainObject(entry)) return entry

    switch (entry.type) {
        case 'geojson':
        case 'gml':
        case 'gpkg':
            return resolveKnownPathFields(entry, baseDir, ['path'])

        case 'shp':
            return resolveKnownPathFields(entry, baseDir, ['shpPath', 'dbfPath'])

        case 'oracle':
            return resolveOracleConnectionPaths(entry, baseDir)

        default:
            return entry
    }
}

function resolveOracleConnectionPaths(entry: Record<string, unknown>, baseDir: string): Record<string, unknown> {
    if (!isPlainObject(entry.connection)) return entry

    return {
        ...entry,
        connection: resolveKnownPathFields(entry.connection, baseDir, ['walletLocation', 'configDir'])
    }
}

function resolveStylePaths(styles: unknown, baseDir: string): unknown {
    if (!isPlainObject(styles)) return styles

    const resolved: Record<string, unknown> = {}
    for (const [name, entry] of Object.entries(styles)) {
        resolved[name] = isPlainObject(entry) && entry.type === 'dynamic'
            ? resolveKnownPathFields(entry, baseDir, ['path'])
            : entry
    }

    return resolved
}

function resolveKnownPathFields(entry: unknown, baseDir: string, fields: string[]): unknown {
    if (!isPlainObject(entry)) return entry

    let resolved: Record<string, unknown> | undefined
    for (const field of fields) {
        const value = entry[field]
        if (typeof value !== 'string') continue

        resolved ??= { ...entry }
        resolved[field] = resolve(baseDir, value)
    }

    return resolved ?? entry
}

export class Config extends Singleton {

    readonly path: string
    readonly dir: string
    get port(): number { return this._port ?? 3000 }
    private _port?: number
    private loaded = false

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
        // Managing config singleton
        const config = Config.instance()
        if (config && config !== this) {
            throw new Error(`Config singleton already loaded from ${config.path}`)
        }

        if (this.loaded) return this
        console.log(`[CONFIG]: ${this.path} loading`)

        // loading json and validating syntax of the config file
        const configValidator = new ConfigValidator(configSchema, "Configuration Schema", this.dir)
        const json = configValidator.validate(this.path)

        // set LogLevel and PORT from Args/Config
        const logLevelName = json.server?.logLevel ?? "LOG"
        const logLevel = LogLevel[logLevelName]
        console.log(`[CONFIG]: LogLevel set to ${logLevelName}`)
        console.setLevel(logLevel)
        this._port ??= json.server?.port ?? 3000
        console.log(`[CONFIG]: Server port set to ${this._port}`)

        // creating all app objects in their registries
        Crs.build(json.projections ?? {})
        Source.build(json.sources)
        await Style.build(json.styles ?? {})
        Layer.build(json.layers)
        Tileset.build(json.tilesets ?? {})
        Service.build(json.services)

        this.loaded = true
        console.log(`[CONFIG]: ${this.path} loaded`)

        return this
    }
}
