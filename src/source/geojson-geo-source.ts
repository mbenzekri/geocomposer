import { constants, createReadStream, type PathLike } from 'node:fs'
import { access } from 'node:fs/promises'
import type { BBox, CrsCode } from '../core/types.js'
import { computeGeometryBBox, expandBBox } from '../geometry/bbox.js'
import type { GeoFeature, GeoFeatureSourceRef } from '../geometry/geo-feature.js'
import { GeoSource, type GeoStreamOptions } from './geo-source.js'

export type GeoJsonGeoSourceOptions = {
  crs?: CrsCode
  encoding?: BufferEncoding
  highWaterMark?: number
  transformFeature?: (feature: GeoFeature, index: number) => GeoFeature | Promise<GeoFeature>
}

export class GeoJsonGeoSource extends GeoSource {
  readonly type = 'geojson'
  readonly crs: CrsCode

  private readonly encoding: BufferEncoding
  private readonly highWaterMark?: number
  private readonly transformFeature?: GeoJsonGeoSourceOptions['transformFeature']

  constructor(
    readonly id: string,
    private readonly filePath: PathLike,
    options: GeoJsonGeoSourceOptions = {}
  ) {
    super()

    this.crs = options.crs ?? 'EPSG:4326'
    this.encoding = options.encoding ?? 'utf8'
    this.highWaterMark = options.highWaterMark
    this.transformFeature = options.transformFeature
  }

  async open(): Promise<void> {
    await access(this.filePath, constants.R_OK)
  }

  async close(): Promise<void> {}

  async getExtent(): Promise<BBox | null> {
    let extent: BBox | null = null

    for await (const feature of this.readFeatures()) {
      const bbox = feature.bbox ?? computeGeometryBBox(feature.geometry)
      if (bbox) extent = extent ? expandBBox(extent, bbox) : bbox
    }

    return extent
  }

  stream(options: GeoStreamOptions = {}): ReadableStream<GeoFeature> {
    const iterator = this.readFeatures(options.signal)[Symbol.asyncIterator]()

    return new ReadableStream<GeoFeature>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(getAbortReason(options.signal))
          return
        }

        try {
          const result = await iterator.next()

          if (result.done) {
            controller.close()
            return
          }

          controller.enqueue(result.value)
        } catch (error) {
          controller.error(error)
        }
      },

      cancel: async () => {
        await iterator.return?.(undefined)
      }
    })
  }

  private async *readFeatures(signal?: AbortSignal): AsyncGenerator<GeoFeature> {
    let index = 0
    const parser = new FeatureCollectionParser(this.encoding)
    const file = createReadStream(this.filePath, {
      highWaterMark: this.highWaterMark,
      signal
    })

    try {
      for await (const chunk of file) {
        throwIfAborted(signal)
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), this.encoding))

        for (;;) {
          const parsed = parser.read()
          if (!parsed) break

          const sourceRef: GeoFeatureSourceRef = {
            sourceId: this.id,
            offset: parsed.offset,
            byteLength: parsed.byteLength
          }
          const sourceFeature = { ...parsed.feature, sourceRef }
          const outputFeature = this.transformFeature
            ? await this.transformFeature(sourceFeature, index)
            : sourceFeature

          yield { ...outputFeature, sourceRef }
          index += 1
          throwIfAborted(signal)
        }

        if (parser.done) return
      }

      parser.finish()
    } finally {
      file.destroy()
    }
  }
}

type ParsedString = {
  value: string
  end: number
}

type ParsedFeature = {
  feature: GeoFeature
  offset: number
  byteLength: number
}

class FeatureCollectionParser {
  private buffer = ''
  private bufferOffset = 0
  private position = 0
  private searchDepth = 0
  private state: 'searching-features' | 'reading-features' | 'done' = 'searching-features'

  constructor(private readonly encoding: BufferEncoding) {}

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
    const parsedFeature = toGeoFeature(JSON.parse(featureJson))
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

function toGeoFeature(value: unknown): GeoFeature {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'Feature') {
    throw new Error('Invalid GeoJSON: expected a Feature object')
  }

  const feature = value as GeoFeature
  return {
    ...feature,
    properties: feature.properties ?? null
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw getAbortReason(signal)
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('GeoJSON stream aborted')
}