import { createReadStream, type PathLike } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Feature, FileRef, SourceRef } from '../core/feature.js'
import type { Geometry, Position, CrsCode } from '../core/geometry.js'
import type { Layer } from '../layer/layer.js'
import { FileSource, type FeatureTransform } from './source.js'
import type { StreamOptions } from './source.js'
import { AbortSignalGuard, FileByteReader } from './source-utils.js'
import { Props } from '../core/tools.js'

export type GmlAxisOrder = 'xy' | 'yx' | 'auto'

export type GmlSourceOptions = {
  crs?: CrsCode
  encoding?: BufferEncoding
  highWaterMark?: number
  featureElementNames?: string[]
  geometryPropertyNames?: string[]
  axisOrder?: GmlAxisOrder
  transformFeature?: FeatureTransform
}

type ParsedXmlFeature = {
  xml: string
  offset: number
  byteLength: number
}

type XmlTag = {
  name: string
  localName: string
  start: number
  end: number
  closing: boolean
  selfClosing: boolean
  special: boolean
}

type XmlElement = {
  name: string
  localName: string
  outer: string
  inner: string
  openTag: string
  start: number
  end: number
  openEnd: number
  closeStart: number
}

const DEFAULT_FEATURE_ELEMENT_NAMES = ['featureMember', 'member']
const DEFAULT_GEOMETRY_PROPERTY_NAMES = ['geometryProperty', 'geometry', 'geom', 'the_geom']
const GEOMETRY_ELEMENT_NAMES = [
  'MultiSurface',
  'MultiPolygon',
  'MultiCurve',
  'MultiLineString',
  'MultiPoint',
  'Surface',
  'Polygon',
  'Curve',
  'LineString',
  'Point'
]

export class GmlSource extends FileSource {
  readonly type = 'gml'
  readonly crs: CrsCode

  private readonly reader: GmlReader

  constructor(
    readonly id: string,
    private readonly filePath: PathLike,
    options: GmlSourceOptions = {}
  ) {
    super(options.transformFeature)

    this.crs = options.crs ?? 'EPSG:4326'
    this.reader = new GmlReader(this.id, this.filePath, {
      encoding: options.encoding ?? 'utf8',
      highWaterMark: options.highWaterMark,
      featureElementNames: options.featureElementNames ?? DEFAULT_FEATURE_ELEMENT_NAMES,
      geometryPropertyNames: options.geometryPropertyNames ?? DEFAULT_GEOMETRY_PROPERTY_NAMES,
      axisOrder: options.axisOrder ?? 'auto'
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
    return AbortSignalGuard.reason(signal, 'GML stream aborted')
  }
}

class GmlReader {
  constructor(
    private readonly sourceId: string,
    private readonly filePath: PathLike,
    private readonly options: {
      encoding: BufferEncoding
      highWaterMark?: number
      featureElementNames: string[]
      geometryPropertyNames: string[]
      axisOrder: GmlAxisOrder
    }
  ) {}

  async *stream(options: StreamOptions): AsyncGenerator<Feature> {
    const { layer, signal } = options
    let index = 0
    const parser = new GmlFeatureStreamParser(this.options.featureElementNames, this.options.encoding)
    const file = createReadStream(this.filePath, {
      highWaterMark: this.options.highWaterMark,
      signal
    })

    try {
      for await (const chunk of file) {
        AbortSignalGuard.throwIfAborted(signal, 'GML stream aborted')
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), this.options.encoding))

        for (;;) {
          const parsed = parser.read()
          if (!parsed) break

          yield this.withSourceRef(
            parseGmlFeature(parsed.xml, {
              axisOrder: this.options.axisOrder,
              geometryPropertyNames: this.options.geometryPropertyNames
            }, layer),
            {
              storage: 'file',
              sourceId: this.sourceId,
              offset: parsed.offset,
              byteLength: parsed.byteLength,
              recordIndex: index
            },
            layer
          )

          index += 1
          AbortSignalGuard.throwIfAborted(signal, 'GML stream aborted')
        }
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
        throw new Error('Invalid GML sourceRef: byte range exceeds file length')
      }

      return this.withSourceRef(
        parseGmlFeature(buffer.toString(this.options.encoding), {
          axisOrder: this.options.axisOrder,
          geometryPropertyNames: this.options.geometryPropertyNames
        }, options.layer),
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
      throw new Error(`GML sourceRef belongs to "${sourceRef.sourceId}", expected "${this.sourceId}"`)
    }

    if (typeof (sourceRef as Partial<FileRef>).offset !== 'number' || typeof (sourceRef as Partial<FileRef>).byteLength !== 'number') {
      throw new Error('GML sourceRef must include offset and byteLength')
    }

    return sourceRef as FileRef & Pick<SourceRef, 'recordIndex' | 'related'>
  }
}

