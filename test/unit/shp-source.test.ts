import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import shpwrite from '@mapbox/shp-write'
import type { Layer } from '../../src/layer/layer.js'
import { ShpSource } from '../../src/source/shp-source.js'

const layer = {
    id: 'test-layer',
    crs: 'EPSG:4326'
} as Layer

type ShapefileFixture = {
    dir: string
    shpPath: string
    shxPath: string
    dbfPath: string
}

let tmpDirs: string[] = []

beforeEach(() => {
    tmpDirs = []
})

afterEach(async () => {
    await Promise.all(
        tmpDirs.map((dir) =>
            fs.rm(dir, {
                recursive: true,
                force: true
            })
        )
    )
})

async function createShapefileFixture(
    name: string,
    geometryType: shpwrite.OGCGeometry,
    geometries: object[],
    properties: Record<string, unknown>[]
): Promise<ShapefileFixture> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `shp-source-${name}-`))
    tmpDirs.push(dir)

    const result = await writeShapefile(properties, geometryType, geometries)

    const shpPath = path.join(dir, `${name}.shp`)
    const shxPath = path.join(dir, `${name}.shx`)
    const dbfPath = path.join(dir, `${name}.dbf`)

    await Promise.all([
        fs.writeFile(shpPath, dataViewToBuffer(result.shp)),
        fs.writeFile(shxPath, dataViewToBuffer(result.shx)),
        fs.writeFile(dbfPath, dataViewToBuffer(result.dbf))
    ])

    return {
        dir,
        shpPath,
        shxPath,
        dbfPath
    }
}

function writeShapefile(
    properties: Record<string, unknown>[],
    geometryType: shpwrite.OGCGeometry,
    geometries: object[]
): Promise<{
    shp: DataView
    shx: DataView
    dbf: DataView
}> {
    return new Promise((resolve, reject) => {
        shpwrite.write(
            properties,
            geometryType,
            geometries,
            (error: unknown, result: { shp: DataView, shx: DataView, dbf: DataView }) => {
                if (error) {
                    reject(error)
                    return
                }

                resolve(result)
            }
        )
    })
}

