import { describe, expect, it } from 'vitest'
import { IdFromFeature, type Feature } from '../../src/core/feature.js'
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