class GmlFeatureStreamParser {
  private buffer = ''
  private bufferOffset = 0
  private position = 0

  constructor(
    private readonly featureElementNames: string[],
    private readonly encoding: BufferEncoding
  ) {}

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1')
  }

  read(): ParsedXmlFeature | null {
    for (;;) {
      const start = findNextElementStart(this.buffer, this.position)
      if (start === null) {
        this.position = Math.max(0, this.buffer.length - 256)
        this.trimBuffer()
        return null
      }

      const tag = readTagAt(this.buffer, start)
      if (!tag) {
        this.position = start
        this.trimBuffer()
        return null
      }

      if (tag.special || tag.closing || !matchesElementName(tag, this.featureElementNames)) {
        this.position = tag.end
        continue
      }

      const end = findElementEnd(this.buffer, start, tag.name)
      if (end === null) {
        this.position = start
        this.trimBuffer()
        return null
      }

      const xml = Buffer.from(this.buffer.slice(start, end), 'latin1').toString(this.encoding)
      const offset = this.bufferOffset + start
      const byteLength = end - start
      this.position = end
      this.trimBuffer()

      return {
        xml,
        offset,
        byteLength
      }
    }
  }

  finish(): void {
    const next = findNextElementStart(this.buffer, this.position)
    if (next !== null) {
      const tag = readTagAt(this.buffer, next)
      if (tag && !tag.special && !tag.closing && matchesElementName(tag, this.featureElementNames)) {
        throw new Error('Invalid GML: unfinished feature element')
      }
    }
  }

  private trimBuffer(): void {
    if (this.position < 65536) return

    this.buffer = this.buffer.slice(this.position)
    this.bufferOffset += this.position
    this.position = 0
  }
}

function parseGmlFeature(
  xml: string,
  options: Pick<GmlSourceOptions, 'axisOrder' | 'geometryPropertyNames'>,
  layer: Layer
): Feature {
  const root = readFirstElement(xml)
  if (!root) throw new Error('Invalid GML: expected a feature XML element')

  const featureElement = root.localName === 'featureMember' || root.localName === 'member'
    ? firstChildElement(root) ?? root
    : root
  const properties = parseProperties(featureElement, options.geometryPropertyNames ?? DEFAULT_GEOMETRY_PROPERTY_NAMES)
  const geometry = parseGmlGeometry(featureElement.outer, options.axisOrder ?? 'auto')
  const id = getAttribute(featureElement.openTag, 'gml:id')
    ?? getAttribute(featureElement.openTag, 'id')
    ?? undefined

  return {
    layer,
    type: 'Feature',
    id,
    properties,
    geometry
  }
}

function parseProperties(featureElement: XmlElement, geometryPropertyNames: string[]): Props {
  const properties: Props = {}

  for (const child of childElements(featureElement)) {
    if (child.localName === 'boundedBy') continue
    if (matchesName(child.localName, child.name, geometryPropertyNames)) continue
    if (containsGeometry(child.outer)) continue

    properties[child.localName] = parsePropertyValue(child)
  }

  return properties
}

function parsePropertyValue(element: XmlElement): unknown {
  const nil = getAttribute(element.openTag, 'xsi:nil') ?? getAttribute(element.openTag, 'nil')
  if (nil === 'true' || nil === '1') return null

  const text = decodeXmlEntities(stripTags(element.inner).trim())
  if (text.length === 0) return null
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return Number(text)
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true'

  return text
}

function parseGmlGeometry(xml: string, axisOrderOption: GmlAxisOrder): Geometry | null {
  const element = findFirstElementByLocalNames(xml, GEOMETRY_ELEMENT_NAMES)
  if (!element) return null

  return parseGeometryElement(element, axisOrderOption)
}

function parseGeometryElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const axisOrder = resolveAxisOrder(axisOrderOption, element)

  switch (element.localName) {
    case 'Point':
      return parsePointElement(element, axisOrder)

    case 'LineString':
      return parseLineStringElement(element, axisOrder)

    case 'Curve':
      return parseCurveElement(element, axisOrder)

    case 'Polygon':
    case 'Surface':
      return parsePolygonGeometry(element, axisOrder)

    case 'MultiPoint':
      return parseMultiPointElement(element, axisOrder)

    case 'MultiCurve':
    case 'MultiLineString':
      return parseMultiCurveElement(element, axisOrder)

    case 'MultiSurface':
    case 'MultiPolygon':
      return parseMultiSurfaceElement(element, axisOrder)

    default:
      return null
  }
}

function parsePointElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const position = parseSinglePosition(element, axisOrderOption)
  if (!position) return null

  return {
    type: 'Point',
    coordinates: position
  }
}

function parseLineStringElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const coordinates = parsePositions(element, axisOrderOption)
  if (!coordinates || coordinates.length === 0) return null

  return {
    type: 'LineString',
    coordinates
  }
}

function parseCurveElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const segmentPositions = findElementsByLocalNames(element.outer, ['LineStringSegment'])
    .map((segment) => parsePositions(segment, axisOrderOption) ?? [])
    .filter((positions) => positions.length > 0)

  const coordinates = segmentPositions.length > 0
    ? segmentPositions.flat()
    : parsePositions(element, axisOrderOption)

  if (!coordinates || coordinates.length === 0) return null

  return {
    type: 'LineString',
    coordinates
  }
}

function parsePolygonGeometry(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const coordinates = parsePolygonCoordinates(element, axisOrderOption)
  if (!coordinates || coordinates.length === 0) return null

  return {
    type: 'Polygon',
    coordinates
  }
}

function parseMultiPointElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const coordinates = findElementsByLocalNames(element.outer, ['Point'])
    .map((point) => parseSinglePosition(point, axisOrderOption))
    .filter((position): position is Position => Boolean(position))

  if (coordinates.length === 0) return null

  return {
    type: 'MultiPoint',
    coordinates
  }
}

function parseMultiCurveElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const lines = findElementsByLocalNames(element.outer, ['LineString', 'Curve'])
    .map((line) => {
      const geometry = parseGeometryElement(line, axisOrderOption)
      return geometry?.type === 'LineString' ? geometry.coordinates : null
    })
    .filter((line): line is Position[] => Boolean(line))

  if (lines.length === 0) return null
  if (lines.length === 1) {
    return {
      type: 'LineString',
      coordinates: lines[0]
    }
  }

  return {
    type: 'MultiLineString',
    coordinates: lines
  }
}

function parseMultiSurfaceElement(element: XmlElement, axisOrderOption: GmlAxisOrder): Geometry | null {
  const polygons = findElementsByLocalNames(element.outer, ['Polygon', 'Surface'])
    .map((polygon) => parsePolygonCoordinates(polygon, axisOrderOption))
    .filter((polygon): polygon is Position[][] => Boolean(polygon && polygon.length > 0))

  if (polygons.length === 0) return null
  if (polygons.length === 1) {
    return {
      type: 'Polygon',
      coordinates: polygons[0]
    }
  }

  return {
    type: 'MultiPolygon',
    coordinates: polygons
  }
}

function parsePolygonCoordinates(element: XmlElement, axisOrderOption: GmlAxisOrder): Position[][] | null {
  const exterior = findFirstElementByLocalNames(element.outer, ['exterior', 'outerBoundaryIs'])
  const exteriorRing = exterior ? findFirstElementByLocalNames(exterior.outer, ['LinearRing', 'Ring']) : null
  const rings: Position[][] = []

  if (exteriorRing) {
    const coordinates = parsePositions(exteriorRing, axisOrderOption)
    if (coordinates && coordinates.length > 0) rings.push(coordinates)
  }

  for (const interior of findElementsByLocalNames(element.outer, ['interior', 'innerBoundaryIs'])) {
    const ring = findFirstElementByLocalNames(interior.outer, ['LinearRing', 'Ring'])
    const coordinates = ring ? parsePositions(ring, axisOrderOption) : null
    if (coordinates && coordinates.length > 0) rings.push(coordinates)
  }

  if (rings.length === 0) {
    for (const ring of findElementsByLocalNames(element.outer, ['LinearRing'])) {
      const coordinates = parsePositions(ring, axisOrderOption)
      if (coordinates && coordinates.length > 0) rings.push(coordinates)
    }
  }

  return rings.length > 0 ? rings : null
}

function parseSinglePosition(element: XmlElement, axisOrderOption: GmlAxisOrder): Position | null {
  const positions = parsePositions(element, axisOrderOption)
  return positions?.[0] ?? null
}

