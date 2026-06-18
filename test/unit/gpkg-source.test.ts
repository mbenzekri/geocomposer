import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Layer } from '../../src/layer/layer.js'
import { GpkgSource } from '../../src/source/gpkg-source.js'

const { DatabaseSync } = await import('node:sqlite')

const layer = {
    name: 'cities',
    dataset: 'cities',
    crs: 'EPSG:4326'
} as Layer

let tmpDir: string

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpkg-source-'))
})

afterEach(() => {
    fs.rmSync(tmpDir, {
        recursive: true,
        force: true
    })
})

function gpkgPath(name = 'data.gpkg'): string {
    return path.join(tmpDir, name)
}

function createDatabase(file = gpkgPath()): InstanceType<typeof DatabaseSync> {
    return new DatabaseSync(file)
}

function createBaseGeoPackage(db: InstanceType<typeof DatabaseSync>): void {
    db.exec(`
        CREATE TABLE gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY,
            data_type TEXT NOT NULL,
            identifier TEXT,
            description TEXT,
            last_change TEXT,
            min_x DOUBLE,
            min_y DOUBLE,
            max_x DOUBLE,
            max_y DOUBLE,
            srs_id INTEGER
        );

        CREATE TABLE gpkg_geometry_columns (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL,
            z TINYINT NOT NULL,
            m TINYINT NOT NULL
        );
    `)
}

function createCitiesTable(db: InstanceType<typeof DatabaseSync>, options: {
    tableName?: string
    geometryColumn?: string
    primaryKey?: string
    withExtent?: boolean
} = {}): void {
    const tableName = options.tableName ?? 'cities'
    const geometryColumn = options.geometryColumn ?? 'geom'
    const primaryKey = options.primaryKey ?? 'id'
    const withExtent = options.withExtent ?? true

    db.exec(`
        CREATE TABLE "${tableName}" (
            "${primaryKey}" INTEGER PRIMARY KEY,
            "${geometryColumn}" BLOB,
            name TEXT,
            population INTEGER,
            enabled INTEGER,
            payload BLOB,
            huge INTEGER
        );

        INSERT INTO gpkg_contents (
            table_name,
            data_type,
            identifier,
            min_x,
            min_y,
            max_x,
            max_y,
            srs_id
        )
        VALUES (
            '${tableName}',
            'features',
            '${tableName}',
            ${withExtent ? 1 : 'NULL'},
            ${withExtent ? 2 : 'NULL'},
            ${withExtent ? 3 : 'NULL'},
            ${withExtent ? 4 : 'NULL'},
            4326
        );

        INSERT INTO gpkg_geometry_columns (
            table_name,
            column_name,
            geometry_type_name,
            srs_id,
            z,
            m
        )
        VALUES (
            '${tableName}',
            '${geometryColumn}',
            'POINT',
            4326,
            0,
            0
        );
    `)
}

