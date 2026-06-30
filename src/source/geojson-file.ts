import type { PathLike } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { DescInfo, Feature, FileRef, SourceRef } from '../core/feature.js'
import { Gt } from '../core/geotools.js'
import type { BBox, Geometry, Position } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import type { SourceFile, StreamOptions } from './source.js'
import { AbortSignalGuard, FileByteReader } from './source-utils.js'
import { Crs } from '../core/crs.js'

const HILBERT_LEVEL = 20
const HILBERT_GRID_SIZE = 2 ** HILBERT_LEVEL
const WEB_MERCATOR_EXTENT = 20037508.342789244

type ClusterFeature = {
  feature: Record<string, unknown>
  hilbert: number
  index: number
}

export class GeoJsonFileReader {
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

  get encoding(): BufferEncoding {
    return this.options.encoding
  }

  async *stream(options: StreamOptions, file: AsyncIterable<Buffer | string>): AsyncGenerator<Feature> {
    const { layer, signal } = options
    const parser = new FeatureCollectionParser(this.options.encoding, layer)

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

export class ClusteredGeoJsonFile {
  private readonly reader: GeoJsonFileReader

  constructor(
    private readonly sourceId: string,
    private readonly filePath: string,
    private readonly encoding: BufferEncoding = 'utf8',
    highWaterMark?: number
  ) {
    this.reader = new GeoJsonFileReader(sourceId, { encoding, highWaterMark })
  }

  get file(): SourceFile {
    return {
      role: 'data',
      path: this.filePath
    }
  }

  async prepare(
    layer: Layer,
    originalFiles: readonly SourceFile[],
    streamOriginal: () => ReadableStream<Feature>
  ): Promise<void> {
    if (!await this.needsBuild(originalFiles)) return

    const features: ClusterFeature[] = []
    const precision = clusteredCoordinatePrecision(layer)
    const reader = streamOriginal().getReader()
    let index = 0

    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        features.push({
          feature: toWritableFeature(result.value, precision),
          hilbert: hilbertKey(result.value, layer),
          index
        })
        index += 1
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }

    features.sort((a, b) => a.hilbert - b.hilbert || a.index - b.index)
    await writeFeatureCollection(this.filePath, features.map((item) => item.feature), this.encoding)
  }

  stream(options: StreamOptions): AsyncIterable<Feature> {
    return this.reader.stream(options, openFileIterable(this.filePath, this.reader.highWaterMark))
  }

  async read(sourceRef: SourceRef, options: StreamOptions): Promise<Feature | null> {
    const handle = await openFile(this.filePath, 'r')

    try {
      return await this.reader.read(sourceRef, options, handle)
    } finally {
      await handle.close()
    }
  }

  private async needsBuild(originalFiles: readonly SourceFile[]): Promise<boolean> {
    const clusteredStat = await stat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })

    if (!clusteredStat) return true

    for (const file of originalFiles) {
      if (clusteredStat.mtimeMs < (await stat(pathToString(file.path))).mtimeMs) return true
    }

    return false
  }
}

export function clusteredGeoJsonPath(sourceFile: SourceFile): string {
  return `${pathToString(sourceFile.path)}.clustered.geojson`
}

export function pathToString(path: PathLike): string {
  if (path instanceof URL) return fileURLToPath(path)
  return path.toString()
}

function openFileIterable(path: PathLike, highWaterMark = 64 * 1024): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      const handle = await openFile(path, 'r')
      let position = 0

      try {
        for (;;) {
          const buffer = Buffer.allocUnsafe(highWaterMark)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) return
          position += bytesRead
          yield buffer.subarray(0, bytesRead)
        }
      } finally {
        await handle.close()
      }
    }
  }
}

async function writeFeatureCollection(path: string, features: readonly Record<string, unknown>[], encoding: BufferEncoding): Promise<void> {
  const handle = await openFile(path, 'w')
  let position = 0

  try {
    position += await writeString(handle, '{"type":"FeatureCollection","features":[\n', position, encoding)
    for (let index = 0; index < features.length; index += 1) {
      if (index > 0) position += await writeString(handle, ',\n', position, encoding)
      position += await writeString(handle, JSON.stringify(features[index]), position, encoding)
    }
    await writeString(handle, '\n]}\n', position, encoding)
  } finally {
    await handle.close()
  }
}

