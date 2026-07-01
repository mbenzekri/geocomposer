import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/tileset/tile-matrix-set.js', () => ({
    getTileMatrixSet: vi.fn(() => ({
        crs: 'EPSG:3857',
        bbox: vi.fn((z: number, x: number, y: number) => [z, x, y, z + x + y]),
        matrix: vi.fn((z: number) => ({ id: z })),
        validateCoord: vi.fn((z: number, x: number, y: number) => {
            if (x < 0 || y < 0) throw new Error('invalid coord')
        }),
        zoomFromMatrixId: vi.fn((value: string) => Number(value.replace('z', '')))
    }))
}))

import {
    GEOJSON_TILE_FORMAT,
    MVT_TILE_FORMAT,
    RASTER_TILE_FORMAT,
    Tileset,
    WEBP_TILE_FORMAT,
    normalizeTileFormat,
    normalizeTileFormats,
    tileFormatFromExtension
} from '../../src/tileset/tileset.js'

import { Layer } from '../../src/layer/layer.js'
import { getTileMatrixSet } from '../../src/tileset/tile-matrix-set.js'

type TestLayer = Layer & {
    resolveStyle: ReturnType<typeof vi.fn>
}

const baseEntry = () => ({
    formats: [RASTER_TILE_FORMAT],
    layers: ['roads']
})

const addLayer = (
    id = 'roads',
    resolveStyle = vi.fn(() => ({ id: 'default-style' }))
) => {
    const layer = {
        id,
        resolveStyle
    } as TestLayer
    Layer.registry.set(id, layer)
    return layer
}

describe('tileset formats', () => {
    it('normalizes supported formats and aliases', () => {
        expect(normalizeTileFormat(RASTER_TILE_FORMAT)).toBe(RASTER_TILE_FORMAT)
        expect(normalizeTileFormat(WEBP_TILE_FORMAT)).toBe(WEBP_TILE_FORMAT)
        expect(normalizeTileFormat(GEOJSON_TILE_FORMAT)).toBe(GEOJSON_TILE_FORMAT)
        expect(normalizeTileFormat('application/json')).toBe(GEOJSON_TILE_FORMAT)
        expect(normalizeTileFormat(MVT_TILE_FORMAT)).toBe(MVT_TILE_FORMAT)
        expect(normalizeTileFormat('application/x-protobuf')).toBe(MVT_TILE_FORMAT)
    })

    it('rejects unsupported formats', () => {
        expect(() => normalizeTileFormat('text/plain')).toThrow(
            'Unsupported tileset format "text/plain"'
        )
    })

    it('normalizes a unique format list', () => {
        expect(normalizeTileFormats([
            RASTER_TILE_FORMAT,
            WEBP_TILE_FORMAT,
            'application/json',
            'application/x-protobuf'
        ])).toEqual([
            RASTER_TILE_FORMAT,
            WEBP_TILE_FORMAT,
            GEOJSON_TILE_FORMAT,
            MVT_TILE_FORMAT
        ])
    })

    it('rejects empty, invalid and duplicate format lists', () => {
        expect(() => normalizeTileFormats([])).toThrow(
            'Tileset formats must define at least one output format'
        )

        expect(() => normalizeTileFormats(undefined as unknown as string[])).toThrow(
            'Tileset formats must define at least one output format'
        )

        expect(() => normalizeTileFormats([
            GEOJSON_TILE_FORMAT,
            'application/json'
        ])).toThrow(
            'Tileset formats must not contain duplicates: application/geo+json, application/geo+json'
        )
    })

    it('resolves formats from extensions', () => {
        expect(tileFormatFromExtension('PNG')).toBe(RASTER_TILE_FORMAT)
        expect(tileFormatFromExtension('webp')).toBe(WEBP_TILE_FORMAT)
        expect(tileFormatFromExtension('geojson')).toBe(GEOJSON_TILE_FORMAT)
        expect(tileFormatFromExtension('json')).toBe(GEOJSON_TILE_FORMAT)
        expect(tileFormatFromExtension('pbf')).toBe(MVT_TILE_FORMAT)
        expect(tileFormatFromExtension('mvt')).toBe(MVT_TILE_FORMAT)
        expect(tileFormatFromExtension(MVT_TILE_FORMAT)).toBe(MVT_TILE_FORMAT)
    })
})

