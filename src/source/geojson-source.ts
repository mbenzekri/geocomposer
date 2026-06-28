import { createReadStream, type PathLike } from 'node:fs'
import { open } from 'node:fs/promises'
import type { DescInfo, Feature, FileRef, SourceRef } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'
import { FileSource, hasSourceConfigType, type FeatureTransform } from './source.js'
import type { SourceIndexConfig, StreamOptions } from './source.js'
import { AbortSignalGuard, FileByteReader } from './source-utils.js'

export type GeoJsonSourceJson = DescInfo & {
  type: 'geojson'
  path: string
  encoding?: BufferEncoding
  highWaterMark?: number
  indexes?: SourceIndexConfig
}

export class GeoJsonSource extends FileSource {
  readonly type = 'geojson'

  private readonly reader: GeoJsonReader

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

    this.reader = new GeoJsonReader(this.id, this.filePath, {
      encoding,
      highWaterMark
    })
  }

  getFiles() {
    return [{ role: 'data', path: this.filePath }]
  }

  protected override streamFeatures(options: StreamOptions): AsyncIterable<Feature> {
    return this.reader.stream(options)
  }

  protected override readFeature(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    return this.reader.read(sourceRef, options)
  }

  protected override abortReason(signal: AbortSignal): unknown {
    return AbortSignalGuard.reason(signal, 'GeoJSON stream aborted')
  }
}

class GeoJsonReader {
  constructor(
    private readonly sourceId: string,
    private readonly filePath: PathLike,
    private readonly options: {
      encoding: BufferEncoding
      highWaterMark?: number
    }
  ) {}

  async *stream(options: StreamOptions): AsyncGenerator<Feature> {
    const { layer, signal } = options
    const parser = new FeatureCollectionParser(this.options.encoding, layer)
    const file = createReadStream(this.filePath, {
      highWaterMark: this.options.highWaterMark,
      signal
    })

    try {
      for await (const chunk of file) {
        AbortSignalGuard.throwIfAborted(signal, 'GeoJSON stream aborted')
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), this.options.encoding))

        for (;;) {
          const parsed = parser.read()
          if (!parsed) break

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
      file.destroy()
    }
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const ref = this.toFileRef(sourceRef)
    const handle = await open(this.filePath, 'r')

    try {
      const buffer = Buffer.alloc(ref.byteLength)
      const bytesRead = await FileByteReader.readFully(handle, buffer, ref.offset)
      if (bytesRead < ref.byteLength) {
        throw new Error('Invalid GeoJSON sourceRef: byte range exceeds file length')
      }

      return this.withSourceRef(
        toFeature(JSON.parse(buffer.toString(this.options.encoding)), options.layer),
        {
          storage: 'file',
          sourceId: this.sourceId,
          offset: ref.offset,
          byteLength: ref.byteLength,
          recordIndex: ref.recordIndex
        },
        options.layer
      )
    } finally {
      await handle.close()
    }
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

type ParsedString = {
  value: string
  end: number
}

type ParsedFeature = {
  feature: Feature
  offset: number
  byteLength: number
}

class FeatureCollectionParser {
  private buffer = ''
  private bufferOffset = 0
  private position = 0
  private searchDepth = 0
  private state: 'searching-features' | 'reading-features' | 'done' = 'searching-features'

  constructor(
    private readonly encoding: BufferEncoding,
    private readonly layer: Layer
  ) {}

  get done(): boolean {
    return this.state === 'done'
  }

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1')
  }

  read(): ParsedFeature | null {
    if (this.state === 'done') return null

    if (this.state === 'searching-features' && !this.findFeaturesArray()) {
      return null
    }

    return this.readFeatureFromArray()
  }

  finish(): void {
    if (this.state === 'searching-features') {
      throw new Error('Invalid GeoJSON: expected a top-level FeatureCollection.features array')
    }

    if (this.state === 'done') return

    this.skipWhitespace()

    if (this.buffer[this.position] !== ']') {
      throw new Error('Invalid GeoJSON: unfinished FeatureCollection.features array')
    }

    this.state = 'done'
  }

