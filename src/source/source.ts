import type { PathLike } from 'node:fs'
import type { BBox, CrsCode } from '../core/types.js'
import type { Feature } from '../geometry/feature.js'
import { BboxFilter } from '../transform/bbox-filter.js'

export type SourceStorage = 'memory' | 'file' | 'database'

export type SourceFileRole = 'data' | 'geometry' | 'attributes' | 'index' | 'metadata'

export type SourceFile = {
  role: SourceFileRole | string
  path: PathLike
}

export type StreamOptions = {
  signal?: AbortSignal
}

export type QueryOptions = StreamOptions & {
  bbox?: BBox
  crs?: CrsCode
  properties?: string[]
}

export abstract class Source {
  abstract readonly id: string
  abstract readonly type: string
  abstract readonly storage: SourceStorage
  abstract readonly crs: CrsCode

  abstract open(): Promise<void>
  abstract close(): Promise<void>
  abstract getExtent(): Promise<BBox | null>

  abstract stream(options?: StreamOptions): ReadableStream<Feature>

  query(options: QueryOptions): ReadableStream<Feature> {
    const input = this.stream(options)

    if (!options.bbox) {
      return input
    }

    return input.pipeThrough(new BboxFilter(options.bbox))
  }
}

export abstract class FileSource extends Source {
  readonly storage = 'file' as const

  abstract getFiles(): readonly SourceFile[]
}

export abstract class DbSource extends Source {
  readonly storage = 'database' as const
}
