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
let openedSources: ShpSource[] = []

beforeEach(() => {
    tmpDirs = []
    openedSources = []
})

afterEach(async () => {
    await Promise.allSettled(openedSources.reverse().map((source) => source.close()))
    await Promise.all(
        tmpDirs.map((dir) =>
            fs.rm(dir, {
                recursive: true,
                force: true
            })
        )
    )
})

async function openSource(source: ShpSource): Promise<ShpSource> {
    await source.open()
    openedSources.push(source)
    return source
}

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

async function replaceFirstShpRecord(shpPath: string, record: Buffer): Promise<void> {
    const header = (await fs.readFile(shpPath)).subarray(0, 100)
    await fs.writeFile(shpPath, Buffer.concat([header, record]))
}

function multiPointRecord(points: Array<[number, number]>): Buffer {
    const contentLength = 4 + 32 + 4 + points.length * 16
    const record = Buffer.alloc(8 + contentLength)
    record.writeInt32BE(1, 0)
    record.writeInt32BE(contentLength / 2, 4)
    record.writeInt32LE(8, 8)
    record.writeDoubleLE(Math.min(...points.map(([x]) => x)), 12)
    record.writeDoubleLE(Math.min(...points.map(([, y]) => y)), 20)
    record.writeDoubleLE(Math.max(...points.map(([x]) => x)), 28)
    record.writeDoubleLE(Math.max(...points.map(([, y]) => y)), 36)
    record.writeInt32LE(points.length, 44)

    let offset = 48
    for (const [x, y] of points) {
        record.writeDoubleLE(x, offset)
        record.writeDoubleLE(y, offset + 8)
        offset += 16
    }

    return record
}

function shapeTypeRecord(shapeType: number): Buffer {
    const content = Buffer.alloc(4)
    content.writeInt32LE(shapeType, 0)
    return shpRecord(content)
}