function dataViewToBuffer(view: DataView): Buffer {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
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

describe('ShpSource', () => {
    it('accepts shp config entries', () => {
        expect(ShpSource.acceptsConfig({
            type: 'shp',
            shpPath: 'data.shp',
            dbfPath: 'data.dbf'
        })).toBe(true)
    })

    it('rejects non shp config entries', () => {
        expect(ShpSource.acceptsConfig({ type: 'geojson' })).toBe(false)
        expect(ShpSource.acceptsConfig(null)).toBe(false)
        expect(ShpSource.acceptsConfig([])).toBe(false)
        expect(ShpSource.acceptsConfig('shp')).toBe(false)
    })

    it('creates a source from config and exposes files', () => {
        const source = ShpSource.fromConfig('cities', {
            type: 'shp',
            shpPath: 'cities.shp',
            dbfPath: 'cities.dbf',
            dbfEncoding: 'utf8',
            highWaterMark: 16
        })

        expect(source.id).toBe('cities')
        expect(source.type).toBe('shapefile')
        expect(source.storage).toBe('file')
        expect(source.getFiles()).toEqual([
            {
                role: 'geometry',
                path: 'cities.shp'
            },
            {
                role: 'attributes',
                path: 'cities.dbf'
            }
        ])
    })

    it('streams point features', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48],
                [4, 45]
            ],
            [
                {
                    name: 'Paris',
                    value: 1
                },
                {
                    name: 'Lyon',
                    value: 2
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)
        const features = await readAll(source.stream({ layer }))

        expect(features).toHaveLength(2)

        expect(features[0]).toMatchObject({
            layer,
            crs: 'EPSG:4326',
            type: 'Feature',
            id: 1,
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            },
            sourceRef: {
                storage: 'file',
                sourceId: 'cities:shp',
                recordIndex: 0,
                related: {
                    dbf: {
                        storage: 'file',
                        sourceId: 'cities:dbf'
                    }
                }
            }
        })

        expect(features[0].properties).toMatchObject({
            name: 'Paris'
        })

        expect(features[1]).toMatchObject({
            id: 2,
            geometry: {
                type: 'Point',
                coordinates: [4, 45]
            },
            sourceRef: {
                recordIndex: 1
            }
        })
    })

    it('reads a streamed point feature from its sourceRef', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)
        const [streamed] = await readAll(source.stream({ layer }))
        const read = await source.read(streamed.sourceRef!, { layer })

        expect(read).toMatchObject({
            id: 1,
            layer,
            crs: 'EPSG:4326',
            properties: {
                name: 'Paris'
            },
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            },
            sourceRef: streamed.sourceRef
        })
    })

    it('reads a feature by id using inherited full scan', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48],
                [4, 45]
            ],
            [
                {
                    name: 'Paris'
                },
                {
                    name: 'Lyon'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.readById('2', { layer })).resolves.toMatchObject({
            id: 2,
            properties: {
                name: 'Lyon'
            },
            geometry: {
                type: 'Point',
                coordinates: [4, 45]
            }
        })
    })

    it('returns null when readById does not find a feature', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.readById('999', { layer })).resolves.toBeNull()
    })

    it('applies transformFeature to streamed and read features', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource(
            'cities',
            fixture.shpPath,
            fixture.dbfPath,
            undefined,
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

    it('streams line string features', async () => {
        const fixture = await createShapefileFixture(
            'lines',
            'POLYLINE',
            [
                [
                    [
                        [0, 0],
                        [10, 10],
                        [20, 5]
                    ]
                ]
            ],
            [
                {
                    name: 'A1'
                }
            ]
        )

        const source = new ShpSource('roads', fixture.shpPath, fixture.dbfPath)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'LineString',
            coordinates: [
                [0, 0],
                [10, 10],
                [20, 5]
            ]
        })

        expect(feature.properties).toMatchObject({
            name: 'A1'
        })
    })

    it('streams multi line string features when polyline has multiple parts', async () => {
        const fixture = await createShapefileFixture(
            'multilines',
            'POLYLINE',
            [
                [
                    [
                        [0, 0],
                        [10, 10]
                    ],
                    [
                        [20, 20],
                        [30, 25]
                    ]
                ]
            ],
            [
                {
                    name: 'network'
                }
            ]
        )

        const source = new ShpSource('roads', fixture.shpPath, fixture.dbfPath)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'MultiLineString',
            coordinates: [
                [
                    [0, 0],
                    [10, 10]
                ],
                [
                    [20, 20],
                    [30, 25]
                ]
            ]
        })
    })

    it('streams polygon features', async () => {
        const fixture = await createShapefileFixture(
            'polygons',
            'POLYGON',
            [
                [
                    [
                        [0, 0],
                        [0, 10],
                        [10, 10],
                        [10, 0],
                        [0, 0]
                    ]
                ]
            ],
            [
                {
                    name: 'area'
                }
            ]
        )

        const source = new ShpSource('areas', fixture.shpPath, fixture.dbfPath)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry?.type).toBe('Polygon')
        expect(feature.properties).toMatchObject({
            name: 'area'
        })
    })

    it('streams polygon features with holes', async () => {
        const fixture = await createShapefileFixture(
            'polygon-hole',
            'POLYGON',
            [
                [
                    [
                        [0, 0],
                        [0, 10],
                        [10, 10],
                        [10, 0],
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
            ],
            [
                {
                    name: 'area-with-hole'
                }
            ]
        )

        const source = new ShpSource('areas', fixture.shpPath, fixture.dbfPath)
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry?.type).toBe('Polygon')

        if (feature.geometry?.type === 'Polygon') {
            expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(1)
        }
    })

    it('opens and closes source explicitly', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.open()).resolves.toBeUndefined()
        await expect(source.close()).resolves.toBeUndefined()
        await expect(source.close()).resolves.toBeUndefined()
    })

    it('throws when sourceRef belongs to another source', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.read({
            storage: 'file',
            sourceId: 'other:shp',
            offset: 100,
            byteLength: 28
        }, { layer })).rejects.toThrow(
            'Shapefile sourceRef belongs to "other:shp", expected "cities:shp"'
        )
    })

    it('throws when sourceRef has no offset', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities:shp',
            byteLength: 28
        } as any, { layer })).rejects.toThrow(
            'Shapefile sourceRef must include offset and byteLength'
        )
    })

    it('throws when sourceRef has no byteLength', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities:shp',
            offset: 100
        } as any, { layer })).rejects.toThrow(
            'Shapefile sourceRef must include offset and byteLength'
        )
    })

    it('throws when sourceRef byte range exceeds file length', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities:shp',
            offset: 100,
            byteLength: 9999
        }, { layer })).rejects.toThrow(
            'Invalid shapefile sourceRef: byte range exceeds file length'
        )
    })

    it('uses Shapefile stream aborted as abort reason', async () => {
        const fixture = await createShapefileFixture(
            'points',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'Paris'
                }
            ]
        )

        const controller = new AbortController()
        controller.abort('Shapefile stream aborted')

        const source = new ShpSource('cities', fixture.shpPath, fixture.dbfPath)
        const reader = source.stream({
            layer,
            signal: controller.signal
        }).getReader()

        await expect(reader.read()).rejects.toBe('Shapefile stream aborted')
    })
})