describe('Tileset', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        Tileset.registry.clear()
        Layer.registry.clear()
        addLayer()
    })

    it('creates a raster tileset with defaults', () => {
        const tileset = new Tileset('main', baseEntry())

        expect(tileset.id).toBe('main')
        expect(tileset.crs).toBe('EPSG:3857')
        expect(tileset.minZoom).toBe(0)
        expect(tileset.maxZoom).toBe(22)
        expect(tileset.defaultFormat).toBe(RASTER_TILE_FORMAT)
        expect(tileset.hasVectorFormats).toBe(false)
        expect(tileset.layers).toHaveLength(1)
        expect(tileset.outputs).toEqual([
            { format: RASTER_TILE_FORMAT, extension: 'png', vector: false }
        ])
        expect(getTileMatrixSet).toHaveBeenCalledWith(undefined)
    })

    it('creates a vector tileset with explicit options and style refs', () => {
        const layer = addLayer('buildings')
        const tileset = new Tileset('vector', {
            tileMatrixSet: 'WebMercatorQuad',
            formats: ['application/json', 'application/x-protobuf'],
            minZoom: 1,
            maxZoom: 3,
            cacheControl: 'max-age=60',
            vector: {
                extent: 8192,
                buffer: 12,
                generalization: { tolerance: 1.5 },
                geojsonPrecision: 4,
                maxFeatures: 100
            },
            layers: [{ layer: 'buildings', style: 'night' }]
        })

        expect(tileset.formats).toEqual([GEOJSON_TILE_FORMAT, MVT_TILE_FORMAT])
        expect(tileset.cacheControl).toBe('max-age=60')
        expect(tileset.vector).toEqual({
            extent: 8192,
            buffer: 12,
            generalization: { tolerance: 1.5 },
            geojsonPrecision: 4,
            maxFeatures: 100
        })
        expect(layer.resolveStyle).toHaveBeenCalledWith('night')
        expect(getTileMatrixSet).toHaveBeenCalledWith('WebMercatorQuad')
    })

    it('delegates bbox, matrix, coord validation and matrix id parsing', () => {
        const tileset = new Tileset('main', {
            ...baseEntry(),
            minZoom: 1,
            maxZoom: 2
        })

        expect(tileset.bbox(1, 2, 3)).toEqual([1, 2, 3, 6])
        expect(tileset.matrix(2)).toEqual({ id: 2 })
        expect(tileset.zoomFromMatrixId('z12')).toBe(12)
        expect(() => tileset.validateCoord(0, 0, 0)).toThrow('z must be between 1 and 2')
        expect(() => tileset.validateCoord(1, -1, 0)).toThrow('invalid coord')
    })

    it('resolves and checks output formats', () => {
        const tileset = new Tileset('main', {
            formats: [RASTER_TILE_FORMAT, 'application/json'],
            layers: ['roads']
        })

        expect(tileset.resolveOutput()).toEqual({
            format: RASTER_TILE_FORMAT,
            extension: 'png',
            vector: false
        })
        expect(tileset.resolveOutput('json')).toEqual({
            format: GEOJSON_TILE_FORMAT,
            extension: 'geojson',
            vector: true
        })
        expect(tileset.supportsFormat('application/json')).toBe(true)
        expect(tileset.supportsFormat(MVT_TILE_FORMAT)).toBe(false)
        expect(() => tileset.resolveOutput(MVT_TILE_FORMAT)).toThrow(
            'Tileset "main" does not support format "application/vnd.mapbox-vector-tile"'
        )
    })

    it('builds and selects tilesets from the registry', () => {
        const registry = Tileset.build({
            one: baseEntry(),
            two: {
                formats: [GEOJSON_TILE_FORMAT],
                layers: ['roads']
            }
        })

        expect(registry.all).toHaveLength(2)
        expect(Tileset.select(undefined, 'wmts')).toHaveLength(2)
        expect(Tileset.select(['one'], 'wmts')[0].id).toBe('one')
        expect(() => Tileset.select(['missing'], 'wmts')).toThrow(
            'Unknown tileset "missing" in wmts service'
        )
        expect(() => Tileset.select([], 'wmts')).toThrow(
            'wmts service requires at least one tileset'
        )

        Tileset.registry.clear()

        expect(() => Tileset.select(undefined, 'wmts')).toThrow(
            'wmts service requires at least one configured tileset'
        )
    })

    it('rejects invalid layer configuration', () => {
        expect(() => new Tileset('empty', {
            formats: [RASTER_TILE_FORMAT],
            layers: []
        })).toThrow('Tileset "empty" must define at least one entry in "layers"')

        expect(() => new Tileset('missing-layer', {
            formats: [RASTER_TILE_FORMAT],
            layers: ['unknown']
        })).toThrow('Unknown layer "unknown" in tileset "missing-layer"')
    })

    it('wraps named style errors and preserves default style errors', () => {
        const namedLayer = addLayer('named', vi.fn(() => {
            throw new Error('missing style')
        }))

        expect(() => new Tileset('styled', {
            formats: [RASTER_TILE_FORMAT],
            layers: [{ layer: 'named', style: 'ghost' }]
        })).toThrow('Unknown style "ghost" for layer "named" in tileset "styled"')

        expect(() => new Tileset('default-style', {
            formats: [RASTER_TILE_FORMAT],
            layers: ['named']
        })).toThrow('missing style')

        expect(namedLayer.resolveStyle).toHaveBeenCalled()
    })

    it('rejects invalid zoom and id values', () => {
        expect(() => new Tileset('', baseEntry())).toThrow(
            'Tileset id must not be empty'
        )

        expect(() => new Tileset('bad-min', {
            ...baseEntry(),
            minZoom: -1
        })).toThrow('Tileset "bad-min" minZoom must be a non-negative integer')

        expect(() => new Tileset('bad-min-float', {
            ...baseEntry(),
            minZoom: 0.5
        })).toThrow('Tileset "bad-min-float" minZoom must be a non-negative integer')

        expect(() => new Tileset('bad-max', {
            ...baseEntry(),
            minZoom: 3,
            maxZoom: 2
        })).toThrow('Tileset "bad-max" maxZoom must be an integer greater than or equal to minZoom')

        expect(() => new Tileset('bad-max-float', {
            ...baseEntry(),
            maxZoom: 1.5
        })).toThrow('Tileset "bad-max-float" maxZoom must be an integer greater than or equal to minZoom')
    })

    it('rejects vector options without vector output format', () => {
        expect(() => new Tileset('raster-vector-options', {
            ...baseEntry(),
            vector: { extent: 4096 }
        })).toThrow(
            'Tileset "raster-vector-options" vector options require at least one vector output format'
        )
    })

    it('rejects invalid vector options', () => {
        const invalidCases = [
            ['extent', { extent: 0 }, 'vector.extent must be a positive integer'],
            ['extent-float', { extent: 1.5 }, 'vector.extent must be a positive integer'],
            ['buffer', { buffer: -1 }, 'vector.buffer must be a non-negative number'],
            ['buffer-nan', { buffer: Number.NaN }, 'vector.buffer must be a non-negative number'],
            ['tolerance', { generalization: { tolerance: -1 } }, 'vector.generalization.tolerance must be a non-negative number'],
            ['tolerance-inf', { generalization: { tolerance: Infinity } }, 'vector.generalization.tolerance must be a non-negative number'],
            ['precision', { geojsonPrecision: -1 }, 'vector.geojsonPrecision must be a non-negative integer'],
            ['precision-float', { geojsonPrecision: 1.5 }, 'vector.geojsonPrecision must be a non-negative integer'],
            ['max-features', { maxFeatures: 0 }, 'vector.maxFeatures must be a positive integer'],
            ['max-features-float', { maxFeatures: 1.5 }, 'vector.maxFeatures must be a positive integer']
        ] as const

        for (const [name, vector, message] of invalidCases) {
            expect(() => new Tileset(`bad-${name}`, {
                formats: [GEOJSON_TILE_FORMAT],
                vector,
                layers: ['roads']
            })).toThrow(`Tileset "bad-${name}" ${message}`)
        }
    })
})
