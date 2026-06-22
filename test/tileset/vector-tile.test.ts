import { describe, expect, it, vi } from 'vitest'
import type { BBox, CrsCode } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import { getVectorTile, type GetVectorTileOptions } from '../../src/tileset/vector-tile.js'
import {
    GEOJSON_TILE_FORMAT,
    MVT_TILE_FORMAT,
    type RequiredVectorTileOptions
} from '../../src/tileset/tileset.js'

const encode = vi.fn((layers) => Buffer.from(JSON.stringify(layers), 'utf8'))

vi.mock('../../src/tileset/mvt-encoder.js', () => ({
    MvtEncoder: vi.fn(function MvtEncoder() {
        return { encode }
    })
}))

const streamFrom = <T>(values: T[]) => new ReadableStream<T>({
    start(controller) {
        for (const value of values) controller.enqueue(value)
        controller.close()
    }
})

const layer = (id: string, features: unknown[]): Layer => ({
    id,
    query: vi.fn(() => streamFrom(features))
} as unknown as Layer)

const options = (overrides: Partial<GetVectorTileOptions> = {}): GetVectorTileOptions => ({
    layers: [],
    bbox: [0, 0, 10, 10] as BBox,
    crs: 'EPSG:3857' as CrsCode,
    tileWidth: 256,
    tileHeight: 256,
    format: GEOJSON_TILE_FORMAT,
    vector: {
        extent: 100,
        buffer: 0,
        generalization: { tolerance: 0 },
        geojsonPrecision: 2
    } satisfies RequiredVectorTileOptions,
    ...overrides
})

describe('getVectorTile', () => {
    it('renders a GeoJSON vector tile from layer streams', async () => {
        const roads = layer('roads', [
            {
                id: 1,
                properties: { name: 'A' },
                geometry: { type: 'Point', coordinates: [5, 5] }
            },
            {
                id: 2,
                properties: { skip: true },
                geometry: null
            }
        ])

        const buildings = layer('buildings', [
            {
                properties: null,
                geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] }
            }
        ])

        const buffer = await getVectorTile(options({
            layers: [roads, buildings]
        }))

        expect(JSON.parse(buffer.toString('utf8'))).toEqual({
            type: 'FeatureCollection',
            crs: {
                type: 'name',
                properties: {
                    name: 'EPSG:3857'
                }
            },
            features: [
                {
                    type: 'Feature',
                    id: 1,
                    layer: 'roads',
                    properties: { name: 'A' },
                    geometry: {
                        type: 'Point',
                        coordinates: [5, 5]
                    }
                },
                {
                    type: 'Feature',
                    layer: 'buildings',
                    properties: null,
                    geometry: {
                        type: 'LineString',
                        coordinates: [[0, 0], [10, 10]]
                    }
                }
            ]
        })

        expect(roads.query).toHaveBeenCalledWith({
            bbox: [0, 0, 10, 10],
            crs: 'EPSG:3857'
        })
    })

    it('clones feature properties before storing them', async () => {
        const properties = { name: 'initial' }
        const roads = layer('roads', [
            {
                properties,
                geometry: { type: 'Point', coordinates: [5, 5] }
            }
        ])

        const buffer = await getVectorTile(options({ layers: [roads] }))
        properties.name = 'changed'

        expect(JSON.parse(buffer.toString('utf8')).features[0].properties).toEqual({
            name: 'initial'
        })
    })

    it('renders an encoded MVT vector tile grouped by layer', async () => {
        encode.mockClear()

        const roads = layer('roads', [
            {
                id: 'r1',
                properties: { kind: 'road' },
                geometry: { type: 'Point', coordinates: [5, 5] }
            }
        ])

        const buildings = layer('buildings', [
            {
                id: 'b1',
                properties: { kind: 'building' },
                geometry: { type: 'Point', coordinates: [6, 6] }
            }
        ])

        const buffer = await getVectorTile(options({
            layers: [roads, buildings],
            format: MVT_TILE_FORMAT
        }))

        const encoded = JSON.parse(buffer.toString('utf8'))

        expect(encoded).toEqual([
            {
                name: 'roads',
                extent: 100,
                features: [
                    {
                        id: 'r1',
                        properties: { kind: 'road' },
                        geometry: {
                            type: 'Point',
                            coordinates: [50, 50]
                        }
                    }
                ]
            },
            {
                name: 'buildings',
                extent: 100,
                features: [
                    {
                        id: 'b1',
                        properties: { kind: 'building' },
                        geometry: {
                            type: 'Point',
                            coordinates: [60, 40]
                        }
                    }
                ]
            }
        ])

        expect(encode).toHaveBeenCalledWith(encoded)
    })

    it('uses query bbox expanded by the vector buffer', async () => {
        const roads = layer('roads', [])

        await getVectorTile(options({
            layers: [roads],
            vector: {
                extent: 100,
                buffer: 10,
                generalization: { tolerance: 0 },
                geojsonPrecision: 2
            }
        }))

        expect(roads.query).toHaveBeenCalledWith({
            bbox: [-1, -1, 11, 11],
            crs: 'EPSG:3857'
        })
    })

    it('releases reader lock when feature collection fails', async () => {
        const releaseLock = vi.fn()
        const failingLayer = {
            id: 'broken',
            query: vi.fn(() => ({
                getReader: () => ({
                    read: vi.fn()
                        .mockResolvedValueOnce({
                            done: false,
                            value: {
                                properties: {},
                                geometry: { type: 'Point', coordinates: [5, 5] }
                            }
                        })
                        .mockRejectedValueOnce(new Error('stream failed')),
                    releaseLock
                })
            }))
        } as unknown as Layer

        await expect(getVectorTile(options({
            layers: [failingLayer]
        }))).rejects.toThrow('stream failed')

        expect(releaseLock).toHaveBeenCalledTimes(1)
    })

    it('rejects unsupported vector tile output format', async () => {
        await expect(getVectorTile(options({
            format: 'text/plain'
        }))).rejects.toThrow('Unsupported vector tile format "text/plain"')
    })

    it('rejects tiles exceeding maxFeatures', async () => {
        const roads = layer('roads', [
            {
                properties: {},
                geometry: { type: 'Point', coordinates: [1, 1] }
            },
            {
                properties: {},
                geometry: { type: 'Point', coordinates: [2, 2] }
            }
        ])

        await expect(getVectorTile(options({
            layers: [roads],
            vector: {
                extent: 100,
                buffer: 0,
                generalization: { tolerance: 0 },
                geojsonPrecision: 2,
                maxFeatures: 1
            }
        }))).rejects.toThrow('Vector tile exceeds maxFeatures 1')
    })
})
