import proj4 from 'proj4'
import type { CrsCode } from './geometry.js'
import { METERS_PER_DEGREE } from './geometry.js'
import { Dict, Registry } from './tools.js'

export type CrsJson = {
    name?: string
    title: string
    proj4?: string
    precision?: number
}

export type Proj4Projection = InstanceType<typeof proj4.Proj>

const TARGET_COORDINATE_PRECISION_METERS = 0.01

export class Crs {
    static readonly registry = new Registry<Crs>('CRS')

    readonly code: CrsCode
    readonly name: string
    readonly title: string
    readonly proj: Proj4Projection
    readonly precision?: number

    constructor(
        code: CrsCode,
        name?: string,
        title?: string,
        proj?: Proj4Projection,
        precision?: number
    ) {
        if (!code) {
            throw new Error('CRS code is required')
        }

        if (precision !== undefined && (!Number.isInteger(precision) || precision < 0)) {
            throw new Error(`CRS "${code}" precision must be a non-negative integer`)
        }

        this.code = code
        this.name = name ?? code
        this.title = title ?? this.name
        this.proj = proj ?? new proj4.Proj(this.code)
        this.precision = precision
    }

    static build(entries: Dict<CrsJson>): Registry<Crs> {
        for (const [code, entry] of Object.entries(entries)) {
            const crs = Crs.fromConfig(code, entry)
            Crs.registry.set(crs.code, crs)
        }

        return Crs.registry
    }

    static fromConfig(code: CrsCode, entry: CrsJson): Crs {
        if (entry.proj4) {
            proj4.defs(code, entry.proj4)
        }

        return new Crs(
            code,
            entry.name,
            entry.title,
            entry.proj4 ? new proj4.Proj(code) : undefined,
            entry.precision
        )
    }

    get coordinatePrecision(): number | undefined {
        return this.precision ?? Crs.autoCoordinatePrecision(this.proj)
    }

    toString(): string {
        return this.code
    }

    private static autoCoordinatePrecision(proj: Proj4Projection): number | undefined {
        const units = String((proj as Proj4Projection & { units?: string }).units ?? '').toLowerCase()
        if (units === 'degrees' || units === 'degree') {
            return Crs.precisionForUnitMeters(METERS_PER_DEGREE)
        }

        const toMeter = (proj as Proj4Projection & { to_meter?: number }).to_meter
        const unitMeters = toMeter !== undefined && Number.isFinite(toMeter) && toMeter > 0
            ? toMeter
            : Crs.unitMeters(units)

        return unitMeters === undefined
            ? undefined
            : Crs.precisionForUnitMeters(unitMeters)
    }

    private static unitMeters(units: string): number | undefined {
        if (units === 'm' || units === 'meter' || units === 'metre' || units === 'meters' || units === 'metres') return 1
        if (units === 'km' || units === 'kilometer' || units === 'kilometre' || units === 'kilometers' || units === 'kilometres') return 1000
        if (units === 'ft' || units === 'foot' || units === 'feet') return 0.3048
        if (units === 'us-ft' || units === 'us_foot') return 1200 / 3937
        return undefined
    }

    private static precisionForUnitMeters(unitMeters: number): number {
        return Math.max(0, Math.ceil(-Math.log10(TARGET_COORDINATE_PRECISION_METERS / unitMeters)))
    }
}