function parsePositions(element: XmlElement, axisOrderOption: GmlAxisOrder): Position[] | null {
  const posList = findFirstElementByLocalNames(element.outer, ['posList'])
  const axisOrder = resolveAxisOrder(axisOrderOption, element)

  if (posList) {
    const dimension = readDimension(posList, element)
    return numbersToPositions(textNumbers(posList.inner), dimension, axisOrder)
  }

  const positions = findElementsByLocalNames(element.outer, ['pos'])
    .map((pos) => numbersToPositions(textNumbers(pos.inner), readDimension(pos, element), axisOrder)[0])
    .filter((position): position is Position => Boolean(position))

  if (positions.length > 0) return positions

  const coordinates = findFirstElementByLocalNames(element.outer, ['coordinates'])
  if (coordinates) return parseCoordinatesText(coordinates.inner, axisOrder)

  return null
}

function numbersToPositions(values: number[], dimension: number, axisOrder: 'xy' | 'yx'): Position[] {
  const positions: Position[] = []

  for (let index = 0; index + 1 < values.length; index += dimension) {
    const first = values[index]
    const second = values[index + 1]
    const rest = values.slice(index + 2, index + dimension)
    positions.push(axisOrder === 'yx' ? [second, first, ...rest] : [first, second, ...rest])
  }

  return positions
}

function parseCoordinatesText(text: string, axisOrder: 'xy' | 'yx'): Position[] {
  return decodeXmlEntities(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple) => tuple.split(',').map(Number).filter((value) => !Number.isNaN(value)))
    .filter((values) => values.length >= 2)
    .map((values): Position => axisOrder === 'yx'
      ? [values[1], values[0], ...values.slice(2)]
      : [values[0], values[1], ...values.slice(2)])
}

function textNumbers(text: string): number[] {
  return decodeXmlEntities(text)
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => !Number.isNaN(value))
}

function readDimension(element: XmlElement, fallback: XmlElement): number {
  const raw = getAttribute(element.openTag, 'srsDimension')
    ?? getAttribute(fallback.openTag, 'srsDimension')
    ?? getAttribute(element.openTag, 'dimension')
    ?? getAttribute(fallback.openTag, 'dimension')
  const dimension = raw ? Number(raw) : 2

  return Number.isInteger(dimension) && dimension >= 2 ? dimension : 2
}

function resolveAxisOrder(axisOrder: GmlAxisOrder, element: XmlElement): 'xy' | 'yx' {
  if (axisOrder === 'xy' || axisOrder === 'yx') return axisOrder

  const srsName = findSrsName(element)
  if (!srsName) return 'xy'

  return /EPSG(?:::|[:/])4326/i.test(srsName) || /urn:ogc:def:crs:EPSG::4326/i.test(srsName)
    ? 'yx'
    : 'xy'
}

function findSrsName(element: XmlElement): string | null {
  const own = getAttribute(element.openTag, 'srsName')
  if (own) return own

  const geometry = findFirstElementByLocalNames(element.outer, GEOMETRY_ELEMENT_NAMES)
  return geometry ? getAttribute(geometry.openTag, 'srsName') : null
}

function readFirstElement(xml: string): XmlElement | null {
  const start = findNextElementStart(xml, 0)
  return start === null ? null : readElementAt(xml, start)
}

function firstChildElement(element: XmlElement): XmlElement | null {
  const children = childElements(element)
  return children[0] ?? null
}

function childElements(element: XmlElement): XmlElement[] {
  const children: XmlElement[] = []
  let position = element.openEnd

  while (position < element.closeStart) {
    const start = findNextElementStart(element.outer, position)
    if (start === null || start >= element.closeStart) break

    const tag = readTagAt(element.outer, start)
    if (!tag) break
    if (tag.special || tag.closing) {
      position = tag.end
      continue
    }

    const child = readElementAt(element.outer, start)
    if (!child) break

    children.push(child)
    position = child.end
  }

  return children
}

function findFirstElementByLocalNames(xml: string, names: string[]): XmlElement | null {
  let position = 0

  while (position < xml.length) {
    const start = findNextElementStart(xml, position)
    if (start === null) return null

    const tag = readTagAt(xml, start)
    if (!tag) return null

    if (!tag.special && !tag.closing && matchesElementName(tag, names)) {
      return readElementAt(xml, start)
    }

    position = tag.end
  }

  return null
}

function findElementsByLocalNames(xml: string, names: string[]): XmlElement[] {
  const elements: XmlElement[] = []
  let position = 0

  while (position < xml.length) {
    const start = findNextElementStart(xml, position)
    if (start === null) break

    const tag = readTagAt(xml, start)
    if (!tag) break

    if (!tag.special && !tag.closing && matchesElementName(tag, names)) {
      const element = readElementAt(xml, start)
      if (!element) break
      elements.push(element)
      position = element.end
      continue
    }

    position = tag.end
  }

  return elements
}

