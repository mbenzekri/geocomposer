import { resolve } from 'node:path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GeoComposer } from '../../src/geo-composer.js'
import { Service } from '../../src/service/service.js'
import { Source } from '../../src/source/source.js'
import { PostgisSource } from '../../src/source/postgis-source.js'
import { Layer } from '../../src/layer/layer.js'
import { Style } from '../../src/style/style.js'
import { Feature } from '../../src/core/feature.js'
import { Props, Singleton } from '../../src/core/tools.js'
import baseconf from './config_base.json' with { type: 'json' }

import { Config } from '../../src/config/config.js'
const datasets_gpkg = {
    "world": {
        "tableName": "world",
        // "geometryColumn": "geom"
    }
}
const source_postgis = {
    "type": "postgis",
    "title": "World PostGIS",
    "abstract": "World country boundaries PostGIS demo source.",
    "connection": "postgres://postgres:$s{GEOC_PGPWD|postgres}@localhost:5432/postgres",
    "datasets": {
        "world": {
            "tableName": "world",
        }
    },
}
const source_oracle = {
    "type": "oracle",
    "title": "World Oracle",
    "abstract": "World country boundaries Oracle demo source.",
    "connection": {
        "host": "localhost",
        "port": 1521,
        "serviceName": "XEPDB1",
        "user": "GEOCOMPOSER",
        "password": "geocomposer",
        "poolMin": 0,
        "poolMax": 4,
        "queueTimeout": 30000,
        "callTimeout": 30000
    },
    "schema": "GEOCOMPOSER",
    "datasets": {
        "world": {
            "tableName": "WORLD",
            "geometryColumn": "GEOM",
            "primaryKey": "ID",
            "srid": 4326
        }
    },
    "batchSize": 500,
    "extentStrategy": "metadata"
}
function writeConf(path: string, conf: Props) {
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
        ['object', source_postgis.connection],
        ['string', 'postgres://postgres:$s{GEOC_PGPWD|postgres}@localhost:5432/postgres']
    ])('postgis source accepts %s connection during configuration load', async (name, connection) => {
        const configPath = resolve(`./test/temp/config_postgis_connection_${name}.json`)
        const config = JSON.parse(JSON.stringify(baseconf))
        config.sources.world = {
            ...source_postgis,
            connection
        }
        writeConf(configPath, config)

        await GeoComposer.from({ configPath })

        expect(Source.registry.get('world')).toBeInstanceOf(PostgisSource)
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
            config.sources.world.datasets = datasets_gpkg
        }

        if (type === 'postgis') {
            config.sources.world = { ...source_postgis }
        }
        if (type === 'oracle') {
            config.sources.world = { ...source_oracle }
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
