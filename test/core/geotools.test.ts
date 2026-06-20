import { describe, expect, it } from 'vitest'
import { Gt } from '../../src/core/geotools.js'
import type { BBox, Geometry, HitContext, Position } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import { Feature } from '../../src/core/feature.js'
const layer = new class { } as Layer

function expectPositionClose(actual: Position, expected: Position, precision = 6): void {
    expect(actual).toHaveLength(expected.length)
    for (let index = 0; index < expected.length; index += 1) {
        expect(actual[index]).toBeCloseTo(expected[index], precision)
    }
}

function expectBBoxClose(actual: BBox, expected: BBox, precision = 6): void {
    expectPositionClose(actual, expected, precision)
}

function expectCoordinatesClose(actual: unknown, expected: unknown, precision = 6): void {
    expect(Array.isArray(actual)).toBe(true)
    expect(Array.isArray(expected)).toBe(true)

    const actualItems = actual as unknown[]
    const expectedItems = expected as unknown[]
    expect(actualItems).toHaveLength(expectedItems.length)

    if (typeof expectedItems[0] === 'number') {
        expectPositionClose(actualItems as Position, expectedItems as Position, precision)
        return
    }

    for (let index = 0; index < expectedItems.length; index += 1) {
        expectCoordinatesClose(actualItems[index], expectedItems[index], precision)
    }
}

function expectGeometryClose(actual: Geometry, expected: Geometry, precision = 6): void {
    expect(actual.type).toBe(expected.type)
    expectCoordinatesClose(actual.coordinates, expected.coordinates, precision)
}

