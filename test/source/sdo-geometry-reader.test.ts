import { describe, expect, it } from 'vitest'
import { SdoGeometryReader } from '../../src/source/sdo-geometry-reader.js'

const reader = new SdoGeometryReader()

function sdo(
    gtype: number,
    elemInfo: unknown = [],
    ordinates: unknown = [],
    point: unknown = null
) {
    return {
        SDO_GTYPE: gtype,
        SDO_POINT: point,
        SDO_ELEM_INFO: elemInfo,
        SDO_ORDINATES: ordinates
    }
}

function collection(values: unknown[]) {
    return {
        getValues() {
            return values
        }
    }
}

describe('SdoGeometryReader', () => {
    it('returns null for nullish values', () => {
        expect(reader.readGeometry(null)).toBeNull()
        expect(reader.readGeometry(undefined)).toBeNull()
    })

    it('reads a point from SDO_POINT', () => {
        expect(reader.readGeometry(sdo(2001, [], [], {
            X: 2,
            Y: 48
        }))).toEqual({
            type: 'Point',
            coordinates: [2, 48]
        })
    })

    it('reads a 3D point from SDO_POINT', () => {
        expect(reader.readGeometry(sdo(3001, [], [], {
            X: 2,
            Y: 48,
            Z: 99
        }))).toEqual({
            type: 'Point',
            coordinates: [2, 48, 99]
        })
    })

    it('reads a point from ordinates when SDO_POINT is absent', () => {
        expect(reader.readGeometry(sdo(2001, [1, 1, 1], [2, 48]))).toEqual({
            type: 'Point',
            coordinates: [2, 48]
        })
    })

    it('returns null for point without SDO_POINT and ordinates', () => {
        expect(reader.readGeometry(sdo(2001))).toBeNull()
    })

    it('reads a multipoint from point elements', () => {
        expect(reader.readGeometry(sdo(
            2005,
            [1, 1, 2],
            [2, 48, 4, 45]
        ))).toEqual({
            type: 'MultiPoint',
            coordinates: [
                [2, 48],
                [4, 45]
            ]
        })
    })

    it('reads a multipoint from SDO_POINT fallback', () => {
        expect(reader.readGeometry(sdo(2005, [], [], {
            X: 2,
            Y: 48
        }))).toEqual({
            type: 'MultiPoint',
            coordinates: [[2, 48]]
        })
    })

    it('returns null for empty multipoint', () => {
        expect(reader.readGeometry(sdo(2005))).toBeNull()
    })

    it('reads a linestring', () => {
        expect(reader.readGeometry(sdo(
            2002,
            [1, 2, 1],
            [0, 0, 1, 1, 2, 2]
        ))).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [1, 1],
                [2, 2]
            ]
        })
    })

    it('reads a line geometry with multiple line elements as MultiLineString', () => {
        expect(reader.readGeometry(sdo(
            2002,
            [1, 2, 1, 5, 2, 1],
            [0, 0, 1, 1, 10, 10, 20, 20]
        ))).toEqual({
            type: 'MultiLineString',
            coordinates: [
                [[0, 0], [1, 1]],
                [[10, 10], [20, 20]]
            ]
        })
    })

    it('reads a multilinestring', () => {
        expect(reader.readGeometry(sdo(
            2006,
            [1, 2, 1, 5, 2, 1],
            [0, 0, 1, 1, 10, 10, 20, 20]
        ))).toEqual({
            type: 'MultiLineString',
            coordinates: [
                [[0, 0], [1, 1]],
                [[10, 10], [20, 20]]
            ]
        })
    })

    it('returns null for empty linestring and multilinestring', () => {
        expect(reader.readGeometry(sdo(2002))).toBeNull()
        expect(reader.readGeometry(sdo(2006))).toBeNull()
    })

    it('reads a polygon and closes an open ring', () => {
        expect(reader.readGeometry(sdo(
            2003,
            [1, 1003, 1],
            [0, 0, 10, 0, 10, 10, 0, 10]
        ))).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
            ]
        })
    })

    it('keeps an already closed polygon ring unchanged', () => {
        expect(reader.readGeometry(sdo(
            2003,
            [1, 1003, 1],
            [0, 0, 10, 0, 10, 10, 0, 0]
        ))).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 0]]
            ]
        })
    })

    it('reads a polygon with an interior ring', () => {
        expect(reader.readGeometry(sdo(
            2003,
            [1, 1003, 1, 11, 2003, 1],
            [
                0, 0, 10, 0, 10, 10, 0, 10, 0, 0,
                2, 2, 4, 2, 4, 4, 2, 2
            ]
        ))).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
                [[2, 2], [4, 2], [4, 4], [2, 2]]
            ]
        })
    })

    it('reads an old-style polygon with etype 3 rings', () => {
        expect(reader.readGeometry(sdo(
            2003,
            [1, 3, 1, 11, 3, 1],
            [
                0, 0, 10, 0, 10, 10, 0, 10, 0, 0,
                2, 2, 4, 2, 4, 4, 2, 2
            ]
        ))).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
                [[2, 2], [4, 2], [4, 4], [2, 2]]
            ]
        })
    })

    it('reads an Oracle rectangle polygon interpretation', () => {
        expect(reader.readGeometry(sdo(
            2003,
            [1, 1003, 3],
            [10, 20, 0, 5]
        ))).toEqual({
            type: 'Polygon',
            coordinates: [
                [[0, 5], [10, 5], [10, 20], [0, 20], [0, 5]]
            ]
        })
    })

    it('reads a polygon geometry with multiple exterior rings as MultiPolygon', () => {
        expect(reader.readGeometry(sdo(
            2003,
            [1, 1003, 1, 9, 1003, 1],
            [
                0, 0, 1, 0, 1, 1, 0, 0,
                10, 10, 11, 10, 11, 11, 10, 10
            ]
        ))).toEqual({
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                [[[10, 10], [11, 10], [11, 11], [10, 10]]]
            ]
        })
    })

    it('reads a multipolygon', () => {
        expect(reader.readGeometry(sdo(
            2007,
            [1, 1003, 1, 9, 1003, 1],
            [
                0, 0, 1, 0, 1, 1, 0, 0,
                10, 10, 11, 10, 11, 11, 10, 10
            ]
        ))).toEqual({
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                [[[10, 10], [11, 10], [11, 11], [10, 10]]]
            ]
        })
    })

    it('returns null for empty polygon and multipolygon', () => {
        expect(reader.readGeometry(sdo(2003))).toBeNull()
        expect(reader.readGeometry(sdo(2007))).toBeNull()
    })

    it('reads homogeneous collections as multi geometries', () => {
        expect(reader.readGeometry(sdo(
            2004,
            [1, 1, 2],
            [2, 48, 4, 45]
        ))).toEqual({
            type: 'MultiPoint',
            coordinates: [[2, 48], [4, 45]]
        })

        expect(reader.readGeometry(sdo(
            2004,
            [1, 2, 1],
            [0, 0, 1, 1]
        ))).toEqual({
            type: 'MultiLineString',
            coordinates: [[[0, 0], [1, 1]]]
        })

        expect(reader.readGeometry(sdo(
            2004,
            [1, 1003, 1],
            [0, 0, 1, 0, 1, 1, 0, 0]
        ))).toEqual({
            type: 'MultiPolygon',
            coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]]
        })
    })

    it('returns null for mixed or empty collection', () => {
        expect(reader.readGeometry(sdo(
            2004,
            [1, 1, 1, 3, 2, 1],
            [2, 48, 0, 0, 1, 1]
        ))).toBeNull()

        expect(reader.readGeometry(sdo(2004))).toBeNull()
    })

    it('supports lowercase fields, string numbers, bigint numbers and collection wrappers', () => {
        expect(reader.readGeometry({
            sdo_gtype: '2002',
            sdo_point: null,
            sdo_elem_info: collection([1n, '2', 1]),
            sdo_ordinates: new Set(['0', 0n, '1', 1n])
        })).toEqual({
            type: 'LineString',
            coordinates: [[0, 0], [1, 1]]
        })
    })

    it('supports toJSON wrappers for fields and collections', () => {
        const value = {
            toJSON() {
                return sdo(
                    2001,
                    [],
                    [],
                    {
                        toJSON() {
                            return {
                                X: '2',
                                Y: '48'
                            }
                        }
                    }
                )
            }
        }

        expect(reader.readGeometry(value)).toEqual({
            type: 'Point',
            coordinates: [2, 48]
        })
    })

    it('throws on unsupported SDO geometry type', () => {
        expect(() => reader.readGeometry(sdo(2009))).toThrow(
            'Unsupported Oracle SDO_GEOMETRY type: 2009'
        )
    })

    it('throws on invalid SDO_GTYPE dimension', () => {
        expect(() => reader.readGeometry(sdo(101))).toThrow(
            'Invalid Oracle SDO_GEOMETRY dimension in SDO_GTYPE: 101'
        )
    })

    it('throws when SDO_GTYPE is missing, non numeric or non integer', () => {
        expect(() => reader.readGeometry({})).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_GTYPE must be numeric'
        )

        expect(() => reader.readGeometry({
            SDO_GTYPE: 'abc'
        })).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_GTYPE must be numeric'
        )

        expect(() => reader.readGeometry({
            SDO_GTYPE: 2001.5
        })).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_GTYPE must be an integer'
        )
    })

    it('throws when numeric collections are invalid', () => {
        expect(() => reader.readGeometry(sdo(2001, 'invalid', []))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_ELEM_INFO must be numeric'
        )

        expect(() => reader.readGeometry(sdo(2001, [], 'invalid'))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_ORDINATES must be numeric'
        )

        expect(() => reader.readGeometry(sdo(2001, [], {}))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_ORDINATES is not a numeric collection'
        )
    })
    
    it('throws when SDO_ELEM_INFO length is invalid', () => {
        expect(() => reader.readGeometry(sdo(2001, [1, 1], []))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_ELEM_INFO length must be divisible by 3'
        )
    })

    it('throws when SDO_ELEM_INFO offset is invalid', () => {
        expect(() => reader.readGeometry(sdo(2001, [0, 1, 1], [2, 48]))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_ELEM_INFO offset must be one-based'
        )

        expect(() => reader.readGeometry(sdo(2001, [1.5, 1, 1], [2, 48]))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: SDO_ELEM_INFO offset must be one-based'
        )
    })

    it('throws when ordinate offset is out of range', () => {
        expect(() => reader.readGeometry(sdo(2001, [10, 1, 1], [2, 48]))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: ordinate offset is out of range'
        )
    })
    it('throws when ordinate offset is out of range for an incomplete point', () => {
        expect(() => reader.readGeometry(sdo(3001, [1, 1, 1], [2]))).toThrow(
            'Invalid Oracle SDO_GEOMETRY: ordinate offset is out of range'
        )
    })
    it('throws on unsupported point, line and polygon element types', () => {
        expect(() => reader.readGeometry(sdo(2005, [1, 2, 1], [0, 0]))).toThrow(
            'Unsupported Oracle SDO point element type: 2'
        )

        expect(() => reader.readGeometry(sdo(2002, [1, 1, 1], [0, 0]))).toThrow(
            'Unsupported Oracle SDO line element type: 1'
        )

        expect(() => reader.readGeometry(sdo(2003, [1, 2, 1], [0, 0]))).toThrow(
            'Unsupported Oracle SDO polygon element type: 2'
        )
    })

    it('throws on unsupported line and polygon interpretations', () => {
        expect(() => reader.readGeometry(sdo(2002, [1, 2, 2], [0, 0, 1, 1]))).toThrow(
            'Unsupported Oracle SDO line interpretation: 2'
        )

        expect(() => reader.readGeometry(sdo(2003, [1, 1003, 2], [0, 0, 1, 1]))).toThrow(
            'Unsupported Oracle SDO polygon interpretation: 2'
        )
    })

    it('throws when rectangle has fewer than two positions', () => {
        expect(() => reader.readGeometry(sdo(2003, [1, 1003, 3], [0, 0]))).toThrow(
            'Invalid Oracle SDO rectangle: expected two positions'
        )
    })
})