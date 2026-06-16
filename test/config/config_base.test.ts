import { dirname, resolve } from 'node:path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GeoComposer } from '../../src/geo-composer.js'
import { Service } from '../../src/service/service.js'
import { Source } from '../../src/source/source.js'
import { PostgisSource } from '../../src/source/postgis-source.js'
import { OracleSource } from '../../src/source/oracle-source.js'
import { Layer } from '../../src/layer/layer.js'
import { Style } from '../../src/style/style.js'
import { Feature } from '../../src/core/feature.js'
import { Props, Singleton } from '../../src/core/tools.js'
import baseconf from './config_base.json' with { type: 'json' }

import { Config } from '../../src/config/config.js'
const world_datasets = {
    "world": {
        "tableName": "world",
    }
}
const oracle_cnx_short = "oracle://GEOCOMPOSER:geocomposer@localhost:1521/XEPDB1"
const postgis_cnx_short = "postgres://postgres:$s{GEOC_PGPWD|postgres}@localhost:5432/postgres"
const oracle_cnx_long = {
    "connectionString": oracle_cnx_short,
    "poolMin": 0,
    "poolMax": 4,
    "queueTimeout": 30000,
    "callTimeout": 30000
}

const postgis_cnx_long = {
    "connectionString": postgis_cnx_short,
    "max": 4,
    "connectionTimeoutMillis": 5000,
    "idleTimeoutMillis": 30000,
    "statementTimeoutMillis": 30000,
    "applicationName": "geocomposer"
}

function writeConf(path: string, conf: Props) {
    fs.mkdirSync(dirname(path), { recursive: true })
    fs.writeFileSync(path, JSON.stringify(conf, undefined, 4))
}