async function writeString(handle: FileHandle, value: string, position: number, encoding: BufferEncoding): Promise<number> {
  const buffer = Buffer.from(value, encoding)
  await handle.write(buffer, 0, buffer.length, position)
  return buffer.length
}

function toWritableFeature(feature: Feature, precision: number | undefined): Record<string, unknown> {
  return {
    type: 'Feature',
    ...(feature.id === undefined ? {} : { id: feature.id }),
    ...(feature.bbox === undefined ? {} : { bbox: roundBbox(feature.bbox, precision) }),
    properties: feature.properties ?? null,
    geometry: roundGeometry(feature.geometry, precision)
  }
}

function clusteredCoordinatePrecision(layer: Layer): number | undefined {
  return Crs.registry.has(layer.crs)
    ? Crs.registry.get(layer.crs).coordinatePrecision
    : new Crs(layer.crs).coordinatePrecision
}

function roundBbox(bbox: BBox, precision: number | undefined): BBox {
  return precision === undefined
    ? bbox
    : [
      roundNumber(bbox[0], precision),
      roundNumber(bbox[1], precision),
      roundNumber(bbox[2], precision),
      roundNumber(bbox[3], precision)
    ]
}

function roundGeometry(geometry: Geometry | null, precision: number | undefined): Geometry | null {
  if (!geometry || precision === undefined) return geometry

  switch (geometry.type) {
    case 'Point':
      return {
        type: 'Point',
        coordinates: roundPosition(geometry.coordinates, precision)
      }
    case 'LineString':
      return {
        type: 'LineString',
        coordinates: geometry.coordinates.map((position) => roundPosition(position, precision))
      }
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) => ring.map((position) => roundPosition(position, precision)))
      }
    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: geometry.coordinates.map((position) => roundPosition(position, precision))
      }
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map((line) => line.map((position) => roundPosition(position, precision)))
      }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map((position) => roundPosition(position, precision)))
        )
      }
  }
}

function roundPosition(position: Position, precision: number): Position {
  const rounded = position.map((value) => roundNumber(value, precision)) as Position
  return rounded
}

function roundNumber(value: number, precision: number): number {
  return Number(value.toFixed(precision))
}

function hilbertKey(feature: Feature, layer: Layer): number {
  const bbox = feature.bbox ?? Gt.bbox(feature.geometry)
  if (!bbox) return Number.MAX_SAFE_INTEGER

  const center = Gt.transformPosition([
    (bbox[0] + bbox[2]) / 2,
    (bbox[1] + bbox[3]) / 2
  ], layer.crs, 'EPSG:3857')
  const x = quantizeWebMercator(center[0])
  const y = quantizeWebMercator(center[1])
  return hilbertIndex(x, y, HILBERT_LEVEL)
}

function quantizeWebMercator(value: number): number {
  const normalized = (Gt.clamp(value, -WEB_MERCATOR_EXTENT, WEB_MERCATOR_EXTENT) + WEB_MERCATOR_EXTENT)
    / (WEB_MERCATOR_EXTENT * 2)
  return Math.min(HILBERT_GRID_SIZE - 1, Math.max(0, Math.floor(normalized * HILBERT_GRID_SIZE)))
}

function hilbertIndex(x: number, y: number, level: number): number {
  let index = 0

  for (let scale = 1 << (level - 1); scale > 0; scale >>= 1) {
    const rx = (x & scale) > 0 ? 1 : 0
    const ry = (y & scale) > 0 ? 1 : 0
    index += scale * scale * ((3 * rx) ^ ry)

    if (ry === 0) {
      if (rx === 1) {
        x = HILBERT_GRID_SIZE - 1 - x
        y = HILBERT_GRID_SIZE - 1 - y
      }

      const swap = x
      x = y
      y = swap
    }
  }

  return index
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
