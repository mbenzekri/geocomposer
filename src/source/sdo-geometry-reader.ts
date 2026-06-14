import type { Geometry, Position } from '../core/geometry.js'

type SdoGeometryData = {
  gtype: number
  dimension: number
  geometryType: number
  point: unknown
  elemInfo: SdoElement[]
  ordinates: number[]
}

type SdoElement = {
  offset: number
  etype: number
  interpretation: number
}

export class SdoGeometryReader {
  readGeometry(value: unknown): Geometry | null {
    if (!value) return null

    const data = this.readData(value)

    switch (data.geometryType) {
      case 1:
        return this.readPoint(data)

      case 2:
        return this.readLineString(data)

      case 3:
        return this.readPolygon(data)

      case 4:
        return this.readCollection(data)

      case 5:
        return this.readMultiPoint(data)

      case 6:
        return this.readMultiLineString(data)

      case 7:
        return this.readMultiPolygon(data)

      default:
        throw new Error(`Unsupported Oracle SDO_GEOMETRY type: ${data.gtype}`)
    }
  }

  private readData(value: unknown): SdoGeometryData {
    const gtype = toRequiredInteger(field(value, 'SDO_GTYPE'), 'SDO_GTYPE')
    const dimension = Math.trunc(gtype / 1000)
    const geometryType = gtype % 100

    if (dimension < 2) {
      throw new Error(`Invalid Oracle SDO_GEOMETRY dimension in SDO_GTYPE: ${gtype}`)
    }

    return {
      gtype,
      dimension,
      geometryType,
      point: field(value, 'SDO_POINT'),
      elemInfo: toElements(field(value, 'SDO_ELEM_INFO')),
      ordinates: toNumberArray(field(value, 'SDO_ORDINATES'), 'SDO_ORDINATES')
    }
  }

  private readPoint(data: SdoGeometryData): Geometry | null {
    const point = this.readPointObject(data.point)
    if (point) {
      return {
        type: 'Point',
        coordinates: point
      }
    }

    if (data.ordinates.length === 0) return null

    const element = data.elemInfo[0]
    const offset = element ? element.offset : 0

    return {
      type: 'Point',
      coordinates: this.positionAt(data, offset)
    }
  }

  private readMultiPoint(data: SdoGeometryData): Geometry | null {
    const points = this.readPointElements(data)
    const point = points.length > 0 ? null : this.readPointObject(data.point)
    if (point) points.push(point)

    return points.length === 0
      ? null
      : {
        type: 'MultiPoint',
        coordinates: points
      }
  }

  private readLineString(data: SdoGeometryData): Geometry | null {
    const lines = this.readLineElements(data)
    if (lines.length === 0) return null

    return lines.length === 1
      ? {
        type: 'LineString',
        coordinates: lines[0]
      }
      : {
        type: 'MultiLineString',
        coordinates: lines
      }
  }

  private readMultiLineString(data: SdoGeometryData): Geometry | null {
    const lines = this.readLineElements(data)

    return lines.length === 0
      ? null
      : {
        type: 'MultiLineString',
        coordinates: lines
      }
  }

  private readPolygon(data: SdoGeometryData): Geometry | null {
    const polygons = this.readPolygonElements(data)
    if (polygons.length === 0) return null

    return polygons.length === 1
      ? {
        type: 'Polygon',
        coordinates: polygons[0]
      }
      : {
        type: 'MultiPolygon',
        coordinates: polygons
      }
  }

  private readMultiPolygon(data: SdoGeometryData): Geometry | null {
    const polygons = this.readPolygonElements(data)

    return polygons.length === 0
      ? null
      : {
        type: 'MultiPolygon',
        coordinates: polygons
      }
  }

  private readCollection(data: SdoGeometryData): Geometry | null {
    if (data.elemInfo.every((element) => isPointElement(element))) {
      return this.readMultiPoint(data)
    }

    if (data.elemInfo.every((element) => isLineElement(element))) {
      return this.readMultiLineString(data)
    }

    if (data.elemInfo.every((element) => isPolygonRingElement(element))) {
      return this.readMultiPolygon(data)
    }

    return null
  }

  private readPointObject(value: unknown): Position | null {
    if (!value) return null

    const x = toOptionalNumber(field(value, 'X'))
    const y = toOptionalNumber(field(value, 'Y'))
    const z = toOptionalNumber(field(value, 'Z'))

    if (x === null || y === null) return null

    return z === null ? [x, y] : [x, y, z]
  }

  private readPointElements(data: SdoGeometryData): Position[] {
    const points: Position[] = []

    data.elemInfo.forEach((element, index) => {
      if (!isPointElement(element)) {
        throw new Error(`Unsupported Oracle SDO point element type: ${element.etype}`)
      }

      const end = this.elementEnd(data, index)
      const segmentCount = Math.floor((end - element.offset) / data.dimension)
      const pointCount = element.interpretation > 1 ? element.interpretation : segmentCount

      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        points.push(this.positionAt(data, element.offset + pointIndex * data.dimension))
      }
    })