describe('test sources loading', () => {

    beforeEach(() => {
        Singleton.delete(Config)
        GeoComposer.clear()
    })

    afterEach(() => {
        Singleton.delete(Config)
        GeoComposer.clear()
    })

    test('memory layer resolves its provider layer during configuration load', async () => {
        const configPath = resolve('./test/temp/config_mem_missing_layer.json')
        const config = JSON.parse(JSON.stringify(baseconf))
        config.layers['world-mem'] = {
            "title": "World Memory",
            "abstract": "World country boundaries Memory demo layer",
            "layer": "missing-layer"
        }
        writeConf(configPath, config)

        await expect(GeoComposer.from({ configPath })).rejects.toThrow('missing-layer')
    })

    test('memory layer is configured without a declared memory source', async () => {
        const configPath = resolve('./test/temp/config_mem_layer.json')
        const config = JSON.parse(JSON.stringify(baseconf))
        config.layers['world-mem'] = {
            "title": "World Memory",
            "abstract": "World country boundaries Memory demo layer",
            "layer": "world"
        }
        writeConf(configPath, config)

        const app = await GeoComposer.from({ configPath })
        await app.open()

        expect(Source.registry.has('world')).toBe(true)
        expect(Source.registry.has('world-mem')).toBe(true)
        expect(Source.registry.all.length).toBe(2)
        expect(Layer.registry.has('world-mem')).toBe(true)
        expect(Layer.registry.all.length).toBe(2)

        const layer = Layer.registry.get('world-mem')
        expect(layer.crs).toBe(Layer.registry.get('world').crs)
        expect(layer.extent).toEqual(Layer.registry.get('world').extent)
        expect(layer.styles.map((style) => style.name)).toEqual(['default'])
        expect(layer.pointProperties).toEqual(Layer.registry.get('world').pointProperties)

        const features = [] as Feature[]
        for await (const feature of layer.stream({})) {
            features.push(feature)
        }
        expect(features.length).toBe(175)

        await app.close()
    })

    test('memory layer can override metadata and non-data rendering hints', async () => {
        const configPath = resolve('./test/temp/config_mem_layer_overrides.json')
        const config = JSON.parse(JSON.stringify(baseconf))
        config.layers['world-mem'] = {
            "title": "World Memory",
            "abstract": "Custom memory layer abstract",
            "layer": "world",
            "extent": [-10, -10, 10, 10],
            "pointProperties": []
        }
        writeConf(configPath, config)

        const app = await GeoComposer.from({ configPath })
        await app.open()

        const layer = Layer.registry.get('world-mem')
        expect(layer.title).toBe('World Memory')
        expect(layer.summary).toBe('Custom memory layer abstract')
        expect(layer.crs).toBe('EPSG:4326')
        expect(layer.extent).toEqual([-10, -10, 10, 10])
        expect(layer.pointProperties).toEqual([])
        expect(layer.styles.map((style) => style.name)).toEqual(['default'])

        await app.close()
    })

    test('memory layer cannot override provider crs', async () => {
        const configPath = resolve('./test/temp/config_mem_crs_override.json')
        const config = JSON.parse(JSON.stringify(baseconf))
        config.layers['world-mem'] = {
            "layer": "world",
            "crs": "EPSG:3857"
        }
        writeConf(configPath, config)

        await expect(GeoComposer.from({ configPath })).rejects.toThrow('cannot override crs')
    })

    test('memory layer cannot override provider dataset', async () => {
        const configPath = resolve('./test/temp/config_mem_dataset_override.json')
        const config = JSON.parse(JSON.stringify(baseconf))
        config.layers['world-mem'] = {
            "layer": "world",
            "dataset": "other"
        }
        writeConf(configPath, config)

        await expect(GeoComposer.from({ configPath })).rejects.toThrow()
    })

    test.each([
        ['object', postgis_cnx_long],
        ['string', postgis_cnx_short]
    ])('postgis source accepts %s connection during configuration load', async (name, connection) => {
        const configPath = resolve(`./test/temp/config_postgis_connection_${name}.json`)
        const config = JSON.parse(JSON.stringify(baseconf))
        config.sources.world = {
            type: "postgis",
            connection: connection,
            datasets: world_datasets
        }
        writeConf(configPath, config)

        await GeoComposer.from({ configPath })

        expect(Source.registry.get('world')).toBeInstanceOf(PostgisSource)
    })

    test.each([
        ['object', oracle_cnx_long, world_datasets],
        ['string', oracle_cnx_short, world_datasets]
    ])('oracle source accepts %s connection during configuration load', async (name, connection,datasets) => {
        const configPath = resolve(`./test/temp/config_oracle_connection_${name}.json`)
        const config = JSON.parse(JSON.stringify(baseconf))
        config.sources.world = {
            type: "oracle",
            connection: connection,
            datasets: datasets
        }
        writeConf(configPath, config)

        await GeoComposer.from({ configPath })

        expect(Source.registry.get('world')).toBeInstanceOf(OracleSource)
    })

    test.each([
        // name, source type, filename, expected source count, expected layer count, expected feature count
        ['Geojson', 'geojson', "world.geojson", 1, 1, 175],
        ['Shapefile', 'shp', "world.shp", 1, 1, 177],
        ['Gml', 'gml', "world.gml", 1, 1, 175],
        ['GeoPackage', 'gpkg', "world.gpkg", 1, 1, 175],
        ['PostGIS', 'postgis', undefined, 1, 1, 177],
        ['Oracle', 'oracle', undefined, 1, 1, 176],
    ])('load %s source / layer', async (name, type, filename, expectedSources, expectedLayers, expected) => {
        const configPath = resolve(`./test/temp/config_${type}.json`)
        const config = JSON.parse(JSON.stringify(baseconf))
        config.sources.world.type = type
        config.sources.world.title = `Source ${name}`
        config.sources.world.abstract = `World country boundaries ${name} demo source`
        config.sources.world.path = undefined
        config.sources.world.shpPath = undefined
        config.sources.world.dbfPath = undefined
        config.sources.world.datasets = undefined
        config.sources.world.source = undefined

        if ('world-geojson' in config.sources) delete config.sources['world-geojson']

        if (type === 'shp' && filename) {
            config.sources.world.shpPath = `../../data/shapefile/${filename}`
            config.sources.world.dbfPath = `../../data/shapefile/${filename.replace(/\.shp$/, '.dbf')}`
        }
        if (['geojson', 'gml', 'gpkg'].includes(type) && filename) {
            config.sources.world.path = `../../data/${filename}`
        }
        if (['gpkg'].includes(type)) {
            config.sources.world.datasets = world_datasets
        }

        if (type === 'postgis') {
            config.sources.world = { type , connection: postgis_cnx_short,datasets: world_datasets }
        }
        if (type === 'oracle') {
            config.sources.world = { type , connection: oracle_cnx_short,datasets: world_datasets }
        }
        writeConf(configPath, config)
        let app: GeoComposer
        app = await GeoComposer.from({ configPath })
        await app.open()

        expect(Service.registry.has('wms')).toBe(true)
        expect(Service.registry.all.length).toBe(1)
        expect(Source.registry.has('world')).toBe(true)
        expect(Source.registry.all.length).toBe(expectedSources)
        expect(Layer.registry.has('world')).toBe(true)
        expect(Layer.registry.all.length).toBe(expectedLayers)
        expect(Style.registry.has('default')).toBe(true)
        expect(Style.registry.all.length).toBe(1)
        const layer = Layer.registry.get("world")
        const features = [] as Feature[]
        for await (const feature of layer.stream({})) {
            features.push(feature)
        }
        expect(features.length).toBe(expected)
        await app.close()

    })

})
