import { describe, expect, it } from 'vitest'
import { IdFromFeature, withLazyBbox, type Feature } from '../../src/core/feature.js'
import type { Layer } from '../../src/layer/layer.js'

const layer = {} as Layer

describe('feature', () => {
    describe('IdFromFeature', () => {
        it('returns the explicit feature id as a string', () => {
            expect(IdFromFeature(feature({ id: 12 }))).toBe('12')
        })

        it('prefers the explicit feature id over source references', () => {
            expect(IdFromFeature(feature({
                id: 'feature-id',
                sourceRef: {
                    storage: 'database',
                    sourceId: 'db',
                    tableName: 'places',
                    rowId: 42
                }
            }))).toBe('feature-id')
        })

        it('returns the database row id as a string', () => {
            expect(IdFromFeature(feature({
                sourceRef: {
                    storage: 'database',
                    sourceId: 'db',
                    tableName: 'places',
                    rowId: 42
                }
            }))).toBe('42')
        })

        it('returns the memory feature index as a string', () => {
            expect(IdFromFeature(feature({
                sourceRef: {
                    storage: 'mem',
                    sourceId: 'memory',
                    featureIndex: 7
                }
            }))).toBe('7')
        })

        it('returns the source record index as a string', () => {
            expect(IdFromFeature(feature({
                sourceRef: {
                    sourceId: 'geojson',
                    offset: 10,
                    byteLength: 50,
                    recordIndex: 3
                }
            }))).toBe('3')
        })

        it('returns undefined when no id can be inferred', () => {
            expect(IdFromFeature(feature())).toBeUndefined()
            expect(IdFromFeature(feature({
                sourceRef: {
                    sourceId: 'geojson',
                    offset: 10,
                    byteLength: 50
                }
            }))).toBeUndefined()
        })
    })

    describe('withLazyBbox', () => {
        it('preserves an existing bbox', () => {
            const value = feature({ bbox: [1, 2, 3, 4] })

            expect(withLazyBbox(value)).toBe(value)
            expect(value.bbox).toEqual([1, 2, 3, 4])
        })

        it('computes and stores point, line and polygon bboxes lazily', () => {
            const point = withLazyBbox(feature({
                geometry: { type: 'Point', coordinates: [1, 2] }
            }))
            const line = withLazyBbox(feature({
                geometry: { type: 'LineString', coordinates: [[3, 4], [-1, 6]] }
            }))
            const polygon = withLazyBbox(feature({
                geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 1], [1, 3], [0, 0]]] }
            }))

            expect(Object.keys(point)).not.toContain('bbox')
            expect(point.bbox).toEqual([1, 2, 1, 2])
            expect(Object.keys(point)).toContain('bbox')
            expect(line.bbox).toEqual([-1, 4, 3, 6])
            expect(polygon.bbox).toEqual([0, 0, 2, 3])
        })

        it('computes multi geometry bboxes and handles null or empty geometries', () => {
            expect(withLazyBbox(feature({ geometry: null })).bbox).toBeUndefined()
            expect(withLazyBbox(feature({
                geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, -1]] }
            })).bbox).toEqual([1, -1, 3, 2])
            expect(withLazyBbox(feature({
                geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[-2, 5], [0, 7]]] }
            })).bbox).toEqual([-2, 2, 3, 7])
            expect(withLazyBbox(feature({
                geometry: {
                    type: 'MultiPolygon',
                    coordinates: [
                        [[[0, 0], [1, 2], [0, 0]]],
                        [[[-3, 4], [-1, 5], [-3, 4]]]
                    ]
                }
            })).bbox).toEqual([-3, 0, 1, 5])
            expect(withLazyBbox(feature({
                geometry: { type: 'MultiPolygon', coordinates: [] }
            })).bbox).toBeUndefined()
        })
    })
})

function feature(overrides: Partial<Feature> = {}): Feature {
    return {
        type: 'Feature',
        properties: null,
        geometry: null,
        layer,
        ...overrides
    }
}