function readElementAt(xml: string, start: number): XmlElement | null {
  const tag = readTagAt(xml, start)
  if (!tag || tag.special || tag.closing) return null

  const bounds = findElementBounds(xml, start, tag.name)
  if (!bounds) return null

  return {
    name: tag.name,
    localName: tag.localName,
    outer: xml.slice(start, bounds.end),
    inner: xml.slice(tag.end, bounds.closeStart),
    openTag: xml.slice(start, tag.end),
    start,
    end: bounds.end,
    openEnd: tag.end - start,
    closeStart: bounds.closeStart - start
  }
}

function findElementEnd(xml: string, start: number, tagName: string): number | null {
  return findElementBounds(xml, start, tagName)?.end ?? null
}

function findElementBounds(xml: string, start: number, tagName: string): { end: number, closeStart: number } | null {
  let depth = 0
  let position = start

  while (position < xml.length) {
    const next = findNextElementStart(xml, position)
    if (next === null) return null

    const tag = readTagAt(xml, next)
    if (!tag) return null

    position = tag.end

    if (tag.special) continue

    if (tag.name === tagName) {
      if (tag.closing) {
        depth -= 1
        if (depth === 0) return { end: tag.end, closeStart: tag.start }
      } else if (tag.selfClosing) {
        if (depth === 0) return { end: tag.end, closeStart: tag.end }
      } else {
        depth += 1
      }
    }
  }

  return null
}

function findNextElementStart(xml: string, start: number): number | null {
  const index = xml.indexOf('<', start)
  return index === -1 ? null : index
}

function readTagAt(xml: string, start: number): XmlTag | null {
  if (xml[start] !== '<') return null

  if (xml.startsWith('<!--', start)) return readSpecialTag(xml, start, '-->')
  if (xml.startsWith('<![CDATA[', start)) return readSpecialTag(xml, start, ']]>')
  if (xml.startsWith('<?', start)) return readSpecialTag(xml, start, '?>')
  if (xml.startsWith('<!', start)) return readSpecialTag(xml, start, '>')

  let index = start + 1
  let closing = false

  if (xml[index] === '/') {
    closing = true
    index += 1
  }

  while (index < xml.length && isWhitespace(xml[index])) index += 1

  const nameStart = index
  while (index < xml.length && !isWhitespace(xml[index]) && xml[index] !== '/' && xml[index] !== '>') {
    index += 1
  }

  if (index >= xml.length) return null

  const name = xml.slice(nameStart, index)
  const end = findTagEnd(xml, index)
  if (end === null) return null

  const beforeEnd = xml.slice(index, end - 1).trimEnd()

  return {
    name,
    localName: localName(name),
    start,
    end,
    closing,
    selfClosing: beforeEnd.endsWith('/'),
    special: false
  }
}

function readSpecialTag(xml: string, start: number, terminator: string): XmlTag | null {
  const endIndex = xml.indexOf(terminator, start + 1)
  if (endIndex === -1) return null

  return {
    name: '',
    localName: '',
    start,
    end: endIndex + terminator.length,
    closing: false,
    selfClosing: true,
    special: true
  }
}

function findTagEnd(xml: string, start: number): number | null {
  let quote: string | null = null

  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index]

    if (quote) {
      if (char === quote) quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '>') return index + 1
  }

  return null
}

function matchesElementName(tag: XmlTag, names: string[]): boolean {
  return names.some((name) => matchesName(tag.localName, tag.name, name))
}

function matchesName(local: string, qualified: string, expected: string | string[]): boolean {
  const names = Array.isArray(expected) ? expected : [expected]
  return names.some((name) => name === local || name === qualified)
}

function containsGeometry(xml: string): boolean {
  return Boolean(findFirstElementByLocalNames(xml, GEOMETRY_ELEMENT_NAMES))
}

function getAttribute(openTag: string, attributeName: string): string | null {
  const attributes = openTag.slice(0, openTag.endsWith('/>') ? -2 : -1)
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)')`)
  const match = attributes.match(matcher)

  return match ? decodeXmlEntities(match[2] ?? match[3] ?? '') : null
}

function stripTags(xml: string): string {
  return xml.replace(/<[^>]*>/g, '')
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function localName(name: string): string {
  const index = name.indexOf(':')
  return index === -1 ? name : name.slice(index + 1)
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}
