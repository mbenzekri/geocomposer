import type { Props, Registry } from '../core/tools.js'
import { CsvSource } from './csv-source.js'
import { GeoJsonSource } from './geojson-source.js'
import { GmlSource } from './gml-source.js'
import { GpkgSource } from './gpkg-source.js'
import { MssqlSource } from './mssql-source.js'
import { OracleSource } from './oracle-source.js'
import { PostgisSource } from './postgis-source.js'
import { ShpSource } from './shp-source.js'
import { Source } from './source.js'

Source.build = function createAll(
    sourceEntries: Record<string, unknown>
): Registry<Source> {
    for (const [name,entry] of Object.entries(sourceEntries)) {
        const existing = Source.registry.has(name)
        const type = (entry as Props)['type']
        if (existing) continue
        console.log(`[SOURCE]: creating source ${type}/${name}`)
        const source = Source.create(name, entry)
        Source.registry.set(name, source)
    }
    return Source.registry
}

Source.create = function create(
    name: string,
    entry: unknown
): Source {
    if (CsvSource.acceptsConfig(entry)) return CsvSource.fromConfig(name, entry)
    if (GeoJsonSource.acceptsConfig(entry)) return GeoJsonSource.fromConfig(name, entry)
    if (GmlSource.acceptsConfig(entry)) return GmlSource.fromConfig(name, entry)
    if (ShpSource.acceptsConfig(entry)) return ShpSource.fromConfig(name, entry)
    if (GpkgSource.acceptsConfig(entry)) return GpkgSource.fromConfig(name, entry)
    if (PostgisSource.acceptsConfig(entry)) return PostgisSource.fromConfig(name, entry)
    if (MssqlSource.acceptsConfig(entry)) return MssqlSource.fromConfig(name, entry)
    if (OracleSource.acceptsConfig(entry)) return OracleSource.fromConfig(name, entry)

    const type = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as { type?: unknown }).type
        : undefined
    throw new Error(`Unknown source type "${String(type)}" for source "${name}"`)
}