  private findFeaturesArray(): boolean {
    let index = this.position
    let depth = this.searchDepth

    while (index < this.buffer.length) {
      const char = this.buffer[index]

      if (char === '"') {
        const keyStart = index
        const parsed = parseJsonStringAt(this.buffer, index)
        if (!parsed) break

        index = parsed.end

        if (depth === 1) {
          const colonIndex = skipWhitespaceAt(this.buffer, index)
          if (colonIndex >= this.buffer.length) {
            index = keyStart
            break
          }

          if (this.buffer[colonIndex] === ':') {
            const valueIndex = skipWhitespaceAt(this.buffer, colonIndex + 1)
            if (valueIndex >= this.buffer.length) {
              index = keyStart
              break
            }

            if (parsed.value === 'features') {
              if (this.buffer[valueIndex] !== '[') {
                throw new Error('Invalid GeoJSON: FeatureCollection.features must be an array')
              }

              this.position = valueIndex + 1
              this.searchDepth = depth + 1
              this.state = 'reading-features'
              this.trimBuffer()
              return true
            }
          }
        }

        continue
      }

      if (char === '{' || char === '[') {
        depth += 1
        index += 1
        continue
      }

      if (char === '}' || char === ']') {
        depth -= 1
        index += 1
        continue
      }

      index += 1
    }

    this.position = index
    this.searchDepth = depth
    this.trimBuffer()
    return false
  }

  private readFeatureFromArray(): ParsedFeature | null {
    this.skipFeatureSeparators()

    const char = this.buffer[this.position]
    if (!char) {
      this.trimBuffer()
      return null
    }

    if (char === ']') {
      this.position += 1
      this.state = 'done'
      this.trimBuffer()
      return null
    }

    if (char !== '{') {
      throw new Error('Invalid GeoJSON: FeatureCollection.features must contain Feature objects')
    }

    const start = this.position
    const end = findJsonObjectEnd(this.buffer, start)
    if (end === null) return null

    const featureJson = Buffer.from(this.buffer.slice(start, end), 'latin1').toString(this.encoding)
    const parsedFeature = toFeature(JSON.parse(featureJson), this.layer)
    const offset = this.bufferOffset + start
    // The slice starts at { and ends after }, so it can be parsed directly later.
    const byteLength = end - start

    this.position = end
    this.trimBuffer()

    return {
      feature: parsedFeature,
      offset,
      byteLength
    }
  }

  private skipFeatureSeparators(): void {
    while (this.position < this.buffer.length) {
      const char = this.buffer[this.position]
      if (char === ',' || isWhitespace(char)) {
        this.position += 1
        continue
      }

      break
    }
  }

  private skipWhitespace(): void {
    this.position = skipWhitespaceAt(this.buffer, this.position)
  }

  private trimBuffer(): void {
    if (this.position < 65536) return

    this.buffer = this.buffer.slice(this.position)
    this.bufferOffset += this.position
    this.position = 0
  }
}

function parseJsonStringAt(input: string, start: number): ParsedString | null {
  for (let index = start + 1, escaped = false; index < input.length; index += 1) {
    const char = input[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      const raw = input.slice(start, index + 1)
      return {
        value: JSON.parse(raw) as string,
        end: index + 1
      }
    }
  }

  return null
}

function findJsonObjectEnd(input: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < input.length; index += 1) {
    const char = input[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{' || char === '[') {
      depth += 1
      continue
    }

    if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  return null
}

function skipWhitespaceAt(input: string, start: number): number {
  let index = start

  while (index < input.length && isWhitespace(input[index])) {
    index += 1
  }

  return index
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

function toFeature(value: unknown, layer: Layer): Feature {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'Feature') {
    throw new Error('Invalid GeoJSON: expected a Feature object')
  }

  const feature = value as Partial<Feature>
  return {
    ...feature,
    layer,
    type: 'Feature',
    properties: feature.properties ?? null,
    geometry: feature.geometry ?? null
  }
}
