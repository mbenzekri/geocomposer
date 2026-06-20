import proj4 from 'proj4'
import type { CrsCode } from './geometry.js'
import { Dict, Registry } from './tools.js'

export type CrsJson = {
    name?: string
    title: string
    proj4?: string
}

export type Proj4Projection = InstanceType<typeof proj4.Proj>

export class Crs {
    static readonly registry = new Registry<Crs>('CRS')

    readonly code: CrsCode
    readonly name: string
    readonly title: string
    readonly proj: Proj4Projection

    constructor(
        code: CrsCode,
        name?: string,
        title?: string,
        proj?: Proj4Projection
    ) {
        if (!code) {
            throw new Error('CRS code is required')
        }

        this.code = code
        this.name = name ?? code
        this.title = title ?? this.name
        this.proj = proj ?? new proj4.Proj(this.code)
    }

    static build(entries: Dict<CrsJson>): Registry<Crs> {
        for (const [code, entry] of Object.entries(entries)) {
            const crs = Crs.fromConfig(code, entry)
            Crs.registry.set(crs.code, crs)
        }

        return Crs.registry
    }

    static fromConfig(code: CrsCode, entry: CrsJson): Crs {
        return new Crs(
            code,
            entry.name,
            entry.title,
            entry.proj4 ? new proj4.Proj(entry.proj4) : undefined
        )
    }

    toString(): string {
        return this.code
    }
}