    return points
  }

  private readLineElements(data: SdoGeometryData): Position[][] {
    const lines: Position[][] = []

    data.elemInfo.forEach((element, index) => {
      if (!isLineElement(element)) {
        throw new Error(`Unsupported Oracle SDO line element type: ${element.etype}`)
      }

      if (element.interpretation !== 1) {
        throw new Error(`Unsupported Oracle SDO line interpretation: ${element.interpretation}`)
      }

      lines.push(this.positionsForElement(data, element, index))
    })

    return lines
  }

  private readPolygonElements(data: SdoGeometryData): Position[][][] {
    const polygons: Position[][][] = []
    let currentPolygon: Position[][] | null = null
    let oldStyleRingIndex = 0

    data.elemInfo.forEach((element, index) => {
      if (!isPolygonRingElement(element)) {
        throw new Error(`Unsupported Oracle SDO polygon element type: ${element.etype}`)
      }

      const ring = this.ringForElement(data, element, index)
      const isInterior = element.etype === 2003
        || (element.etype === 3 && oldStyleRingIndex > 0 && currentPolygon !== null)

      if (!isInterior || !currentPolygon) {
        currentPolygon = [ring]
        polygons.push(currentPolygon)
      } else {
        currentPolygon.push(ring)
      }

      oldStyleRingIndex += 1
    })

    return polygons
  }

  private ringForElement(data: SdoGeometryData, element: SdoElement, index: number): Position[] {
    switch (element.interpretation) {
      case 1:
        return closeRing(this.positionsForElement(data, element, index))

      case 3:
        return rectangleRing(this.positionsForElement(data, element, index))

      default:
        throw new Error(`Unsupported Oracle SDO polygon interpretation: ${element.interpretation}`)
    }
  }

  private positionsForElement(data: SdoGeometryData, element: SdoElement, index: number): Position[] {
    const end = this.elementEnd(data, index)
    const positions: Position[] = []

    for (let offset = element.offset; offset + data.dimension <= end; offset += data.dimension) {
      positions.push(this.positionAt(data, offset))
    }

    return positions
  }

  private positionAt(data: SdoGeometryData, offset: number): Position {
    if (offset < 0 || offset + 2 > data.ordinates.length) {
      throw new Error('Invalid Oracle SDO_GEOMETRY: ordinate offset is out of range')
    }

    const values: number[] = []

    for (let index = 0; index < data.dimension; index += 1) {
      const value = data.ordinates[offset + index]
      if (value === undefined) break
      values.push(value)
    }

    if (values.length < 2) {
      throw new Error('Invalid Oracle SDO_GEOMETRY: position has fewer than two ordinates')
    }

    return values as Position
  }

  private elementEnd(data: SdoGeometryData, index: number): number {
    return data.elemInfo[index + 1]?.offset ?? data.ordinates.length
  }
}

function toElements(value: unknown): SdoElement[] {
  const values = toNumberArray(value, 'SDO_ELEM_INFO')

  if (values.length === 0) return []

  if (values.length % 3 !== 0) {
    throw new Error('Invalid Oracle SDO_GEOMETRY: SDO_ELEM_INFO length must be divisible by 3')
  }

  const elements: SdoElement[] = []

  for (let index = 0; index < values.length; index += 3) {
    const offset = values[index] - 1
    const etype = values[index + 1]
    const interpretation = values[index + 2]

    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('Invalid Oracle SDO_GEOMETRY: SDO_ELEM_INFO offset must be one-based')
    }

    elements.push({ offset, etype, interpretation })
  }

  return elements
}

function isPointElement(element: SdoElement): boolean {
  return element.etype === 1
}

function isLineElement(element: SdoElement): boolean {
  return element.etype === 2
}

function isPolygonRingElement(element: SdoElement): boolean {
  return element.etype === 3 || element.etype === 1003 || element.etype === 2003
}

function rectangleRing(positions: Position[]): Position[] {
  if (positions.length < 2) {
    throw new Error('Invalid Oracle SDO rectangle: expected two positions')
  }

  const [first, second] = positions
  const minX = Math.min(first[0], second[0])
  const minY = Math.min(first[1], second[1])
  const maxX = Math.max(first[0], second[0])
  const maxY = Math.max(first[1], second[1])

  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY]
  ]
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring

  const first = ring[0]
  const last = ring[ring.length - 1]

  if (first[0] === last[0] && first[1] === last[1]) {
    return ring
  }

  return [...ring, [...first] as Position]
}

function field(value: unknown, name: string): unknown {
  if (!isRecord(value)) return undefined

  for (const key of [name, name.toLowerCase(), name.toUpperCase()]) {
    if (key in value) return value[key]
  }

  const toJSON = value.toJSON
  if (typeof toJSON === 'function') {
    const pojo = toJSON.call(value)
    if (pojo !== value) return field(pojo, name)
  }

  return undefined
}

function toNumberArray(value: unknown, label: string): number[] {
  if (value === null || value === undefined) return []

  if (Array.isArray(value)) {
    return value.map((item) => toRequiredNumber(item, label))
  }

  if (isRecord(value) && typeof value.getValues === 'function') {
    return toNumberArray(value.getValues(), label)
  }

  if (isIterable(value)) {
    return Array.from(value).map((item) => toRequiredNumber(item, label))
  }

  if (isRecord(value) && typeof value.toJSON === 'function') {
    const pojo = value.toJSON()
    if (pojo !== value) return toNumberArray(pojo, label)
  }

  throw new Error(`Invalid Oracle SDO_GEOMETRY: ${label} is not a numeric collection`)
}

function toRequiredInteger(value: unknown, label: string): number {
  const number = toRequiredNumber(value, label)

  if (!Number.isInteger(number)) {
    throw new Error(`Invalid Oracle SDO_GEOMETRY: ${label} must be an integer`)
  }

  return number
}

function toRequiredNumber(value: unknown, label: string): number {
  const number = toOptionalNumber(value)

  if (number === null) {
    throw new Error(`Invalid Oracle SDO_GEOMETRY: ${label} must be numeric`)
  }

  return number
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : null
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof (value as { [Symbol.iterator]?: unknown })?.[Symbol.iterator] === 'function'
}
