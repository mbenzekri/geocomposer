import { describe, expect, it } from 'vitest'
import {
    VectorTileGeometryProcessor,
    closeRing,
    removeClosingPosition,
    removeDuplicatePositions,
    samePosition,
    signedRingArea
} from '../../src/tileset/vector-tile-geometry.js'

const processor = (overrides = {}) => new VectorTileGeometryProcessor({
    bbox: [0, 0, 10, 10],
    extent: 100,
    buffer: 10,
    tolerance: 0,
    tileWidth: 256,
    tileHeight: 256,
    precision: 2,
    ...overrides
})

describe('vector tile geometry helpers', () => {
    it('compares, deduplicates and closes positions', () => {
        expect(samePosition([1, 2], [1, 2])).toBe(true)
        expect(samePosition([1, 2], [2, 1])).toBe(false)

        expect(removeDuplicatePositions([[0, 0], [0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]])
        expect(removeClosingPosition([[0, 0], [1, 0], [0, 0]])).toEqual([[0, 0], [1, 0]])
        expect(removeClosingPosition([[0, 0]])).toEqual([[0, 0]])
        expect(closeRing([])).toEqual([])
        expect(closeRing([[0, 0], [1, 0], [1, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]])
    })

    it('computes signed ring area', () => {
        expect(signedRingArea([[0, 0], [2, 0], [2, 2], [0, 0]])).toBe(2)
        expect(signedRingArea([[0, 0], [2, 2], [2, 0], [0, 0]])).toBe(-2)
    })
})

describe('VectorTileGeometryProcessor', () => {
    it('expands query bbox with buffer', () => {
        expect(processor().queryBbox).toEqual([-1, -1, 11, 11])
    })

    it('returns null for null and outside point geometries', () => {
        expect(processor().process(null)).toBeNull()
        expect(processor().process({ type: 'Point', coordinates: [20, 20] })).toBeNull()
    })

    it('processes point and converts it back to rounded world coordinates', () => {
        expect(processor({ precision: 1 }).process({
            type: 'Point',
            coordinates: [2.345, 7.654]
        })).toEqual({
            tileGeometry: {
                type: 'Point',
                coordinates: [23.45, 23.46]
            },
            worldGeometry: {
                type: 'Point',
                coordinates: [2.3, 7.7]
            }
        })
    })

    it('filters multipoints outside the buffered tile', () => {
        expect(processor().process({
            type: 'MultiPoint',
            coordinates: [[1, 1], [20, 20]]
        })).toEqual({
            tileGeometry: {
                type: 'MultiPoint',
                coordinates: [[10, 90]]
            },
            worldGeometry: {
                type: 'MultiPoint',
                coordinates: [[1, 1]]
            }
        })
    })

    it('returns null for multipoint with no retained positions', () => {
        expect(processor().process({
            type: 'MultiPoint',
            coordinates: [[20, 20]]
        })).toBeNull()
    })

    it('clips a line string crossing the tile', () => {
        expect(processor().process({
            type: 'LineString',
            coordinates: [[-5, 5], [5, 5], [15, 5]]
        })).toEqual({
            tileGeometry: {
                type: 'LineString',
                coordinates: [[-10, 50], [50, 50], [110, 50]]
            },
            worldGeometry: {
                type: 'LineString',
                coordinates: [[-1, 5], [5, 5], [11, 5]]
            }
        })
    })

    it('returns null for line string fully outside', () => {
        expect(processor().process({
            type: 'LineString',
            coordinates: [[20, 20], [30, 30]]
        })).toBeNull()
    })

    it('splits disconnected clipped line strings', () => {
        expect(processor().process({
            type: 'LineString',
            coordinates: [[1, 1], [2, 2], [20, 20], [3, 3], [4, 4]]
        })?.tileGeometry).toEqual({
            type: 'MultiLineString',
            coordinates: [
                [[10, 90], [20, 80]],
                [[30, 70], [40, 60]]
            ]
        })
    })

    it('processes multilines and collapses single retained line', () => {
        expect(processor().process({
            type: 'MultiLineString',
            coordinates: [
                [[1, 1], [2, 2]],
                [[20, 20], [30, 30]]
            ]
        })?.tileGeometry).toEqual({
            type: 'LineString',
            coordinates: [[10, 90], [20, 80]]
        })

        expect(processor().process({
            type: 'MultiLineString',
            coordinates: [
                [[1, 1], [2, 2]],
                [[3, 3], [4, 4]]
            ]
        })?.tileGeometry).toEqual({
            type: 'MultiLineString',
            coordinates: [
                [[10, 90], [20, 80]],
                [[30, 70], [40, 60]]
            ]
        })

        expect(processor().process({
            type: 'MultiLineString',
            coordinates: [
                [[20, 20], [30, 30]]
            ]
        })).toBeNull()
    })

    it('simplifies lines when tolerance is positive', () => {
        expect(processor({
            tolerance: 10,
            tileWidth: 100,
            tileHeight: 100
        }).process({
            type: 'LineString',
            coordinates: [[0, 0], [5, 0.1], [10, 0]]
        })?.tileGeometry).toEqual({
            type: 'LineString',
            coordinates: [[0, 100], [100, 100]]
        })
    })

    it('processes polygons with holes', () => {
        expect(processor().process({
            type: 'Polygon',
            coordinates: [
                [[1, 1], [9, 1], [9, 9], [1, 1]],
                [[2, 2], [3, 2], [3, 3], [2, 2]]
            ]
        })?.tileGeometry).toEqual({
            type: 'Polygon',
            coordinates: [
                [[10, 90], [90, 90], [90, 10], [10, 90]],
                [[20, 80], [30, 80], [30, 70], [20, 80]]
            ]
        })
    })

    it('clips polygons to the buffered tile', () => {
        expect(processor().process({
            type: 'Polygon',
            coordinates: [
                [[-5, -5], [15, -5], [15, 15], [-5, 15], [-5, -5]]
            ]
        })?.tileGeometry).toEqual({
            type: 'Polygon',
            coordinates: [[[-10, -10], [-10, 110], [110, 110], [110, -10], [-10, -10]]]
        })
    })

    it('returns null for invalid or too small polygons', () => {
        expect(processor().process({
            type: 'Polygon',
            coordinates: []
        })).toBeNull()

        expect(processor({
            tolerance: 10,
            tileWidth: 100,
            tileHeight: 100
        }).process({
            type: 'Polygon',
            coordinates: [
                [[1, 1], [1.01, 1], [1.01, 1.01], [1, 1]]
            ]
        })).toBeNull()
    })

    it('processes multipolygons and collapses a single retained polygon', () => {
        expect(processor().process({
            type: 'MultiPolygon',
            coordinates: [
                [[[1, 1], [2, 1], [2, 2], [1, 1]]],
                [[[20, 20], [21, 20], [21, 21], [20, 20]]]
            ]
        })?.tileGeometry).toEqual({
            type: 'Polygon',
            coordinates: [[[10, 90], [20, 90], [20, 80], [10, 90]]]
        })

        expect(processor().process({
            type: 'MultiPolygon',
            coordinates: [
                [[[1, 1], [2, 1], [2, 2], [1, 1]]],
                [[[3, 3], [4, 3], [4, 4], [3, 3]]]
            ]
        })?.tileGeometry.type).toBe('MultiPolygon')

        expect(processor().process({
            type: 'MultiPolygon',
            coordinates: [
                [[[20, 20], [21, 20], [21, 21], [20, 20]]]
            ]
        })).toBeNull()
    })
})
