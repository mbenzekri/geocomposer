import type { PathLike } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { DescInfo, Feature, FileRef, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { FileSource, hasSourceConfigType, type ClusteredWorkerSourceConfig, type FeatureTransform } from './source.js'
import type { SourceIndexConfig, StreamOptions } from './source.js'
import { AbortSignalGuard, FileByteReader } from './source-utils.js'
import { GeoJsonParser, parseGeoJsonFeature } from './geojson-stream.js'

export type GeoJsonSourceJson = DescInfo & {
  type: 'geojson'
  path: string
  gzip?: boolean
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
    private readonly encoding: BufferEncoding = 'utf8',
    private readonly highWaterMark?: number,
    transformFeature?: FeatureTransform,
    info: DescInfo & { gzip?: boolean, indexes?: SourceIndexConfig } = {}
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

  protected override clusteredWorkerConfig(): ClusteredWorkerSourceConfig {
    return {
      type: 'geojson',
      encoding: this.encoding,
      ...(this.highWaterMark === undefined ? {} : { highWaterMark: this.highWaterMark })
    }
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

class GeoJsonFileReader {
  constructor(
    private readonly sourceId: string,
    private readonly options: {
      encoding: BufferEncoding
      highWaterMark?: number
    }
  ) {}

  get highWaterMark(): number | undefined {
    return this.options.highWaterMark
  }

  async *stream(options: StreamOptions, file: AsyncIterable<Buffer | string>): AsyncGenerator<Feature> {
    const { layer, signal } = options
    const parser = new GeoJsonParser(this.options.encoding, layer)

    try {
      for await (const chunk of file) {
        AbortSignalGuard.throwIfAborted(signal, 'GeoJSON stream aborted')
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), this.options.encoding))

        for (;;) {
          const parsed = parser.read()
          if (!parsed) break
          if (!parsed.feature) throw new Error('Invalid GeoJSON parser state: missing parsed feature')

          yield this.withSourceRef(parsed.feature, {
            storage: 'file',
            sourceId: this.sourceId,
            offset: parsed.offset,
            byteLength: parsed.byteLength
          }, layer)

          AbortSignalGuard.throwIfAborted(signal, 'GeoJSON stream aborted')
        }

        if (parser.done) return
      }

      parser.finish()
    } finally {
      ;(file as { destroy?: () => void }).destroy?.()
    }
  }

  async read(sourceRef: SourceRef, options: StreamOptions, handle: FileHandle): Promise<Feature | null> {
    const ref = this.toFileRef(sourceRef)

    const buffer = Buffer.alloc(ref.byteLength)
    const bytesRead = await FileByteReader.readFully(handle, buffer, ref.offset)
    if (bytesRead < ref.byteLength) {
      throw new Error('Invalid GeoJSON sourceRef: byte range exceeds file length')
    }

    return this.withSourceRef(
      parseGeoJsonFeature(JSON.parse(buffer.toString(this.options.encoding)), options.layer),
      {
        storage: 'file',
        sourceId: this.sourceId,
        offset: ref.offset,
        byteLength: ref.byteLength,
        recordIndex: ref.recordIndex
      },
      options.layer
    )
  }

  private withSourceRef(feature: Feature, sourceRef: SourceRef, layer: Layer): Feature {
    return {
      ...feature,
      layer,
      sourceRef
    }
  }

  private toFileRef(sourceRef: SourceRef): FileRef & Pick<SourceRef, 'recordIndex' | 'related'> {
    if (sourceRef.sourceId !== this.sourceId) {
      throw new Error(`GeoJSON sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (typeof (sourceRef as Partial<FileRef>).offset !== 'number' || typeof (sourceRef as Partial<FileRef>).byteLength !== 'number') {
      throw new Error('GeoJSON sourceRef must include offset and byteLength')
    }

    return sourceRef as FileRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }
}
