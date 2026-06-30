import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Dict, Singleton } from '../core/tools.js'

import { LogLevel} from "../core/log-level.js"
import { Crs, type CrsJson } from '../core/crs.js'

import '../service/service-build.js'
import { Service, type ServicesJson } from '../service/service.js'
import '../source/source-build.js'
import { Source } from '../source/source.js'
import type { SourceJson } from '../source/source-json.js'
import { Layer, type LayerJson } from '../layer/layer.js'
import { Style, type StyleJson } from '../style/style.js'
import { Tileset, type TilesetJson } from '../tileset/tileset.js'
import { TileMatrixSet, type TileMatrixSetJson } from '../tileset/tile-matrix-set.js'

import { JsonValidator } from '../core/json-validator.js'
import { EnvSolver } from './env-solver.js'
import { DefsSolver } from './defs-solver.js'
import configSchema from './config.schema.json' with { type: 'json' }
import { PathsSolver } from './path-solver.js'

export let jpegQuality = 85
export let jpegBackground = '#ffffff'

class ConfigValidator extends JsonValidator<GeoComposerJson> {
    constructor(schema: unknown, name: string) {
        super(schema, name)
    }

    protected transform(document: unknown): unknown {
        let solved = new EnvSolver().solve(document)
        solved = new DefsSolver().solve(solved)
        return solved
    }
}


export type ServerJson = {
    port?: number
    logLevel?: "DEBUG" | "LOG" | "WARN" | "ERROR" | "NONE"
    jpegQuality?: number
    jpegBackground?: string
}

export type GeoComposerJson = {
    $schema?: string
    $defs?: Dict<unknown>
    server?: ServerJson
    services: ServicesJson
    crs?: Dict<CrsJson>
    sources: Dict<SourceJson>
    styles?: Dict<StyleJson>
    layers: Dict<LayerJson>
    tileMatrixSets?: Dict<TileMatrixSetJson>
    tilesets?: Dict<TilesetJson>
}

export class Config extends Singleton {

    readonly path: string
    readonly dir: string
    get port(): number { return this._port ?? 3000 }
    get site(): string | undefined { return this._site }
    private _port?: number
    private _site?: string
    private loaded = false

    constructor(configPath: string, port?: number) {
        super(Config)
        this.path = resolve(configPath)
        this.dir = dirname(this.path)
        this._port = port
        console.log(`[CONFIG]: Base dir is ${this.dir}`)
        console.log(`[CONFIG]: file is ${this.path}`)

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
        console.log(`[CONFIG]: loading ${this.path}`)

        // loading json and validating syntax of the config file
        const configValidator = new ConfigValidator(configSchema, "Configuration Schema")
        const json = new PathsSolver(this.dir).solve(configValidator.validate(this.path))

        // set LogLevel and PORT from Args/Config
        const logLevelName = json.server?.logLevel ?? "LOG"
        const logLevel = LogLevel[logLevelName]
        console.log(`[CONFIG]: LogLevel set to ${logLevelName}`)
        console.setLevel(logLevel)
        this._port ??= json.server?.port ?? 3000
        console.log(`[CONFIG]: Server port set to ${this._port}`)
        jpegQuality = json.server?.jpegQuality ?? 85
        jpegBackground = json.server?.jpegBackground ?? '#ffffff'
        this._site = this.findStaticSite()
        if (this._site) {
            console.log(`[CONFIG]: Static site set to ${this._site}`)
        }

        // creating all app objects in their registries
        Crs.build(json.crs ?? {})
        Source.build(json.sources)
        await Style.build(json.styles ?? {})
        Layer.build(json.layers)
        TileMatrixSet.build(json.tileMatrixSets ?? {})
        Tileset.build(json.tilesets ?? {})
        Service.build(json.services)

        this.loaded = true
        console.log(`[CONFIG]: ${this.path} loaded`)

        return this
    }

    private findStaticSite(): string | undefined {
        const sitePath = join(this.dir, 'site')
        return existsSync(sitePath) && statSync(sitePath).isDirectory()
            ? sitePath
            : undefined
    }
}
