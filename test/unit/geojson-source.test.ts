import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Layer } from '../../src/layer/layer.js'
import { GeoJsonSource } from '../../src/source/geojson-source.js'

const layer = {
    name: 'geojson-layer',
    crs: 'EPSG:4326'
} as Layer

let tmpDir: string

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-source-'))
})

afterEach(() => {
    fs.rmSync(tmpDir, {
        recursive: true,
        force: true
    })
})

function writeFile(name: string, content: string): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, content)
    return file
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader()
    const values: T[] = []

    try {
        for (;;) {
            const result = await reader.read()
            if (result.done) return values
            values.push(result.value)
        }
    } finally {
        reader.releaseLock()
    }
}

describe('GeoJsonSource', () => {
    it('accepts geojson config entries', () => {
        expect(GeoJsonSource.acceptsConfig({
            type: 'geojson',
            path: 'data.geojson'
        })).toBe(true)
    })

    it('rejects non geojson config entries', () => {
        expect(GeoJsonSource.acceptsConfig({
            type: 'gml',
            path: 'data.gml'
        })).toBe(false)

        expect(GeoJsonSource.acceptsConfig(null)).toBe(false)
        expect(GeoJsonSource.acceptsConfig([])).toBe(false)
        expect(GeoJsonSource.acceptsConfig('geojson')).toBe(false)
    })

    it('creates a source from config', () => {
        const source = GeoJsonSource.fromConfig('cities', {
            type: 'geojson',
            path: 'cities.geojson',
            encoding: 'utf8',
            highWaterMark: 32
        })

        expect(source.id).toBe('cities')
        expect(source.type).toBe('geojson')
        expect(source.storage).toBe('file')
        expect(source.getFiles()).toEqual([
            {
                role: 'data',
                path: 'cities.geojson'
            }
        ])
    })

    it('streams features from a FeatureCollection', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'a',
                    properties: {
                        name: 'A'
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: [1, 2]
                    }
                },
                {
                    type: 'Feature',
                    id: 'b'
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file, 'utf8', 8)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(2)

        expect(result[0]).toMatchObject({
            id: 'a',
            type: 'Feature',
            layer,
            crs: 'EPSG:4326',
            properties: {
                name: 'A'
            },
            geometry: {
                type: 'Point',
                coordinates: [1, 2]
            },
            sourceRef: {
                storage: 'file',
                sourceId: 'cities',
                recordIndex: 0
            }
        })

        expect(result[0].sourceRef).toEqual(expect.objectContaining({
            offset: expect.any(Number),
            byteLength: expect.any(Number)
        }))

        expect(result[1]).toMatchObject({
            id: 'b',
            type: 'Feature',
            layer,
            crs: 'EPSG:4326',
            properties: null,
            geometry: null,
            sourceRef: {
                storage: 'file',
                sourceId: 'cities',
                recordIndex: 1
            }
        })
    })

    it('reads a streamed feature from its sourceRef', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'a',
                    properties: {
                        name: 'A'
                    },
                    geometry: null
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file)
        const [streamed] = await readAll(source.stream({ layer }))

        const read = await source.read(streamed.sourceRef!, { layer })

        expect(read).toMatchObject({
            id: 'a',
            type: 'Feature',
            layer,
            crs: 'EPSG:4326',
            properties: {
                name: 'A'
            },
            geometry: null,
            sourceRef: streamed.sourceRef
        })
    })

    it('applies transformFeature to streamed and read features', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {},
                    geometry: null
                }
            ]
        }))

        const source = new GeoJsonSource(
            'cities',
            file,
            'utf8',
            undefined,
            (feature, index) => ({
                ...feature,
                id: `generated-${index}`
            })
        )

        const [streamed] = await readAll(source.stream({ layer }))
        const read = await source.read(streamed.sourceRef!, { layer })

        expect(streamed.id).toBe('generated-0')
        expect(read?.id).toBe('generated-0')
    })

    it('reads a feature by id using the inherited full scan', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'target',
                    properties: {},
                    geometry: null
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(source.readById('target', { layer })).resolves.toMatchObject({
            id: 'target'
        })
    })

    it('returns null when readById does not find a feature', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: []
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(source.readById('missing', { layer })).resolves.toBeNull()
    })

    it('throws when sourceRef belongs to another source', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: []
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'other',
            offset: 0,
            byteLength: 1
        }, { layer })).rejects.toThrow(
            'GeoJSON sourceRef belongs to "other", expected "cities"'
        )
    })

    it('throws when sourceRef has no offset', async () => {
        const file = writeFile('features.geojson', '{}')
        const source = new GeoJsonSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            byteLength: 1
        } as any, { layer })).rejects.toThrow(
            'GeoJSON sourceRef must include offset and byteLength'
        )
    })

    it('throws when sourceRef has no byteLength', async () => {
        const file = writeFile('features.geojson', '{}')
        const source = new GeoJsonSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 0
        } as any, { layer })).rejects.toThrow(
            'GeoJSON sourceRef must include offset and byteLength'
        )
    })

    it('throws when sourceRef byte range exceeds file length', async () => {
        const file = writeFile('features.geojson', '{}')
        const source = new GeoJsonSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 0,
            byteLength: 999
        }, { layer })).rejects.toThrow(
            'Invalid GeoJSON sourceRef: byte range exceeds file length'
        )
    })

    it('throws when GeoJSON has no top-level features array', async () => {
        const file = writeFile('invalid.geojson', JSON.stringify({
            type: 'FeatureCollection'
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoJSON: expected a top-level FeatureCollection.features array'
        )
    })

    it('throws when features is not an array', async () => {
        const file = writeFile('invalid.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: {}
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoJSON: FeatureCollection.features must be an array'
        )
    })

    it('throws when features contains a non-object item', async () => {
        const file = writeFile('invalid.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [1]
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoJSON: FeatureCollection.features must contain Feature objects'
        )
    })

    it('throws when feature object is not a GeoJSON Feature', async () => {
        const file = writeFile('invalid.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Point',
                    coordinates: [1, 2]
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoJSON: expected a Feature object'
        )
    })

    it('throws when features array is unfinished', async () => {
        const file = writeFile(
            'invalid.geojson',
            '{"type":"FeatureCollection","features":[{"type":"Feature"}'
        )

        const source = new GeoJsonSource('cities', file)

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoJSON: unfinished FeatureCollection.features array'
        )
    })

    it('throws when read sourceRef points to invalid feature JSON', async () => {
        const file = writeFile('invalid-feature.json', JSON.stringify({
            type: 'Point',
            coordinates: [1, 2]
        }))

        const source = new GeoJsonSource('cities', file)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 0,
            byteLength: fs.statSync(file).size
        }, { layer })).rejects.toThrow(
            'Invalid GeoJSON: expected a Feature object'
        )
    })

    it('uses GeoJSON stream aborted as abort reason', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: []
        }))

        const controller = new AbortController()
        controller.abort('GeoJSON stream aborted')

        const source = new GeoJsonSource('cities', file)
        const reader = source.stream({
            layer,
            signal: controller.signal
        }).getReader()

        await expect(reader.read()).rejects.toBe('GeoJSON stream aborted')
    })

    it('supports escaped strings while searching the features key', async () => {
        const file = writeFile(
            'features.geojson',
            '{"type":"FeatureCollection","ignored\\"key":1,"features":[{"type":"Feature","properties":{"name":"A"},"geometry":null}]}'
        )

        const source = new GeoJsonSource('cities', file)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].properties).toEqual({
            name: 'A'
        })
    })

    it('supports nested objects, arrays and braces inside feature strings', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {
                        text: 'brace } inside string',
                        nested: {
                            values: [1, 2, 3]
                        }
                    },
                    geometry: null
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].properties).toEqual({
            text: 'brace } inside string',
            nested: {
                values: [1, 2, 3]
            }
        })
    })

    it('supports whitespace and separators between features', async () => {
        const file = writeFile(
            'features.geojson',
            `{
                "type": "FeatureCollection",
                "features": [
                    { "type": "Feature", "id": "a" }
                    ,
                    { "type": "Feature", "id": "b" }
                ]
            }`
        )

        const source = new GeoJsonSource('cities', file)
        const result = await readAll(source.stream({ layer }))

        expect(result.map((feature) => feature.id)).toEqual(['a', 'b'])
    })

    it('handles a features key split across chunks', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'a'
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file, 'utf8', 1)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
    })

    it('handles a feature object split across chunks', async () => {
        const file = writeFile('features.geojson', JSON.stringify({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'a',
                    properties: {
                        name: 'A'
                    },
                    geometry: null
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file, 'utf8', 2)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
    })

    it('handles large prefixes and trims the internal parser buffer', async () => {
        const file = writeFile('large.geojson', JSON.stringify({
            metadata: 'x'.repeat(70000),
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'a',
                    properties: {},
                    geometry: null
                }
            ]
        }))

        const source = new GeoJsonSource('cities', file)
        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
    })
})