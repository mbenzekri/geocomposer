import { resolve } from 'node:path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GeoComposer } from '../../src/geo-composer.js'
import { Service } from '../../src/service/service.js'
import { Source } from '../../src/source/source.js'
import { Layer } from '../../src/layer/layer.js'
import { Style } from '../../src/style/style.js'
import { Feature } from '../../src/core/feature.js'
import { Props, Singleton } from '../../src/core/tools.js'
import baseconf from './config_base.json' with { type: 'json' }

import { Config } from '../../src/config/config.js'
const datasets_gpkg = {
    "world": {
        "tableName": "world",
        "geometryColumn": "geom"
    }
}
const source_postgis = {
    "type": "postgis",
    "title": "World PostGIS",
    "abstract": "World country boundaries PostGIS demo source.",
    "connection": {
        "connectionString": "postgres://postgres:$s{GEOC_PGPWD|postgres}@localhost:5432/postgres",
        "max": 4,
        "connectionTimeoutMillis": 5000,
        "idleTimeoutMillis": 30000,
        "statementTimeoutMillis": 30000,
        "applicationName": "geocomposer"
    },
    "schema": "public",
    "datasets": {
        "world": {
            "tableName": "world",
            "geometryColumn": "wkb_geometry",
            "primaryKey": "ogc_fid",
            "srid": 4326
        }
    },
    "batchSize": 500,
    "extentStrategy": "estimated"
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

    test.each([
        // name, source type, filename, expected source count, expected feature count
        ['Geojson', 'geojson', "world.geojson", 1, 175],
        ['Memory', 'mem', undefined, 2, 175],
        ['Shapefile', 'shp', "world.shp", 1, 177],
        ['Gml', 'gml', "world.gml", 1, 175],
        ['GeoPackage', 'gpkg', "world.gpkg", 1, 175],
        ['PostGIS', 'postgis', undefined, 1, 177],
        ['Oracle', 'oracle', undefined, 1, 176],
    ])('load %s source / layer', async (name, type, filename, expectedSources, expected) => {
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

        if (type === 'mem') {
            config.sources.world.source = "world-geojson"
            config.sources['world-geojson'] = {
                "type": "geojson",
                "title": "World GeoJSON",
                "abstract": "World country boundaries GeoJSON demo source.",
                "path": "../../data/world.geojson"
            }
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
        if (type === 'mem') {
            expect(Source.registry.has('world-geojson')).toBe(true)
        }
        expect(Layer.registry.has('world')).toBe(true)
        expect(Layer.registry.all.length).toBe(1)
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
