import { CrsCode } from '../core/geometry.js'
import { Registry } from '../core/tools.js'
import { GeoJsonSource, type GeoJsonSourceJson } from './geojson-source.js'
import { GmlSource, type GmlSourceJson } from './gml-source.js'
import { GpkgSource, type GpkgSourceJson } from './gpkg-source.js'
import { MemSource, type MemSourceJson } from './mem-source.js'
import { PostgisSource, type PostgisSourceJson } from './postgis-source.js'
import { ShpSource, type ShpSourceJson } from './shp-source.js'
import { Source } from './source-base.js'

export {
    DbSource,
    FeatureSource,
    FileSource,
    Source,
    hasSourceConfigType,
    toStream
} from './source-base.js'
export type {
    FeatureTransform,
    QueryOptions,
    SourceFile,
    SourceFileRole,
    SourceStorage,
    StreamOptions
} from './source-base.js'

export type {
    GeoJsonSourceJson,
    GmlSourceJson,
    GpkgSourceJson,
    MemSourceJson,
    PostgisSourceJson,
    ShpSourceJson
}

export type SourceJson =
    | GeoJsonSourceJson
    | GmlSourceJson
    | ShpSourceJson
    | GpkgSourceJson
    | PostgisSourceJson
    | MemSourceJson

Source.createAll = function createAll(
    sourceEntries: Record<string, unknown>,
    baseDir: string,
    crs: Registry<CrsCode>
): Registry<Source> {
    const sourceReg = new Registry<Source>('SOURCE')
    for (const [name,entry] of Object.entries(sourceEntries)) {
        const existing = sourceReg.has(name)
        if (existing) continue
        const source = Source.create(name, entry, baseDir, crs, sourceReg)
        sourceReg.set(name, source)
    }
    return sourceReg
}

Source.create = function create(
    name: string,
    entry: unknown,
    baseDir: string,
    crs: Registry<CrsCode>,
    sourceReg: Registry<Source>
): Source {
    if (GeoJsonSource.acceptsConfig(entry)) return GeoJsonSource.fromConfig(name, entry, baseDir, crs)
    if (GmlSource.acceptsConfig(entry)) return GmlSource.fromConfig(name, entry, baseDir, crs)
    if (ShpSource.acceptsConfig(entry)) return ShpSource.fromConfig(name, entry, baseDir, crs)
    if (GpkgSource.acceptsConfig(entry)) return GpkgSource.fromConfig(name, entry, baseDir, crs)
    if (PostgisSource.acceptsConfig(entry)) return PostgisSource.fromConfig(name, entry, crs)
    if (MemSource.acceptsConfig(entry)) return MemSource.fromConfig(name, entry, sourceReg)

    const type = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as { type?: unknown }).type
        : undefined
    throw new Error(`Unknown source type "${String(type)}" for source "${name}"`)
}
