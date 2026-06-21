import { describe, expect, it } from 'vitest'
import { MvtEncoder } from '../../src/tileset/mvt-encoder.js'

type Field = {
  field: number
  wireType: number
  value: number | string | Buffer | bigint
}

type DecodedValue = string | number | boolean

type DecodedFeature = {
  id?: number
  tags: number[]
  type?: number
  geometry: number[]
}

type DecodedLayer = {
  name?: string
  features: DecodedFeature[]
  keys: string[]
  values: DecodedValue[]
  extent?: number
  version?: number
}

const encoder = new MvtEncoder()

function readVarint(buffer: Buffer, offset: number): { value: bigint, offset: number } {
  let result = 0n
  let shift = 0n
  let cursor = offset

  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    cursor += 1
    result |= BigInt(byte & 0x7f) << shift

    if ((byte & 0x80) === 0) return { value: result, offset: cursor }
    shift += 7n
  }

  throw new Error('Unterminated varint')
}

function decodeMessage(buffer: Buffer): Field[] {
  const fields: Field[] = []
  let offset = 0

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset)
    offset = tag.offset

    const field = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 0x7n)

    if (wireType === 0) {
      const decoded = readVarint(buffer, offset)
      offset = decoded.offset
      fields.push({ field, wireType, value: decoded.value })
    } else if (wireType === 1) {
      const bytes = buffer.subarray(offset, offset + 8)
      offset += 8
      fields.push({ field, wireType, value: bytes })
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset)
      offset = length.offset
      const bytes = buffer.subarray(offset, offset + Number(length.value))
      offset += Number(length.value)
      fields.push({ field, wireType, value: bytes })
    } else {
      throw new Error(`Unsupported wire type ${wireType}`)
    }
  }

  return fields
}

function varints(bytes: Buffer): number[] {
  const values: number[] = []
  let offset = 0

  while (offset < bytes.length) {
    const decoded = readVarint(bytes, offset)
    values.push(Number(decoded.value))
    offset = decoded.offset
  }

  return values
}

function stringValue(value: Field['value']): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function decodeMvtValue(bytes: Buffer): DecodedValue {
  const fields = decodeMessage(bytes)
  const value = fields[0]

  if (value.field === 1 && Buffer.isBuffer(value.value)) return value.value.toString('utf8')
  if (value.field === 3 && Buffer.isBuffer(value.value)) return value.value.readDoubleLE(0)
  if (value.field === 5) return Number(value.value)
  if (value.field === 6) {
    const raw = Number(value.value)
    return (raw >>> 1) ^ -(raw & 1)
  }
  if (value.field === 7) return Number(value.value) === 1

  throw new Error(`Unsupported value field ${value.field}`)
}

function decodeFeature(bytes: Buffer): DecodedFeature {
  const decoded: DecodedFeature = { tags: [], geometry: [] }

  for (const field of decodeMessage(bytes)) {
    if (field.field === 1) decoded.id = Number(field.value)
    if (field.field === 2 && Buffer.isBuffer(field.value)) decoded.tags = varints(field.value)
    if (field.field === 3) decoded.type = Number(field.value)
    if (field.field === 4 && Buffer.isBuffer(field.value)) decoded.geometry = varints(field.value)
  }

  return decoded
}

function decodeTile(buffer: Buffer): DecodedLayer[] {
  return decodeMessage(buffer)
    .filter((field) => field.field === 3 && Buffer.isBuffer(field.value))
    .map((layerField) => {
      const layer: DecodedLayer = {
        features: [],
        keys: [],
        values: []
      }

      for (const field of decodeMessage(layerField.value as Buffer)) {
        if (field.field === 1) layer.name = stringValue(field.value)
        if (field.field === 2 && Buffer.isBuffer(field.value)) layer.features.push(decodeFeature(field.value))
        if (field.field === 3) layer.keys.push(stringValue(field.value))
        if (field.field === 4 && Buffer.isBuffer(field.value)) layer.values.push(decodeMvtValue(field.value))
        if (field.field === 5) layer.extent = Number(field.value)
        if (field.field === 15) layer.version = Number(field.value)
      }

      return layer
    })
}

