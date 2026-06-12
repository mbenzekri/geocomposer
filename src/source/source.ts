import { GeoJsonSource } from './geojson-source.js'
import { GmlSource } from './gml-source.js'
import { GpkgSource } from './gpkg-source.js'
import { MemSource } from './mem-source.js'
import { PostgisSource } from './postgis-source.js'
import { ShpSource } from './shp-source.js'
import {
  Source,
  type SourceConfigCrsResolver,
  type SourceResolver
} from './source-base.js'

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
  SourceConfigCrsResolver,
  SourceFile,
  SourceFileRole,
  SourceResolver,
  SourceStorage,
  StreamOptions
} from './source-base.js'

Source.createAll = function createAll(
  sourceEntries: Record<string, unknown>,
  baseDir: string,
  crs: SourceConfigCrsResolver
): Map<string, Source> {
  const sourceEntriesByName = new Map(Object.entries(sourceEntries))
  const sources = new Map<string, Source>()
  const creating = new Set<string>()

  const resolveSource: SourceResolver = (name: string): Source => {
    const existing = sources.get(name)
    if (existing) return existing

    const entry = sourceEntriesByName.get(name)
    if (!entry) {
      throw new Error(`Unknown source "${name}"`)
    }

    if (creating.has(name)) {
      throw new Error(`Circular source reference involving "${name}"`)
    }

    creating.add(name)
    try {
      const source = Source.create(name, entry, baseDir, crs, resolveSource)
      sources.set(name, source)
      return source
    } finally {
      creating.delete(name)
    }
  }

  for (const name of sourceEntriesByName.keys()) {
    resolveSource(name)
  }

  return sources
}

Source.create = function create(
  name: string,
  entry: unknown,
  baseDir: string,
  crs: SourceConfigCrsResolver,
  resolveSource: SourceResolver
): Source {
  if (GeoJsonSource.acceptsConfig(entry)) return GeoJsonSource.fromConfig(name, entry, baseDir, crs)
  if (GmlSource.acceptsConfig(entry)) return GmlSource.fromConfig(name, entry, baseDir, crs)
  if (ShpSource.acceptsConfig(entry)) return ShpSource.fromConfig(name, entry, baseDir, crs)
  if (GpkgSource.acceptsConfig(entry)) return GpkgSource.fromConfig(name, entry, baseDir, crs)
  if (PostgisSource.acceptsConfig(entry)) return PostgisSource.fromConfig(name, entry, crs)
  if (MemSource.acceptsConfig(entry)) return MemSource.fromConfig(name, entry, resolveSource)

  const type = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    ? (entry as { type?: unknown }).type
    : undefined
  throw new Error(`Unknown source type "${String(type)}" for source "${name}"`)
}