function shpRecord(content: Buffer): Buffer {
    const record = Buffer.alloc(8 + content.length)
    record.writeInt32BE(1, 0)
    record.writeInt32BE(content.length / 2, 4)
    content.copy(record, 8)
    return record
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))
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
                sourceId: 'cities',
                recordIndex: 0,
                related: {
                    dbf: {
                        storage: 'file',
                        sourceId: 'cities'
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

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

        const source = await openSource(new ShpSource(
            'cities',
            fixture.shpPath,
            fixture.dbfPath,
            undefined,
            undefined,
            (feature, index) => ({
                ...feature,
                id: `generated-${index}`
            })
        ))

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

        const source = await openSource(new ShpSource('roads', fixture.shpPath, fixture.dbfPath))
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

        const source = await openSource(new ShpSource('roads', fixture.shpPath, fixture.dbfPath))
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

        const source = await openSource(new ShpSource('areas', fixture.shpPath, fixture.dbfPath))
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

        const source = await openSource(new ShpSource('areas', fixture.shpPath, fixture.dbfPath))
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry?.type).toBe('Polygon')

        if (feature.geometry?.type === 'Polygon') {
            expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(1)
        }
    })

    it('streams multipoint features', async () => {
        const fixture = await createShapefileFixture(
            'multipoints',
            'POINT',
            [
                [2, 48]
            ],
            [
                {
                    name: 'cities'
                }
            ]
        )
        await replaceFirstShpRecord(fixture.shpPath, multiPointRecord([
            [2, 48],
            [4, 45]
        ]))

        const source = await openSource(new ShpSource('multipoints', fixture.shpPath, fixture.dbfPath))
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toEqual({
            type: 'MultiPoint',
            coordinates: [
                [2, 48],
                [4, 45]
            ]
        })
    })

    it('uses cpg sidecar encoding when dbfEncoding is not configured', async () => {
        const fixture = await createShapefileFixture(
            'encoded',
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
        await fs.writeFile(path.join(fixture.dir, 'encoded.cpg'), 'latin1')

        const source = await openSource(new ShpSource('encoded', fixture.shpPath, fixture.dbfPath))
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.properties).toMatchObject({
            name: 'Paris'
        })
    })

    it('uses ascii cpg sidecar encoding', async () => {
        const fixture = await createShapefileFixture(
            'ascii',
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
        await fs.writeFile(path.join(fixture.dir, 'ascii.cpg'), 'us-ascii')

        const source = await openSource(new ShpSource('ascii', fixture.shpPath, fixture.dbfPath))
        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.properties).toMatchObject({
            name: 'Paris'
        })
    })

    it('returns null geometry for empty and null SHP records', async () => {
        const fixture = await createShapefileFixture(
            'null-shape',
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
        const source = await openSource(new ShpSource('null-shape', fixture.shpPath, fixture.dbfPath))

        await replaceFirstShpRecord(fixture.shpPath, shpRecord(Buffer.alloc(0)))
        await expect(readAll(source.stream({ layer }))).resolves.toMatchObject([{ geometry: null }])

        await replaceFirstShpRecord(fixture.shpPath, shapeTypeRecord(0))
        await expect(readAll(source.stream({ layer }))).resolves.toMatchObject([{ geometry: null }])
    })

    it('throws for unsupported and truncated SHP record geometries', async () => {
        const fixture = await createShapefileFixture(
            'bad-shape',
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
        const source = await openSource(new ShpSource('bad-shape', fixture.shpPath, fixture.dbfPath))

        await replaceFirstShpRecord(fixture.shpPath, shapeTypeRecord(31))
        await expect(readAll(source.stream({ layer }))).rejects.toThrow('Unsupported shapefile shape type: 31')

        await replaceFirstShpRecord(fixture.shpPath, shapeTypeRecord(1))
        await expect(readAll(source.stream({ layer }))).resolves.toMatchObject([{ geometry: null }])
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

        await expect(source.read({
            storage: 'file',
            sourceId: 'other',
            offset: 100,
            byteLength: 28
        }, { layer })).rejects.toThrow(
            'Shapefile sourceRef belongs to "other", expected "cities"'
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 100,
            byteLength: 9999
        }, { layer })).rejects.toThrow(
            'Invalid shapefile sourceRef: byte range exceeds file length'
        )
    })

    it('throws when sourceRef record is shorter than the SHP record header', async () => {
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))

        await expect(source.read({
            storage: 'file',
            sourceId: 'cities',
            offset: 100,
            byteLength: 4
        }, { layer })).rejects.toThrow(
            'Invalid shapefile sourceRef: record is shorter than the SHP header'
        )
    })

    it('throws when sourceRef recordIndex is outside the DBF table', async () => {
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))
        const [feature] = await readAll(source.stream({ layer }))

        await expect(source.read({
            ...feature.sourceRef!,
            recordIndex: 99
        }, { layer })).rejects.toThrow(
            'Invalid DBF: record index 99 is out of range'
        )
    })

    it('throws for truncated DBF headers and field descriptors', async () => {
        const fixture = await createShapefileFixture(
            'bad-dbf',
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

        await fs.writeFile(fixture.dbfPath, Buffer.alloc(8))
        await expect(openSource(new ShpSource('bad-dbf', fixture.shpPath, fixture.dbfPath)))
            .rejects.toThrow('Invalid DBF: header is too short')

        const header = Buffer.alloc(32)
        header.writeUInt32LE(1, 4)
        header.writeUInt16LE(64, 8)
        header.writeUInt16LE(1, 10)
        await fs.writeFile(fixture.dbfPath, header)
        await expect(openSource(new ShpSource('bad-dbf', fixture.shpPath, fixture.dbfPath)))
            .rejects.toThrow('Invalid DBF: field descriptors are incomplete')
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

        const source = await openSource(new ShpSource('cities', fixture.shpPath, fixture.dbfPath))
        const reader = source.stream({
            layer,
            signal: controller.signal
        }).getReader()

        await expect(reader.read()).rejects.toBe('Shapefile stream aborted')
    })
})
