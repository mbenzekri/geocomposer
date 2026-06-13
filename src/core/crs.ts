import proj4 from 'proj4'
import type { CrsCode } from './geometry.js'
import { Dict, Registry } from './tools.js'

export type CrsJson = {
    name?: string
    title: string
}

export type Proj4Projection = InstanceType<typeof proj4.Proj>

export type CrsOptions = {
    code: CrsCode
    name?: string
    title?: string
    proj?: Proj4Projection
}

export class Crs {
    static readonly registry = new Registry<Crs>('CRS')

    readonly code: CrsCode
    readonly name: string
    readonly title: string
    readonly proj: Proj4Projection

    constructor(options: CrsOptions) {
        if (!options.code) {
            throw new Error('CRS code is required')
        }

        this.code = options.code
        this.name = options.name ?? options.code
        this.title = options.title ?? this.name
        this.proj = options.proj ?? new proj4.Proj(this.code)
    }

    static createAll(entries: Dict<CrsJson>): Registry<Crs> {
        for (const [code, entry] of Object.entries(entries)) {
            const crs = Crs.fromConfig(code, entry)
            Crs.registry.set(crs.code, crs)
        }

        return Crs.registry
    }

    static fromConfig(code: CrsCode, entry: CrsJson): Crs {
        return new Crs({
            code,
            name: entry.name,
            title: entry.title
        })
    }

    toString(): string {
        return this.code
    }

}
