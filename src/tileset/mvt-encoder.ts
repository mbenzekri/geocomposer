import type { Feature } from '../core/feature.js'
import type { Geometry, Position } from '../core/geometry.js'
import { closeRing, removeClosingPosition, removeDuplicatePositions, samePosition, signedRingArea } from './vector-tile-geometry.js'

type MvtFeature = {
  id?: string | number
  properties: Feature['properties']
  geometry: Geometry
}

type MvtLayer = {
  name: string
  extent: number
  features: MvtFeature[]
}

type MvtValue = string | number | boolean

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH_DELIMITED = 2

const GEOM_POINT = 1
const GEOM_LINESTRING = 2
const GEOM_POLYGON = 3

const CMD_MOVE_TO = 1
const CMD_LINE_TO = 2
const CMD_CLOSE_PATH = 7

export class MvtEncoder {
  encode(layers: MvtLayer[]): Buffer {
    const tile = new ProtoWriter()

    for (const layer of layers) {
      if (layer.features.length === 0) continue
      tile.writeMessage(3, this.encodeLayer(layer))
    }

    return tile.toBuffer()
  }

  private encodeLayer(layer: MvtLayer): ProtoWriter {
    const writer = new ProtoWriter()
    const keys: string[] = []
    const keyIndex = new Map<string, number>()
    const values: MvtValue[] = []
    const valueIndex = new Map<string, number>()
    const encodedFeatures: ProtoWriter[] = []

    for (const feature of layer.features) {
      const encoded = this.encodeFeature(feature, keyIndex, keys, valueIndex, values)
      if (encoded) encodedFeatures.push(encoded)
    }

    writer.writeString(1, layer.name)
    for (const feature of encodedFeatures) {
      writer.writeMessage(2, feature)
    }
    for (const key of keys) {
      writer.writeString(3, key)
    }
    for (const value of values) {
      writer.writeMessage(4, encodeValue(value))
    }
    writer.writeVarintField(5, layer.extent)
    writer.writeVarintField(15, 2)

    return writer
  }

  private encodeFeature(
    feature: MvtFeature,
    keyIndex: Map<string, number>,
    keys: string[],
    valueIndex: Map<string, number>,
    values: MvtValue[]
  ): ProtoWriter | null {
    const geometry = encodeGeometry(feature.geometry)
    if (!geometry) return null

    const writer = new ProtoWriter()
    const id = numericId(feature.id)
    if (id !== undefined) writer.writeVarintField(1, id)

    const tags = this.encodeTags(feature.properties, keyIndex, keys, valueIndex, values)
    if (tags.length > 0) writer.writePackedVarints(2, tags)

    writer.writeVarintField(3, geometry.type)
    writer.writePackedVarints(4, geometry.commands)
    return writer
  }

  private encodeTags(
    properties: Feature['properties'],
    keyIndex: Map<string, number>,
    keys: string[],
    valueIndex: Map<string, number>,
    values: MvtValue[]
  ): number[] {
    const tags: number[] = []
    if (!properties) return tags

    for (const [key, rawValue] of Object.entries(properties)) {
      const value = normalizeValue(rawValue)
      if (value === undefined) continue

      const keyId = internKey(key, keyIndex, keys)
      const valueId = internValue(value, valueIndex, values)
      tags.push(keyId, valueId)
    }

    return tags
  }
}

function encodeGeometry(geometry: Geometry): { type: number, commands: number[] } | null {
  switch (geometry.type) {
    case 'Point':
      return {
        type: GEOM_POINT,
        commands: encodePoints([geometry.coordinates])
      }

    case 'MultiPoint':
      return {
        type: GEOM_POINT,
        commands: encodePoints(geometry.coordinates)
      }

    case 'LineString': {
      const commands = encodeLines([geometry.coordinates])
      return commands.length > 0 ? { type: GEOM_LINESTRING, commands } : null
    }

    case 'MultiLineString': {
      const commands = encodeLines(geometry.coordinates)
      return commands.length > 0 ? { type: GEOM_LINESTRING, commands } : null
    }

    case 'Polygon': {
      const commands = encodePolygons([geometry.coordinates])
      return commands.length > 0 ? { type: GEOM_POLYGON, commands } : null
    }

    case 'MultiPolygon': {
      const commands = encodePolygons(geometry.coordinates)
      return commands.length > 0 ? { type: GEOM_POLYGON, commands } : null
    }
  }
}

function encodePoints(points: Position[]): number[] {
  const rounded = points.map((point) => roundPosition(point))
  if (rounded.length === 0) return []

  const commands = [command(CMD_MOVE_TO, rounded.length)]
  let cursor: Position = [0, 0]

  for (const point of rounded) {
    commands.push(...delta(cursor, point))
    cursor = point
  }

  return commands
}

