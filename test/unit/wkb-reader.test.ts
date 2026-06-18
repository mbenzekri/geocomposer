import { describe, expect, it } from 'vitest'
import * as wkx from 'wkx'
import { WkbReader } from '../../src/source/wkb-reader.js'

function toWkb(geometry: GeoJSON.Geometry): Buffer {
    return wkx.Geometry.parseGeoJSON(geometry).toWkb()
}

function toEwkb(wkt: string): Buffer {
    return wkx.Geometry.parse(wkt).toEwkb()
}

function read(buffer: Uint8Array) {
    const reader = new WkbReader(buffer)
    const geometry = reader.readGeometry()

    return {
        geometry,
        eof: reader.eof
    }
}

function invalidTypedWkb(type: number): Buffer {
    const buffer = Buffer.alloc(5)

    buffer.writeUInt8(1, 0)
    buffer.writeUInt32LE(type, 1)

    return buffer
}

function collection(...geometries: Buffer[]): Buffer {
    return Buffer.concat([
        invalidTypedWkb(7),
        uint32le(geometries.length),
        ...geometries
    ])
}

function multi(type: number, ...geometries: Buffer[]): Buffer {
    return Buffer.concat([
        invalidTypedWkb(type),
        uint32le(geometries.length),
        ...geometries
    ])
}

function uint32le(value: number): Buffer {
    const buffer = Buffer.alloc(4)

    buffer.writeUInt32LE(value, 0)

    return buffer
}

