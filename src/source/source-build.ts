import type { Props, Registry } from '../core/tools.js'
import { GeoJsonSource, type GeoJsonSourceJson } from './geojson-source.js'
import { GmlSource, type GmlSourceJson } from './gml-source.js'
import { GpkgSource, type GpkgSourceJson } from './gpkg-source.js'
import { MssqlSource, type MssqlSourceJson } from './mssql-source.js'
import { OracleSource, type OracleSourceJson } from './oracle-source.js'
import { PostgisSource, type PostgisSourceJson } from './postgis-source.js'
import { ShpSource, type ShpSourceJson } from './shp-source.js'
import { Source } from './source.js'

export {
    DbSource,
    FeatureSource,
    FileSource,
    Source,
    hasSourceConfigType,
    toStream
} from './source.js'
export {
    DbDataset
} from './db-dataset.js'
export {
    FILE_INDEX_MAGIC,
    FILE_INDEX_VERSION,
    IndexRecord,
    IndexRtree,
    LayerFileIndexer,
    RECORD_INDEX_ENTRY_SIZE,
    RTREE_INDEX_ENTRY_SIZE,
    RTREE_INDEX_NAME,
    RECORD_INDEX_NAME
} from './file-index.js'
export type {
    DbDatasetJson,
    DbDatasetOptions
} from './db-dataset.js'
export type {
    FeatureTransform,
    QueryOptions,
    SourceFile,
    SourceFileRole,
    SourceStorage,
    StreamOptions
} from './source.js'

export type {
    GeoJsonSourceJson,
    GmlSourceJson,
    GpkgSourceJson,
    MssqlSourceJson,
    OracleSourceJson,
    PostgisSourceJson,
    ShpSourceJson
}

export type SourceJson =
    | GeoJsonSourceJson
    | GmlSourceJson
    | ShpSourceJson
    | GpkgSourceJson
    | PostgisSourceJson
    | MssqlSourceJson
    | OracleSourceJson

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