function insertCity(db: InstanceType<typeof DatabaseSync>, values: {
    id: number | bigint
    name: string
    x?: number
    y?: number
    emptyGeometry?: boolean
    payload?: Uint8Array
    huge?: bigint
}): void {
    const statement = db.prepare(`
        INSERT INTO cities (
            id,
            geom,
            name,
            population,
            enabled,
            payload,
            huge
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    statement.run(
        values.id,
        values.emptyGeometry ? emptyGeoPackageGeometry() : pointGeoPackageGeometry(values.x ?? 1, values.y ?? 2),
        values.name,
        1000,
        1,
        values.payload ?? new Uint8Array([1, 2, 3]),
        values.huge ?? 42
    )
}

function pointGeoPackageGeometry(x: number, y: number): Buffer {
    const header = Buffer.alloc(8)
    header[0] = 0x47
    header[1] = 0x50
    header[2] = 0
    header[3] = 0
    header.writeInt32BE(4326, 4)

    const wkb = Buffer.alloc(21)
    wkb[0] = 1
    wkb.writeUInt32LE(1, 1)
    wkb.writeDoubleLE(x, 5)
    wkb.writeDoubleLE(y, 13)

    return Buffer.concat([header, wkb])
}

function emptyGeoPackageGeometry(): Buffer {
    const header = Buffer.alloc(8)
    header[0] = 0x47
    header[1] = 0x50
    header[2] = 0
    header[3] = 0b00010000
    header.writeInt32BE(4326, 4)
    return header
}

function invalidGeometry(bytes: number[]): Buffer {
    return Buffer.from(bytes)
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

function createValidGeoPackage(): string {
    const file = gpkgPath()
    const db = createDatabase(file)

    createBaseGeoPackage(db)
    createCitiesTable(db)
    insertCity(db, {
        id: 1,
        name: 'Paris',
        x: 2,
        y: 48,
        huge: BigInt(Number.MAX_SAFE_INTEGER) + 2n
    })
    insertCity(db, {
        id: 2,
        name: 'Lyon',
        x: 4,
        y: 45
    })

    db.close()
    return file
}

describe('GpkgSource', () => {
    it('accepts gpkg config entries', () => {
        expect(GpkgSource.acceptsConfig({
            type: 'gpkg',
            path: 'data.gpkg',
            datasets: {}
        })).toBe(true)
    })

    it('rejects non gpkg config entries', () => {
        expect(GpkgSource.acceptsConfig({ type: 'geojson' })).toBe(false)
        expect(GpkgSource.acceptsConfig(null)).toBe(false)
        expect(GpkgSource.acceptsConfig([])).toBe(false)
        expect(GpkgSource.acceptsConfig('gpkg')).toBe(false)
    })

    it('creates a source from config', () => {
        const source = GpkgSource.fromConfig('src', {
            type: 'gpkg',
            path: 'data.gpkg',
            datasets: {
                cities: {
                    tableName: 'cities'
                }
            }
        })

        expect(source.id).toBe('src')
        expect(source.type).toBe('geopackage')
        expect(source.storage).toBe('database')
    })

    it('opens only once and closes safely', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await source.open()
        await source.open()
        await source.close()
        await source.close()

        await expect(source.open()).resolves.toBeUndefined()
        await source.close()
    })

    it('streams features from a GeoPackage table', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                geometryColumn: 'geom',
                primaryKey: 'id',
                properties: ['name', 'population', 'enabled', 'payload', 'huge']
            }
        })

        const result = await readAll(source.stream({ layer }))

        expect(result).toHaveLength(2)

        expect(result[0]).toMatchObject({
            layer,
            crs: 'EPSG:4326',
            type: 'Feature',
            id: 1,
            properties: {
                name: 'Paris',
                population: 1000,
                enabled: 1,
                payload: Buffer.from([1, 2, 3]).toString('base64'),
                huge: String(BigInt(Number.MAX_SAFE_INTEGER) + 2n)
            },
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            },
            sourceRef: {
                storage: 'database',
                sourceId: 'src',
                tableName: 'cities',
                rowId: 1,
                primaryKey: 'id',
                geometryColumn: 'geom',
                recordIndex: 0
            }
        })

        expect(result[1]).toMatchObject({
            id: 2,
            properties: {
                name: 'Lyon'
            },
            geometry: {
                type: 'Point',
                coordinates: [4, 45]
            },
            sourceRef: {
                recordIndex: 1
            }
        })

        await source.close()
    })

    it('reads a feature from a sourceRef', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                primaryKey: 'id'
            }
        })

        const [streamed] = await readAll(source.stream({ layer }))
        const read = await source.read(streamed.sourceRef!, { layer })

        expect(read).toMatchObject({
            id: 1,
            sourceRef: streamed.sourceRef,
            geometry: {
                type: 'Point',
                coordinates: [2, 48]
            }
        })

        await source.close()
    })

    it('returns null when reading a missing row by sourceRef', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                primaryKey: 'id'
            }
        })

        await source.open()

        await expect(source.read({
            storage: 'database',
            sourceId: 'src',
            tableName: 'cities',
            rowId: 999,
            primaryKey: 'id',
            geometryColumn: 'geom'
        }, { layer })).resolves.toBeNull()

        await source.close()
    })

    it('reads a feature by id', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                primaryKey: 'id'
            }
        })

        await expect(source.readById('2', { layer })).resolves.toMatchObject({
            id: 2,
            properties: {
                name: 'Lyon'
            }
        })

        await source.close()
    })

    it('returns null when readById does not find a row', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                primaryKey: 'id'
            }
        })

        await expect(source.readById('999', { layer })).resolves.toBeNull()

        await source.close()
    })

    it('returns extent from gpkg_contents', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 3, 4])

        await source.close()
    })

    it('returns null extent when metadata extent is incomplete', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db, {
            withExtent: false
        })
        insertCity(db, {
            id: 1,
            name: 'Paris'
        })
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(source.getExtent(layer)).resolves.toBeNull()

        await source.close()
    })

    it('supports dataset fallback to layer name', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        const result = await readAll(source.stream({
            layer: {
                name: 'cities',
                crs: 'EPSG:4326'
            } as Layer
        }))

        expect(result).toHaveLength(2)

        await source.close()
    })

    it('uses rowid when no primary key is configured or detected', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        db.exec(`
            CREATE TABLE places (
                geom BLOB,
                name TEXT
            );

            INSERT INTO gpkg_contents (
                table_name,
                data_type,
                identifier,
                min_x,
                min_y,
                max_x,
                max_y,
                srs_id
            )
            VALUES ('places', 'features', 'places', 0, 0, 1, 1, 4326);

            INSERT INTO gpkg_geometry_columns (
                table_name,
                column_name,
                geometry_type_name,
                srs_id,
                z,
                m
            )
            VALUES ('places', 'geom', 'POINT', 4326, 0, 0);
        `)

        db.prepare('INSERT INTO places (geom, name) VALUES (?, ?)').run(
            pointGeoPackageGeometry(1, 2),
            'A'
        )
        db.close()

        const source = new GpkgSource('src', file, {
            places: {
                tableName: 'places'
            }
        })

        const result = await readAll(source.stream({
            layer: {
                name: 'places',
                dataset: 'places',
                crs: 'EPSG:4326'
            } as Layer
        }))

        expect(result[0]).toMatchObject({
            id: 1,
            sourceRef: {
                primaryKey: undefined
            }
        })

        await source.close()
    })

    it('applies transformFeature', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        }, (feature, index) => ({
            ...feature,
            id: `feature-${index}`
        }))

        const result = await readAll(source.stream({ layer }))

        expect(result[0].id).toBe('feature-0')

        await source.close()
    })

    it('throws when sourceRef belongs to another source', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await source.open()

        await expect(source.read({
            storage: 'database',
            sourceId: 'other',
            tableName: 'cities',
            rowId: 1,
            geometryColumn: 'geom'
        }, { layer })).rejects.toThrow(
            'GeoPackage sourceRef belongs to "other", expected "src"'
        )

        await source.close()
    })

    it('throws when sourceRef does not use database storage', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await source.open()

        await expect(source.read({
            storage: 'file',
            sourceId: 'src',
            tableName: 'cities',
            rowId: 1,
            geometryColumn: 'geom'
        } as any, { layer })).rejects.toThrow(
            'GeoPackage sourceRef must use database storage'
        )

        await source.close()
    })

    it('throws when sourceRef targets another table', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await source.open()

        await expect(source.read({
            storage: 'database',
            sourceId: 'src',
            tableName: 'roads',
            rowId: 1,
            geometryColumn: 'geom'
        }, { layer })).rejects.toThrow(
            'GeoPackage sourceRef targets table "roads", expected "cities"'
        )

        await source.close()
    })

    it('throws when file does not exist', async () => {
        const source = new GpkgSource('src', path.join(tmpDir, 'missing.gpkg'), {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(source.open()).rejects.toThrow()
    })

    it('throws when file path is not a string', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', Buffer.from(file), {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(source.open()).rejects.toThrow(
            'GeoPackage source requires a string file path'
        )
    })

    it('throws when no feature geometry table matches options', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(source.open()).rejects.toThrow(
            'Invalid GeoPackage: no feature geometry table found for the requested options'
        )
    })

    it('throws when the dataset fallback table has no feature metadata', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db, {
            tableName: 'cities'
        })
        createCitiesTable(db, {
            tableName: 'roads'
        })
        db.close()

        const source = new GpkgSource('src', file, {
            ambiguous: {}
        })

        await expect(source.open()).rejects.toThrow(
            'Invalid GeoPackage: no feature geometry table found for the requested options'
        )
    })

    it('throws when configured primary key does not exist', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                primaryKey: 'missing_id'
            }
        })

        await expect(source.open()).rejects.toThrow(
            'Invalid GeoPackage: primary key column "missing_id" not found in table "cities"'
        )
    })

    it('throws when geometry column does not exist in table', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)
        db.exec(`
            UPDATE gpkg_geometry_columns
            SET column_name = 'missing_geom'
            WHERE table_name = 'cities'
        `)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(source.open()).rejects.toThrow(
            'Invalid GeoPackage: geometry column "missing_geom" not found in table "cities"'
        )
    })

    it('throws when configured property column is empty', async () => {
        const file = createValidGeoPackage()

        expect(() => new GpkgSource('src', file, {
          cities: {
            tableName: 'cities',
            properties: ['']
          }
        })).toThrow('database dataset "cities" property must not be empty')
    })

    it('throws when configured property column is unknown', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities',
                properties: ['missing_property']
            }
        })

        await expect(source.open()).rejects.toThrow(
            'Invalid GeoPackage source: property column "missing_property" was not found'
        )
    })

    it('throws when dataset is not opened', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await source.open()

        await expect(source.getExtent({
            name: 'roads',
            dataset: 'roads',
            crs: 'EPSG:4326'
        } as Layer)).rejects.toThrow(
            'Item roads not found in Registry GeoPackage source "src"'
        )

        await source.close()
    })

    it('throws GeoPackage abort reason when stream is already aborted', async () => {
        const file = createValidGeoPackage()
        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        const controller = new AbortController()
        controller.abort('GeoPackage stream aborted')

        const reader = source.stream({
            layer,
            signal: controller.signal
        }).getReader()

        await expect(reader.read()).rejects.toBe('GeoPackage stream aborted')

        await source.close()
    })

    it('returns null geometry for null geometry values', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)
        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, null, 'Null Island', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toBeNull()

        await source.close()
    })

    it('returns null geometry for empty GeoPackage geometry flag', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)
        insertCity(db, {
            id: 1,
            name: 'Empty geometry',
            emptyGeometry: true
        })
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        const [feature] = await readAll(source.stream({ layer }))

        expect(feature.geometry).toBeNull()

        await source.close()
    })

    it('throws when GeoPackage geometry header is too short', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)
        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, invalidGeometry([0x47, 0x50]), 'Bad', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoPackage geometry: header is too short'
        )

        await source.close()
    })

    it('throws when GeoPackage geometry magic bytes are invalid', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)

        const geometry = pointGeoPackageGeometry(1, 2)
        geometry[0] = 0x00

        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, geometry, 'Bad', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoPackage geometry: missing GP magic bytes'
        )

        await source.close()
    })

    it('throws when GeoPackage geometry envelope code is invalid', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)

        const geometry = pointGeoPackageGeometry(1, 2)
        geometry[3] = 0b00001110

        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, geometry, 'Bad', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoPackage geometry envelope code: 7'
        )

        await source.close()
    })

    it('throws when GeoPackage geometry envelope exceeds buffer length', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)

        const geometry = Buffer.alloc(8)
        geometry[0] = 0x47
        geometry[1] = 0x50
        geometry[3] = 0b00000010

        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, geometry, 'Bad', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoPackage geometry: envelope exceeds buffer length'
        )

        await source.close()
    })

    it('throws when GeoPackage geometry has no WKB body', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)

        const geometry = Buffer.alloc(8)
        geometry[0] = 0x47
        geometry[1] = 0x50

        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, geometry, 'Bad', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoPackage geometry: missing WKB body'
        )

        await source.close()
    })

    it('throws when GeoPackage geometry has trailing WKB bytes', async () => {
        const file = gpkgPath()
        const db = createDatabase(file)

        createBaseGeoPackage(db)
        createCitiesTable(db)

        const geometry = Buffer.concat([
            pointGeoPackageGeometry(1, 2),
            Buffer.from([0xff])
        ])

        db.prepare(`
            INSERT INTO cities (
                id,
                geom,
                name,
                population,
                enabled,
                payload,
                huge
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, geometry, 'Bad', 0, 0, null, null)
        db.close()

        const source = new GpkgSource('src', file, {
            cities: {
                tableName: 'cities'
            }
        })

        await expect(readAll(source.stream({ layer }))).rejects.toThrow(
            'Invalid GeoPackage geometry: trailing bytes after WKB body'
        )

        await source.close()
    })
})