describe('MvtEncoder', () => {
  it('skips empty layers', () => {
    expect(encoder.encode([])).toEqual(Buffer.alloc(0))
    expect(encoder.encode([{ name: 'empty', extent: 4096, features: [] }])).toEqual(Buffer.alloc(0))
  })

  it('encodes feature ids, tags, scalar values and point geometries without mocks', () => {
    const tile = decodeTile(encoder.encode([
      {
        name: 'places',
        extent: 4096,
        features: [
          {
            id: 7,
            properties: {
              name: 'A',
              visible: true,
              count: 3,
              debt: -2,
              ratio: 1.5,
              object: { nested: 'value' },
              skippedNull: null,
              skippedUndefined: undefined,
              skippedNaN: Number.NaN,
              skippedInfinity: Number.POSITIVE_INFINITY
            },
            geometry: { type: 'Point', coordinates: [1.4, -2.6] }
          },
          {
            id: 'ignored',
            properties: {
              name: 'A',
              visible: false,
              count: 3
            },
            geometry: { type: 'MultiPoint', coordinates: [[1, 1], [3, 2]] }
          }
        ]
      }
    ] as any))

    expect(tile).toHaveLength(1)
    expect(tile[0]).toMatchObject({ name: 'places', extent: 4096, version: 2 })
    expect(tile[0].keys).toEqual(['name', 'visible', 'count', 'debt', 'ratio', 'object'])
    expect(tile[0].values).toEqual(['A', true, 3, -2, 1.5, '{"nested":"value"}', false])
    expect(tile[0].features[0]).toEqual({
      id: 7,
      tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
      type: 1,
      geometry: [9, 2, 5]
    })
    expect(tile[0].features[1]).toEqual({
      tags: [0, 0, 1, 6, 2, 2],
      type: 1,
      geometry: [17, 2, 2, 4, 2]
    })
  })

  it('encodes lines, removes duplicate positions and skips degenerate line features', () => {
    const tile = decodeTile(encoder.encode([
      {
        name: 'roads',
        extent: 256,
        features: [
          {
            id: -1,
            properties: undefined,
            geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0], [2, 0], [2, -1]] }
          },
          {
            id: Number.MAX_SAFE_INTEGER + 1,
            properties: { ignored: 'degenerate' },
            geometry: { type: 'LineString', coordinates: [[5, 5], [5, 5]] }
          },
          {
            properties: {},
            geometry: { type: 'MultiLineString', coordinates: [[[10, 10], [11, 10]], [[11, 10]], [[11, 10], [9, 9]]] }
          }
        ]
      }
    ] as any))

    expect(tile[0].features).toHaveLength(2)
    expect(tile[0].keys).toEqual([])
    expect(tile[0].values).toEqual([])
    expect(tile[0].features[0]).toEqual({
      tags: [],
      type: 2,
      geometry: [9, 0, 0, 18, 4, 0, 0, 1]
    })
    expect(tile[0].features[1]).toEqual({
      tags: [],
      type: 2,
      geometry: [9, 20, 20, 10, 2, 0, 9, 0, 0, 10, 3, 1]
    })
  })

  it('encodes polygons, multipolygons and skips degenerate rings', () => {
    const tile = decodeTile(encoder.encode([
      {
        name: 'areas',
        extent: 1024,
        features: [
          {
            properties: { kind: 'polygon' },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
                [[1, 1], [1, 2], [2, 2], [1, 1]],
                [[8, 8], [8, 8]]
              ]
            }
          },
          {
            properties: { kind: 'multi' },
            geometry: {
              type: 'MultiPolygon',
              coordinates: [
                [[[10, 10], [10, 13], [13, 13], [13, 10], [10, 10]]],
                [[[20, 20], [22, 20], [21, 22], [20, 20]]]
              ]
            }
          },
          {
            properties: { ignored: true },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [1, 1]]] }
          },
          {
            properties: { ignored: true },
            geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [0, 0]]]] }
          }
        ]
      }
    ] as any))

    expect(tile[0].features).toHaveLength(2)
    expect(tile[0].keys).toEqual(['kind'])
    expect(tile[0].values).toEqual(['polygon', 'multi'])
    expect(tile[0].features[0].type).toBe(3)
    expect(tile[0].features[0].geometry).toEqual([
      9, 0, 0, 26, 8, 0, 0, 8, 7, 0, 15,
      9, 2, 5, 18, 0, 2, 2, 0, 15
    ])
    expect(tile[0].features[1].type).toBe(3)
    expect(tile[0].features[1].geometry).toEqual([
      9, 26, 20, 26, 0, 6, 5, 0, 0, 5, 15,
      9, 20, 20, 18, 4, 0, 1, 4, 15
    ])
  })
})