describe('Gt', () => {

    it('detects bbox intersection', () => {
        expect(Gt.intersects([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true)
        expect(Gt.intersects([0, 0, 10, 10], [10, 10, 20, 20])).toBe(true)
        expect(Gt.intersects([0, 0, 10, 10], [11, 11, 20, 20])).toBe(false)
    })

    it('expands two bboxes', () => {
        expect(Gt.expand([0, 5, 10, 15], [-5, 0, 20, 12])).toEqual([-5, 0, 20, 15])
    })

    it('normalizes a valid extent', () => {
        expect(Gt.normalize([0, 1, 10, 20], 'roads')).toEqual([0, 1, 10, 20])
    })

    it('returns undefined when normalizing an undefined extent', () => {
        expect(Gt.normalize(undefined, 'roads')).toBeUndefined()
    })

    it('computes distance between two positions', () => {
        expect(Gt.distance([0, 0], [3, 4])).toBe(5)
    })

    it('computes distance to a regular segment', () => {
        expect(Gt.distanceToSegment([5, 5], [0, 0], [10, 0])).toBe(5)
    })

    it('computes distance to a zero-length segment', () => {
        expect(Gt.distanceToSegment([3, 4], [0, 0], [0, 0])).toBe(5)
    })

    it('clamps values inside and outside bounds', () => {
        expect(Gt.clamp(5, 0, 10)).toBe(5)
        expect(Gt.clamp(-1, 0, 10)).toBe(0)
        expect(Gt.clamp(11, 0, 10)).toBe(10)
    })

    it('computes bbox for point geometry', () => {
        expect(Gt.bbox({
            type: 'Point',
            coordinates: [2, 3]
        })).toEqual([2, 3, 2, 3])
    })

    it('computes bbox for line string geometry', () => {
        expect(Gt.bbox({
            type: 'LineString',
            coordinates: [
                [2, 3],
                [-1, 5],
                [10, -2]
            ]
        })).toEqual([-1, -2, 10, 5])
    })

    it('computes bbox for polygon geometry', () => {
        expect(Gt.bbox({
            type: 'Polygon',
            coordinates: [
                [
                    [0, 0],
                    [10, 0],
                    [10, 10],
                    [0, 10],
                    [0, 0]
                ]
            ]
        })).toEqual([0, 0, 10, 10])
    })

    it('returns null bbox for null geometry', () => {
        expect(Gt.bbox(null)).toBeNull()
    })

    it('returns null bbox for an empty line string', () => {
        expect(Gt.bbox({
            type: 'LineString',
            coordinates: []
        })).toBeNull()
    })

    it('detects point inside a ring', () => {
        const ring = [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0]
        ] as [number, number][]

        expect(Gt.pointInRing([5, 5], ring)).toBe(true)
        expect(Gt.pointInRing([15, 5], ring)).toBe(false)
    })

    it('detects a point hit within tolerance', () => {
        const context: HitContext = {
            point: [10, 10],
            bbox: [9, 9, 11, 11],
            tolerance: 1,
            toleranceX: 1,
            toleranceY: 1
        }

        expect(Gt.positionHitsPoint([10.5, 10.5], context)).toBe(true)
        expect(Gt.positionHitsPoint([12, 10], context)).toBe(false)
    })

    it('detects line hit cases', () => {
        const context: HitContext = {
            point: [5, 1],
            bbox: [4, 0, 6, 2],
            tolerance: 1,
            toleranceX: 1,
            toleranceY: 1
        }

        expect(Gt.lineHitsPoint([], context)).toBe(false)
        expect(Gt.lineHitsPoint([[5, 1]], context)).toBe(true)
        expect(Gt.lineHitsPoint([[0, 0], [10, 0]], context)).toBe(true)
        expect(Gt.lineHitsPoint([[0, 5], [10, 5]], context)).toBe(false)
    })

    it('detects polygon hit cases including holes', () => {
        const contextInside: HitContext = {
            point: [5, 5],
            bbox: [4, 4, 6, 6],
            tolerance: 0.1,
            toleranceX: 0.1,
            toleranceY: 0.1
        }

        const contextInHole: HitContext = {
            point: [3, 3],
            bbox: [2.9, 2.9, 3.1, 3.1],
            tolerance: 0.1,
            toleranceX: 0.1,
            toleranceY: 0.1
        }

        const polygon: Position[][] = [
            [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0]
            ],
            [
                [2, 2],
                [4, 2],
                [4, 4],
                [2, 4],
                [2, 2]
            ]
        ]

        expect(Gt.polygonHitsPoint(polygon, contextInside)).toBe(true)
        expect(Gt.polygonHitsPoint(polygon, contextInHole)).toBe(false)
        expect(Gt.polygonHitsPoint([], contextInside)).toBe(false)
    })

    it('checks WMS 1.3.0 lat/lon axis order for EPSG:4326', () => {
        expect(Gt.usesLatLonAxisOrder('EPSG:4326', '1.3.0')).toBe(true)
        expect(Gt.usesLatLonAxisOrder('EPSG:3857', '1.3.0')).toBe(false)
        expect(Gt.usesLatLonAxisOrder('EPSG:4326', '1.1.1')).toBe(false)
    })

    it('parses bbox in xy order', () => {
        expect(Gt.parseBBox('1,2,3,4', 'EPSG:3857', '1.1.1')).toEqual({
            bbox: [1, 2, 3, 4],
            order: 'xy'
        })
    })

    it('parses bbox in yx order for EPSG:4326 and WMS 1.3.0', () => {
        expect(Gt.parseBBox('2,1,4,3', 'EPSG:4326', '1.3.0')).toEqual({
            bbox: [1, 2, 3, 4],
            order: 'yx'
        })
    })

    it('transforms label position when numeric coordinates are available', () => {
        const result = Gt.transformLabelPosition(
            {
                label_x: 0,
                label_y: 0,
                name: 'A'
            },
            'label_x',
            'label_y',
            'EPSG:4326',
            'EPSG:4326'
        )

        expect(result).toEqual({
            label_x: 0,
            label_y: 0,
            name: 'A'
        })
    })

    it('returns unchanged label properties when coordinates are not numeric', () => {
        const properties = {
            label_x: 'abc',
            label_y: 0
        }

        expect(Gt.transformLabelPosition(
            properties,
            'label_x',
            'label_y',
            'EPSG:4326',
            'EPSG:4326'
        )).toBe(properties)
    })

    it('returns unchanged label properties when properties are missing', () => {
        expect(Gt.transformLabelPosition(
            null,
            'label_x',
            'label_y',
            'EPSG:4326',
            'EPSG:3857'
        )).toBeNull()
    })

    it('transforms a position and preserves extra ordinates', () => {
        const transformed = Gt.transformPosition([2, 49, 123], 'EPSG:4326', 'EPSG:3857')

        expectPositionClose(transformed, [222638.98158654713, 6274861.394006576, 123])
    })

    it('clamps transformed positions to the target crs domain', () => {
        const transformed = Gt.transformPosition([0, 90], 'EPSG:4326', 'EPSG:3857')

        expectPositionClose(transformed, [0, 20037508.342789244])
    })

    it('transforms positions without an OpenLayers crs domain', () => {
        expect(Gt.transformPosition([2, 49], 'WGS84', 'WGS84')).toEqual([2, 49])
    })

    it('wraps bbox ranges to the crs domain before transforming', () => {
        expectBBoxClose(
            Gt.transformBBox([190, -10, 200, 10], 'EPSG:4326', 'EPSG:4326'),
            [-170, -10, -160, 10]
        )
    })

    it('uses the full wrapped domain when a bbox range spans the whole crs width', () => {
        expectBBoxClose(
            Gt.transformBBox([-200, -10, 200, 10], 'EPSG:4326', 'EPSG:4326'),
            [-180, -10, 180, 10]
        )
    })

    it('clamps bbox coordinates to non-geographic crs extents', () => {
        expectBBoxClose(
            Gt.transformBBox(
                [-30_000_000, -30_000_000, 30_000_000, 30_000_000],
                'EPSG:3857',
                'EPSG:3857'
            ),
            [
                -20037508.342789244,
                -20037508.342789244,
                20037508.342789244,
                20037508.342789244
            ]
        )
    })

    it('constrains a bbox to the target crs domain before transforming', () => {
        expectBBoxClose(
            Gt.transformBBox([-180, -90, 180, 90], 'EPSG:4326', 'EPSG:3857'),
            [
                -20037508.342789244,
                -20037508.342789244,
                20037508.342789244,
                20037508.342789244
            ],
            5
        )
    })

    it('throws a contextual error when a position cannot be transformed', () => {
        expect(() =>
            Gt.transformPosition([2, 49], 'EPSG:4326', 'EPSG:0')
        ).toThrow('Unable to transform coordinates from EPSG:4326 to EPSG:0:')
    })

    it('transforms every supported geometry type', () => {
        const cases: Array<{ geometry: Geometry, expected: Geometry }> = [
            {
                geometry: {
                    type: 'Point',
                    coordinates: [1, 2, 3]
                },
                expected: {
                    type: 'Point',
                    coordinates: [1, 2, 3]
                }
            },
            {
                geometry: {
                    type: 'LineString',
                    coordinates: [[1, 2], [3, 4]]
                },
                expected: {
                    type: 'LineString',
                    coordinates: [[1, 2], [3, 4]]
                }
            },
            {
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [[0, 0], [1, 0], [1, 1], [0, 0]]
                    ]
                },
                expected: {
                    type: 'Polygon',
                    coordinates: [
                        [[0, 0], [1, 0], [1, 1], [0, 0]]
                    ]
                }
            },
            {
                geometry: {
                    type: 'MultiPoint',
                    coordinates: [[1, 2], [3, 4]]
                },
                expected: {
                    type: 'MultiPoint',
                    coordinates: [[1, 2], [3, 4]]
                }
            },
            {
                geometry: {
                    type: 'MultiLineString',
                    coordinates: [
                        [[1, 2], [3, 4]],
                        [[5, 6], [7, 8]]
                    ]
                },
                expected: {
                    type: 'MultiLineString',
                    coordinates: [
                        [[1, 2], [3, 4]],
                        [[5, 6], [7, 8]]
                    ]
                }
            },
            {
                geometry: {
                    type: 'MultiPolygon',
                    coordinates: [
                        [
                            [[0, 0], [1, 0], [1, 1], [0, 0]]
                        ],
                        [
                            [[2, 2], [3, 2], [3, 3], [2, 2]]
                        ]
                    ]
                },
                expected: {
                    type: 'MultiPolygon',
                    coordinates: [
                        [
                            [[0, 0], [1, 0], [1, 1], [0, 0]]
                        ],
                        [
                            [[2, 2], [3, 2], [3, 3], [2, 2]]
                        ]
                    ]
                }
            }
        ]

        for (const { geometry, expected } of cases) {
            expectGeometryClose(Gt.transformGeometry(geometry, 'WGS84', 'WGS84'), expected)
        }
    })


    const context: HitContext = {
        point: [5, 5],
        bbox: [4, 4, 6, 6],
        tolerance: 1,
        toleranceX: 1,
        toleranceY: 1
    }

    it('computes bbox for multipoint geometry', () => {
        expect(Gt.bbox({
            type: 'MultiPoint',
            coordinates: [
                [5, 10],
                [-2, 3],
                [8, -1]
            ]
        })).toEqual([-2, -1, 8, 10])
    })

    it('computes bbox for multilinestring geometry', () => {
        expect(Gt.bbox({
            type: 'MultiLineString',
            coordinates: [
                [[0, 0], [10, 10]],
                [[-5, 2], [4, 20]]
            ]
        })).toEqual([-5, 0, 10, 20])
    })

    it('returns null bbox for an empty multipolygon', () => {
        expect(Gt.bbox({
            type: 'MultiPolygon',
            coordinates: []
        })).toBeNull()
    })

    it('computes bbox for multipolygon geometry with empty polygon entries', () => {
        expect(Gt.bbox({
            type: 'MultiPolygon',
            coordinates: [
                [],
                [
                    [
                        [1, 2],
                        [3, 4],
                        [5, 1]
                    ]
                ]
            ]
        })).toEqual([1, 1, 5, 4])
    })

    it('returns false when feature has no geometry', () => {
        const feature = {
            layer,
            type: 'Feature',
            geometry: null,
            properties: {}
        } as Feature

        expect(Gt.featureHitsPoint(feature, context)).toBe(false)
    })

    it('returns false when feature bbox does not intersect hit context bbox', () => {
        const feature = {
            layer,
            type: 'Feature',
            bbox: [100, 100, 110, 110],
            geometry: {
                type: 'Point',
                coordinates: [5, 5]
            },
            properties: {}
        } as Feature

        expect(Gt.featureHitsPoint(feature, context)).toBe(false)
    })

    it('skips geometry evaluation when feature bbox does not intersect hit bbox', () => {
        const feature = {
            layer,
            type: 'Feature',
            bbox: [100, 100, 110, 110],
            geometry: {
                type: 'Point',
                coordinates: [5, 5]
            },
            properties: {}
        } as Feature

        expect(Gt.featureHitsPoint(feature, context)).toBe(false)
    })
    it('evaluates geometry when feature bbox intersects hit bbox', () => {
        const feature = {
            layer,
            type: 'Feature',
            bbox: [0, 0, 10, 10],
            geometry: {
                type: 'Point',
                coordinates: [5, 5]
            },
            properties: {}
        } as Feature

        expect(Gt.featureHitsPoint(feature, context)).toBe(true)
    })
    it('checks geometry hit for every geometry type', () => {
        expect(Gt.geometryHitsPoint({
            type: 'Point',
            coordinates: [5, 5]
        }, context)).toBe(true)

        expect(Gt.geometryHitsPoint({
            type: 'MultiPoint',
            coordinates: [[0, 0], [5, 5]]
        }, context)).toBe(true)

        expect(Gt.geometryHitsPoint({
            type: 'LineString',
            coordinates: [[0, 5], [10, 5]]
        }, context)).toBe(true)

        expect(Gt.geometryHitsPoint({
            type: 'MultiLineString',
            coordinates: [
                [[0, 0], [1, 1]],
                [[0, 5], [10, 5]]
            ]
        }, context)).toBe(true)

        expect(Gt.geometryHitsPoint({
            type: 'Polygon',
            coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
            ]
        }, context)).toBe(true)

        expect(Gt.geometryHitsPoint({
            type: 'MultiPolygon',
            coordinates: [
                [
                    [[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]
                ],
                [
                    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
                ]
            ]
        }, context)).toBe(true)
    })

    it('returns true when polygon boundary is hit', () => {
        const boundaryContext: HitContext = {
            point: [0, 5],
            bbox: [-1, 4, 1, 6],
            tolerance: 1,
            toleranceX: 1,
            toleranceY: 1
        }

        expect(Gt.polygonHitsPoint([
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
        ], boundaryContext)).toBe(true)
    })

    it('returns false when point is outside polygon', () => {
        const outsideContext: HitContext = {
            point: [20, 20],
            bbox: [19, 19, 21, 21],
            tolerance: 1,
            toleranceX: 1,
            toleranceY: 1
        }

        expect(Gt.polygonHitsPoint([
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
        ], outsideContext)).toBe(false)
    })

    it('returns true when polygon hole boundary is hit', () => {
        const holeBoundaryContext: HitContext = {
            point: [2, 3],
            bbox: [1.9, 2.9, 2.1, 3.1],
            tolerance: 0.1,
            toleranceX: 0.1,
            toleranceY: 0.1
        }

        expect(Gt.polygonHitsPoint([
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
        ], holeBoundaryContext)).toBe(true)
    })

    it('throws when normalize receives a non-array extent', () => {
        expect(() =>
            Gt.normalize('invalid' as any, 'roads')
        ).toThrow(
            'Layer "roads" extent must be a bbox [minx,miny,maxx,maxy]'
        )
    })

    it('throws when normalize receives an extent with invalid length', () => {
        expect(() =>
            Gt.normalize([0, 0, 100] as any, 'roads')
        ).toThrow(
            'Layer "roads" extent must be a bbox [minx,miny,maxx,maxy]'
        )
    })

    it('throws when normalize receives non-finite values', () => {
        expect(() =>
            Gt.normalize([0, 0, Infinity, 100], 'roads')
        ).toThrow(
            'Layer "roads" extent must be a bbox [minx,miny,maxx,maxy]'
        )
    })

    it('throws when normalize receives inverted bounds', () => {
        expect(() =>
            Gt.normalize([10, 0, 5, 100], 'roads')
        ).toThrow(
            'Layer "roads" extent bbox minimum bounds must be lower than maximum bounds'
        )
    })

    it('throws when parseBBox receives non-numeric values', () => {
        expect(() =>
            Gt.parseBBox('1,2,abc,4', 'EPSG:3857', '1.1.1')
        ).toThrow(
            'Invalid BBOX: 1,2,abc,4'
        )
    })

    it('throws when parseBBox receives too few coordinates', () => {
        expect(() =>
            Gt.parseBBox('1,2,3', 'EPSG:3857', '1.1.1')
        ).toThrow(
            'Invalid BBOX: 1,2,3'
        )
    })

    it('throws when parseBBox receives invalid bounds', () => {
        expect(() =>
            Gt.parseBBox('10,0,5,100', 'EPSG:3857', '1.1.1')
        ).toThrow(
            'Invalid BBOX for EPSG:3857: minimum bounds must be lower than maximum bounds'
        )
    })

    it('throws when validateBBox receives inverted x bounds', () => {
        expect(() =>
            Gt.validateBBox([10, 0, 5, 100], 'EPSG:3857')
        ).toThrow(
            'Invalid BBOX for EPSG:3857: minimum bounds must be lower than maximum bounds'
        )
    })

    it('throws when validateBBox receives inverted y bounds', () => {
        expect(() =>
            Gt.validateBBox([0, 10, 100, 5], 'EPSG:3857')
        ).toThrow(
            'Invalid BBOX for EPSG:3857: minimum bounds must be lower than maximum bounds'
        )
    }

    )
})
