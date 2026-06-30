import type { PathLike } from 'node:fs'
import type { DescInfo, Feature, SourceRef } from '../core/feature.js'
import { FileSource, hasSourceConfigType, type FeatureTransform } from './source.js'
import type { SourceIndexConfig, StreamOptions } from './source.js'
import { AbortSignalGuard } from './source-utils.js'
import { GeoJsonFileReader } from './geojson-file.js'

export type GeoJsonSourceJson = DescInfo & {
  type: 'geojson'
  path: string
  encoding?: BufferEncoding
  highWaterMark?: number
  indexes?: SourceIndexConfig
}

export class GeoJsonSource extends FileSource {
  readonly type = 'geojson'

  private readonly reader: GeoJsonFileReader

  static acceptsConfig(entry: unknown): entry is GeoJsonSourceJson {
    return hasSourceConfigType(entry, 'geojson')
  }

  static fromConfig(
    id: string,
    entry: GeoJsonSourceJson
  ): GeoJsonSource {
    return new GeoJsonSource(id, entry.path, entry.encoding, entry.highWaterMark, undefined, entry)
  }

  constructor(
    id: string,
    private readonly filePath: PathLike,
    encoding: BufferEncoding = 'utf8',
    highWaterMark?: number,
    transformFeature?: FeatureTransform,
    info: DescInfo & { indexes?: SourceIndexConfig } = {}
  ) {
    super(id, info, transformFeature)

    this.reader = new GeoJsonFileReader(this.id, {
      encoding,
      highWaterMark
    })
  }

  getFiles() {
    return [{ role: 'data', path: this.filePath }]
  }

  protected override streamFeatures(options: StreamOptions): AsyncIterable<Feature> {
    return this.reader.stream(options, this.fileStream('data', {
      highWaterMark: this.reader.highWaterMark,
      signal: options.signal
    }))
  }

  protected override readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    return this.reader.read(sourceRef, options, this.fileHandle('data'))
  }

  protected override abortReason(signal: AbortSignal): unknown {
    return AbortSignalGuard.reason(signal, 'GeoJSON stream aborted')
  }
}
