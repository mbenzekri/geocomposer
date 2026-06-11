import type { Geometry, Position } from '../core/geometry.js'

export class WkbReader {
  private readonly view: DataView
  private offset = 0

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  get eof(): boolean {
    return this.offset === this.buffer.length
  }

  readGeometry(): Geometry | null {
    const littleEndian = this.readUInt8() === 1
    const rawType = this.readUInt32(littleEndian)
    const decoded = decodeWkbType(rawType)

    if (decoded.hasSrid) {
      this.readUInt32(littleEndian)
    }

    switch (decoded.baseType) {
      case 0:
        return null

      case 1:
        return this.readPoint(decoded.dimensions, littleEndian)

      case 2:
        return this.readLineString(decoded.dimensions, littleEndian)

      case 3:
        return this.readPolygon(decoded.dimensions, littleEndian)

      case 4:
        return this.readMultiPoint(decoded.dimensions, littleEndian)

      case 5:
        return this.readMultiLineString(decoded.dimensions, littleEndian)

      case 6:
        return this.readMultiPolygon(decoded.dimensions, littleEndian)

      case 7:
        return this.readGeometryCollection(littleEndian)

      default:
        throw new Error(`Unsupported WKB geometry type: ${rawType}`)
    }
  }

  private readPoint(dimension: number, littleEndian: boolean): Geometry | null {
    const position = this.readPosition(dimension, littleEndian)
    if (Number.isNaN(position[0]) || Number.isNaN(position[1])) return null

    return {
      type: 'Point',
      coordinates: position
    }
  }

  private readLineString(dimension: number, littleEndian: boolean): Geometry {
    const count = this.readUInt32(littleEndian)
    const coordinates: Position[] = []

    for (let index = 0; index < count; index += 1) {
      coordinates.push(this.readPosition(dimension, littleEndian))
    }

    return {
      type: 'LineString',
      coordinates
    }
  }

  private readPolygon(dimension: number, littleEndian: boolean): Geometry {
    const ringCount = this.readUInt32(littleEndian)
    const coordinates: Position[][] = []

    for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
      const pointCount = this.readUInt32(littleEndian)
      const ring: Position[] = []

      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        ring.push(this.readPosition(dimension, littleEndian))
      }

      coordinates.push(ring)
    }

    return {
      type: 'Polygon',
      coordinates
    }
  }

  private readMultiPoint(dimension: number, littleEndian: boolean): Geometry | null {
    const count = this.readUInt32(littleEndian)
    const coordinates: Position[] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (!geometry) continue

      if (geometry.type !== 'Point') {
        throw new Error('Invalid WKB MultiPoint: expected Point members')
      }

      const position = geometry.coordinates
      if (position.length < dimension) {
        coordinates.push([...position] as Position)
      } else {
        coordinates.push(position)
      }
    }

    return coordinates.length === 0
      ? null
      : {
        type: 'MultiPoint',
        coordinates
      }
  }

  private readMultiLineString(_: number, littleEndian: boolean): Geometry | null {
    const count = this.readUInt32(littleEndian)
    const coordinates: Position[][] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (!geometry) continue

      if (geometry.type !== 'LineString') {
        throw new Error('Invalid WKB MultiLineString: expected LineString members')
      }

      coordinates.push(geometry.coordinates)
    }

    if (coordinates.length === 0) return null

    return {
      type: 'MultiLineString',
      coordinates
    }
  }

  private readMultiPolygon(_: number, littleEndian: boolean): Geometry | null {
    const count = this.readUInt32(littleEndian)
    const coordinates: Position[][][] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (!geometry) continue

      if (geometry.type !== 'Polygon') {
        throw new Error('Invalid WKB MultiPolygon: expected Polygon members')
      }

      coordinates.push(geometry.coordinates)
    }

    if (coordinates.length === 0) return null

    return {
      type: 'MultiPolygon',
      coordinates
    }
  }

  private readGeometryCollection(littleEndian: boolean): Geometry | null {
    const count = this.readUInt32(littleEndian)
    const geometries: Geometry[] = []

    for (let index = 0; index < count; index += 1) {
      const geometry = this.readGeometry()
      if (geometry) geometries.push(geometry)
    }

    if (geometries.length === 0) return null

    if (geometries.every((geometry) => geometry.type === 'Point')) {
      return {
        type: 'MultiPoint',
        coordinates: geometries.map((geometry) => (geometry as { type: 'Point', coordinates: Position }).coordinates)
      }
    }

    if (geometries.every((geometry) => geometry.type === 'LineString')) {
      return {
        type: 'MultiLineString',
        coordinates: geometries.map((geometry) => (geometry as { type: 'LineString', coordinates: Position[] }).coordinates)
      }
    }

    if (geometries.every((geometry) => geometry.type === 'Polygon')) {
      return {
        type: 'MultiPolygon',
        coordinates: geometries.map((geometry) => (geometry as { type: 'Polygon', coordinates: Position[][] }).coordinates)
      }
    }

    return null
  }

  private readPosition(dimension: number, littleEndian: boolean): Position {
    const values: number[] = []

    for (let index = 0; index < dimension; index += 1) {
      values.push(this.readFloat64(littleEndian))
    }

    return values as Position
  }

  private readUInt8(): number {
    if (this.offset + 1 > this.view.byteLength) {
      throw new Error('Invalid WKB: unexpected end of input')
    }

    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  private readUInt32(littleEndian: boolean): number {
    if (this.offset + 4 > this.view.byteLength) {
      throw new Error('Invalid WKB: unexpected end of input')
    }

    const value = this.view.getUint32(this.offset, littleEndian)
    this.offset += 4
    return value
  }

  private readFloat64(littleEndian: boolean): number {
    if (this.offset + 8 > this.view.byteLength) {
      throw new Error('Invalid WKB: unexpected end of input')
    }

    const value = this.view.getFloat64(this.offset, littleEndian)
    this.offset += 8
    return value
  }
}

function decodeWkbType(rawType: number): {
  baseType: number
  dimensions: number
  hasSrid: boolean
} {
  let type = rawType
  let hasZ = false
  let hasM = false
  let hasSrid = false

  if ((type & 0x80000000) !== 0) {
    hasZ = true
    type &= 0x7fffffff
  }

  if ((type & 0x40000000) !== 0) {
    hasM = true
    type &= 0xbfffffff
  }

  if ((type & 0x20000000) !== 0) {
    hasSrid = true
    type &= 0xdfffffff
  }

  if (type >= 3000) {
    type -= 3000
    hasZ = true
    hasM = true
  } else if (type >= 2000) {
    type -= 2000
    hasM = true
  } else if (type >= 1000) {
    type -= 1000
    hasZ = true
  }

  return {
    baseType: type,
    dimensions: 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0),
    hasSrid
  }
}