describe('WkbReader', () => {
    it('reads Point', () => {
        expect(read(toWkb({
            type: 'Point',
            coordinates: [2, 48]
        }))).toEqual({
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            },
            eof: true
        })
    })

    it('reads LineString', () => {
        expect(read(toWkb({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [1, 1]
            ]
        }))).toEqual({
            geometry: {
                type: 'LineString',
                coordinates: [
                    [0, 0],
                    [1, 1]
                ]
            },
            eof: true
        })
    })

    it('reads Polygon', () => {
        expect(read(toWkb({
            type: 'Polygon',
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0]
                ]
            ]
        }))).toEqual({
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                        [0, 0]
                    ]
                ]
            },
            eof: true
        })
    })

    it('reads MultiPoint', () => {
        expect(read(toWkb({
            type: 'MultiPoint',
            coordinates: [
                [1, 2],
                [3, 4]
            ]
        }))).toEqual({
            geometry: {
                type: 'MultiPoint',
                coordinates: [
                    [1, 2],
                    [3, 4]
                ]
            },
            eof: true
        })
    })

    it('reads MultiLineString', () => {
        expect(read(toWkb({
            type: 'MultiLineString',
            coordinates: [
                [
                    [0, 0],
                    [1, 1]
                ],
                [
                    [2, 2],
                    [3, 3]
                ]
            ]
        }))).toEqual({
            geometry: {
                type: 'MultiLineString',
                coordinates: [
                    [
                        [0, 0],
                        [1, 1]
                    ],
                    [
                        [2, 2],
                        [3, 3]
                    ]
                ]
            },
            eof: true
        })
    })

    it('reads MultiPolygon', () => {
        expect(read(toWkb({
            type: 'MultiPolygon',
            coordinates: [
                [
                    [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                        [0, 0]
                    ]
                ],
                [
                    [
                        [2, 2],
                        [3, 2],
                        [3, 3],
                        [2, 2]
                    ]
                ]
            ]
        }))).toEqual({
            geometry: {
                type: 'MultiPolygon',
                coordinates: [
                    [
                        [
                            [0, 0],
                            [1, 0],
                            [1, 1],
                            [0, 0]
                        ]
                    ],
                    [
                        [
                            [2, 2],
                            [3, 2],
                            [3, 3],
                            [2, 2]
                        ]
                    ]
                ]
            },
            eof: true
        })
    })

    it('converts a GeometryCollection of points to MultiPoint', () => {
        expect(read(toWkb({
            type: 'GeometryCollection',
            geometries: [
                {
                    type: 'Point',
                    coordinates: [1, 2]
                },
                {
                    type: 'Point',
                    coordinates: [3, 4]
                }
            ]
        }))).toEqual({
            geometry: {
                type: 'MultiPoint',
                coordinates: [
                    [1, 2],
                    [3, 4]
                ]
            },
            eof: true
        })
    })

    it('converts a GeometryCollection of lines to MultiLineString', () => {
        expect(read(toWkb({
            type: 'GeometryCollection',
            geometries: [
                {
                    type: 'LineString',
                    coordinates: [[0, 0], [1, 1]]
                },
                {
                    type: 'LineString',
                    coordinates: [[2, 2], [3, 3]]
                }
            ]
        }))).toEqual({
            geometry: {
                type: 'MultiLineString',
                coordinates: [
                    [[0, 0], [1, 1]],
                    [[2, 2], [3, 3]]
                ]
            },
            eof: true
        })
    })

    it('converts a GeometryCollection of polygons to MultiPolygon', () => {
        expect(read(toWkb({
            type: 'GeometryCollection',
            geometries: [
                {
                    type: 'Polygon',
                    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
                },
                {
                    type: 'Polygon',
                    coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]]
                }
            ]
        }))).toEqual({
            geometry: {
                type: 'MultiPolygon',
                coordinates: [
                    [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                    [[[2, 2], [3, 2], [3, 3], [2, 2]]]
                ]
            },
            eof: true
        })
    })

    it('returns null for a mixed GeometryCollection', () => {
        expect(read(toWkb({
            type: 'GeometryCollection',
            geometries: [
                {
                    type: 'Point',
                    coordinates: [1, 2]
                },
                {
                    type: 'LineString',
                    coordinates: [[0, 0], [1, 1]]
                }
            ]
        }))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('returns null for an empty GeometryCollection', () => {
        expect(read(toWkb({
            type: 'GeometryCollection',
            geometries: []
        }))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('reads EWKB with SRID', () => {
        expect(read(toEwkb('SRID=4326;POINT(2 48)'))).toEqual({
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            },
            eof: true
        })
    })

    it('reads EWKB PointZ', () => {
        expect(read(toEwkb('POINT Z (2 48 99)'))).toEqual({
            geometry: {
                type: 'Point',
                coordinates: [2, 48, 99]
            },
            eof: true
        })
    })

    it('reads EWKB PointZM', () => {
        expect(read(toEwkb('POINT ZM (2 48 99 7)'))).toEqual({
            geometry: {
                type: 'Point',
                coordinates: [2, 48, 99, 7]
            },
            eof: true
        })
    })

    it('returns null for NaN point coordinates', () => {
        expect(read(toWkb({
            type: 'Point',
            coordinates: [Number.NaN, 48]
        }))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('returns null for WKB null geometry type', () => {
        expect(read(invalidTypedWkb(0))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('returns null for MultiPoint with only null point members', () => {
        expect(read(multi(4, invalidTypedWkb(0)))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('returns null for MultiLineString with only null members', () => {
        expect(read(multi(5, invalidTypedWkb(0)))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('returns null for MultiPolygon with only null members', () => {
        expect(read(multi(6, invalidTypedWkb(0)))).toEqual({
            geometry: null,
            eof: true
        })
    })

    it('throws when MultiPoint contains a non point member', () => {
        expect(() =>
            read(multi(
                4,
                toWkb({
                    type: 'LineString',
                    coordinates: [[0, 0], [1, 1]]
                })
            ))
        ).toThrow('Invalid WKB MultiPoint: expected Point members')
    })

    it('throws when MultiLineString contains a non line member', () => {
        expect(() =>
            read(multi(
                5,
                toWkb({
                    type: 'Point',
                    coordinates: [1, 2]
                })
            ))
        ).toThrow('Invalid WKB MultiLineString: expected LineString members')
    })

    it('throws when MultiPolygon contains a non polygon member', () => {
        expect(() =>
            read(multi(
                6,
                toWkb({
                    type: 'Point',
                    coordinates: [1, 2]
                })
            ))
        ).toThrow('Invalid WKB MultiPolygon: expected Polygon members')
    })

    it('throws on unsupported WKB geometry type', () => {
        expect(() =>
            read(invalidTypedWkb(999))
        ).toThrow('Unsupported WKB geometry type: 999')
    })

    it('throws on unexpected end while reading endian flag', () => {
        expect(() =>
            read(Buffer.alloc(0))
        ).toThrow('Invalid WKB: unexpected end of input')
    })

    it('throws on unexpected end while reading geometry type', () => {
        expect(() =>
            read(Buffer.from([1]))
        ).toThrow('Invalid WKB: unexpected end of input')
    })

    it('throws on unexpected end while reading coordinates', () => {
        expect(() =>
            read(invalidTypedWkb(1))
        ).toThrow('Invalid WKB: unexpected end of input')
    })

    it('leaves eof false when trailing bytes exist', () => {
        const reader = new WkbReader(Buffer.concat([
            toWkb({
                type: 'Point',
                coordinates: [1, 2]
            }),
            Buffer.from([0xff])
        ]))

        expect(reader.readGeometry()).toEqual({
            type: 'Point',
            coordinates: [1, 2]
        })
        expect(reader.eof).toBe(false)
    })

    it('reads a manual GeometryCollection containing only null geometries as null', () => {
        expect(read(collection(
            invalidTypedWkb(0),
            invalidTypedWkb(0)
        ))).toEqual({
            geometry: null,
            eof: true
        })
    })
})