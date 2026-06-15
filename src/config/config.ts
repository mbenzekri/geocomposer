import { dirname, resolve } from 'node:path'
import { Dict, Singleton } from '../core/tools.js'

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
import { PathsSolver } from './path-solver.js'


class ConfigValidator extends JsonValidator<GeoComposerJson> {
    constructor(schema: unknown, name: string, private readonly baseDir: string) {
        super(schema, name)
    }

    protected transform(document: unknown): unknown {
        let solved = new EnvSolver().solve(document)
        solved = new DefsSolver().solve(solved)
        solved = new PathsSolver(this.baseDir).solve(solved)
        return solved
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
