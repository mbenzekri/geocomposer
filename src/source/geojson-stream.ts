import type { Feature } from '../core/feature.js'
import type { Layer } from '../layer/layer.js'

export type ParsedGeoJsonFeature = {
  raw: Buffer
  feature: Feature | null
  offset: number
  byteLength: number
}

type ParsedString = {
  value: string
  end: number
}

export class GeoJsonParser {
  private buffer = ''
  private bufferOffset = 0
  private position = 0
  private searchDepth = 0
  private state: 'searching-features' | 'reading-features' | 'done' = 'searching-features'

  constructor(
    private readonly encoding: BufferEncoding,
    private readonly layer?: Layer
  ) {}

  get done(): boolean {
    return this.state === 'done'
  }

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1')
  }

  read(): ParsedGeoJsonFeature | null {
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

  private readFeatureFromArray(): ParsedGeoJsonFeature | null {
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

    const raw = Buffer.from(this.buffer.slice(start, end), 'latin1')
    const parsedFeature = this.layer
      ? parseGeoJsonFeature(JSON.parse(raw.toString(this.encoding)), this.layer)
      : null
    const offset = this.bufferOffset + start
    const byteLength = end - start

    this.position = end
    this.trimBuffer()

    return {
      raw,
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

export class GeoJsonWriter {
  private readonly flushBytes: number
  private readonly buffer: Array<Buffer | string> = []
  private bufferBytes = 0
  private count = 0
  private closed = false

  constructor(
    private readonly writeChunk: (chunk: Buffer | string) => void | Promise<void>,
    options: { flushBytes?: number } = {}
  ) {
    this.flushBytes = options.flushBytes ?? 32 * 1024 * 1024
  }

  async open(): Promise<void> {
    await this.writeChunk('{"type":"FeatureCollection","features":[\n')
  }

  async writeFeature(feature: Buffer | string): Promise<void> {
    if (this.closed) throw new Error('GeoJSON FeatureCollection writer is closed')
    if (this.count > 0) this.push(',\n')
    this.push(feature)
    if (this.bufferBytes >= this.flushBytes) await this.flush()
    this.count += 1
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    await this.writeChunk(Buffer.concat(this.buffer.map(toBuffer), this.bufferBytes))
    this.buffer.length = 0
    this.bufferBytes = 0
  }

  async close(): Promise<number> {
    if (!this.closed) {
      await this.flush()
      await this.writeChunk('\n]}')
      this.closed = true
    }

    return this.count
  }

  private push(chunk: Buffer | string): void {
    this.buffer.push(chunk)
    this.bufferBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

export function parseGeoJsonFeature(value: unknown, layer: Layer): Feature {
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
