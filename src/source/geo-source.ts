import type { PathLike } from 'node:fs'
import type { BBox, CrsCode } from '../core/types.js'
import type { GeoFeature } from '../geometry/geo-feature.js'
import { BBoxFilterTransform } from '../transform/bbox-filter-transform.js'

export type GeoSourceStorage = 'memory' | 'file' | 'database'

export type GeoSourceFileRole = 'data' | 'geometry' | 'attributes' | 'index' | 'metadata'

export type GeoSourceFile = {
  role: GeoSourceFileRole | string
  path: PathLike
}

export type GeoStreamOptions = {
  signal?: AbortSignal
}

export type GeoQueryOptions = GeoStreamOptions & {
  bbox?: BBox
  crs?: CrsCode
  properties?: string[]
}

export abstract class GeoSource {
  abstract readonly id: string
  abstract readonly type: string
  abstract readonly storage: GeoSourceStorage
  abstract readonly crs: CrsCode

  abstract open(): Promise<void>
  abstract close(): Promise<void>
  abstract getExtent(): Promise<BBox | null>

  abstract stream(options?: GeoStreamOptions): ReadableStream<GeoFeature>

  query(options: GeoQueryOptions): ReadableStream<GeoFeature> {
    const input = this.stream(options)

    if (!options.bbox) {
      return input
    }

    return input.pipeThrough(new BBoxFilterTransform(options.bbox))
  }
}

export abstract class FileGeoSource extends GeoSource {
  readonly storage = 'file' as const

  abstract getFiles(): readonly GeoSourceFile[]
}

export abstract class DatabaseGeoSource extends GeoSource {
  readonly storage = 'database' as const
}