function encodeLines(lines: Position[][]): number[] {
  const commands: number[] = []
  let cursor: Position = [0, 0]

  for (const line of lines) {
    const rounded = removeDuplicatePositions(line.map((point) => roundPosition(point)))
    if (rounded.length < 2) continue

    commands.push(command(CMD_MOVE_TO, 1), ...delta(cursor, rounded[0]))
    cursor = rounded[0]
    commands.push(command(CMD_LINE_TO, rounded.length - 1))

    for (const point of rounded.slice(1)) {
      commands.push(...delta(cursor, point))
      cursor = point
    }
  }

  return commands
}

function encodePolygons(polygons: Position[][][]): number[] {
  const commands: number[] = []
  let cursor: Position = [0, 0]

  for (const polygon of polygons) {
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
      const clockwise = ringIndex === 0
      const rounded = orientRing(
        closeRing(removeDuplicatePositions(polygon[ringIndex].map((point) => roundPosition(point)))),
        clockwise
      )
      const open = removeClosingPosition(rounded)
      if (open.length < 3) continue

      commands.push(command(CMD_MOVE_TO, 1), ...delta(cursor, open[0]))
      cursor = open[0]
      commands.push(command(CMD_LINE_TO, open.length - 1))

      for (const point of open.slice(1)) {
        commands.push(...delta(cursor, point))
        cursor = point
      }

      commands.push(command(CMD_CLOSE_PATH, 1))
    }
  }

  return commands
}

function orientRing(ring: Position[], clockwise: boolean): Position[] {
  const area = signedRingArea(ring)
  const isClockwise = area > 0

  if (isClockwise === clockwise) return ring
  const open = removeClosingPosition(ring).reverse()
  return closeRing(open)
}

function roundPosition(position: Position): Position {
  return [Math.round(position[0]), Math.round(position[1])]
}

function command(id: number, count: number): number {
  return (count << 3) | id
}

function delta(previous: Position, next: Position): number[] {
  return [
    zigZag(next[0] - previous[0]),
    zigZag(next[1] - previous[1])
  ]
}

function zigZag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2
}

function numericId(id: string | number | undefined): number | undefined {
  if (typeof id !== 'number') return undefined
  if (!Number.isSafeInteger(id) || id < 0) return undefined
  return id
}

function normalizeValue(value: unknown): MvtValue | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined

  return JSON.stringify(value)
}

function internKey(key: string, keyIndex: Map<string, number>, keys: string[]): number {
  const existing = keyIndex.get(key)
  if (existing !== undefined) return existing

  const next = keys.length
  keys.push(key)
  keyIndex.set(key, next)
  return next
}

function internValue(value: MvtValue, valueIndex: Map<string, number>, values: MvtValue[]): number {
  const key = `${typeof value}:${String(value)}`
  const existing = valueIndex.get(key)
  if (existing !== undefined) return existing

  const next = values.length
  values.push(value)
  valueIndex.set(key, next)
  return next
}

function encodeValue(value: MvtValue): ProtoWriter {
  const writer = new ProtoWriter()

  if (typeof value === 'string') {
    writer.writeString(1, value)
  } else if (typeof value === 'boolean') {
    writer.writeVarintField(7, value ? 1 : 0)
  } else if (Number.isInteger(value)) {
    if (value < 0) {
      writer.writeVarintField(6, zigZag(value))
    } else {
      writer.writeVarintField(5, value)
    }
  } else {
    writer.writeDoubleField(3, value)
  }

  return writer
}

class ProtoWriter {
  private readonly chunks: number[] = []

  writeVarintField(field: number, value: number | bigint): void {
    this.writeTag(field, WIRE_VARINT)
    this.writeVarint(value)
  }

  writeDoubleField(field: number, value: number): void {
    this.writeTag(field, WIRE_FIXED64)
    const buffer = Buffer.allocUnsafe(8)
    buffer.writeDoubleLE(value, 0)
    this.writeBytes(buffer)
  }

  writeString(field: number, value: string): void {
    this.writeBytesField(field, Buffer.from(value, 'utf8'))
  }

  writeMessage(field: number, value: ProtoWriter): void {
    this.writeBytesField(field, value.toBuffer())
  }

  writePackedVarints(field: number, values: number[]): void {
    const packed = new ProtoWriter()
    for (const value of values) {
      packed.writeVarint(value)
    }
    this.writeBytesField(field, packed.toBuffer())
  }

  toBuffer(): Buffer {
    return Buffer.from(this.chunks)
  }

  private writeBytesField(field: number, bytes: Buffer): void {
    this.writeTag(field, WIRE_LENGTH_DELIMITED)
    this.writeVarint(bytes.length)
    this.writeBytes(bytes)
  }

  private writeTag(field: number, wireType: number): void {
    this.writeVarint((field << 3) | wireType)
  }

  private writeVarint(value: number | bigint): void {
    let next = typeof value === 'bigint' ? value : BigInt(value)
    if (next < 0n) {
      throw new Error('Cannot encode negative protobuf varint')
    }

    while (next >= 0x80n) {
      this.chunks.push(Number((next & 0x7fn) | 0x80n))
      next >>= 7n
    }

    this.chunks.push(Number(next))
  }

  private writeBytes(bytes: Buffer): void {
    this.chunks.push(...bytes)
  }
}
