import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { config_base, config_min, init, oracle_cnx_long, oracle_cnx_short, postgis_cnx_long, postgis_cnx_short, world_min_datasets, writeConf} from '../test-tools.js'

import { GeoComposer } from '../../src/geo-composer.js'
import { Service } from '../../src/service/service.js'
import { Source } from '../../src/source/source.js'
import { PostgisSource } from '../../src/source/postgis-source.js'
import { OracleSource } from '../../src/source/oracle-source.js'
import { Layer } from '../../src/layer/layer.js'
import { Style } from '../../src/style/style.js'
import { Feature } from '../../src/core/feature.js'
import { Tileset } from '../../src/tileset/tileset.js'


describe('test sources loading', () => {

    beforeEach(() => {
        init()
    })

    test('memory layer resolves its provider layer during configuration load', async () => {
        config_base.layers['world-mem'] = {
            "title": "World Memory",
            "abstract": "World country boundaries Memory demo layer",
            "layer": "missing-layer"
        }
        const configPath = writeConf('config_mem_missing_layer.json', config_base)

        await expect(GeoComposer.from({ configPath })).rejects.toThrow('missing-layer')
    })

    test('tileset layer can be declared by layer name and uses the layer default style', async () => {
        config_min.tilesets = {
            "world": {
                "formats": ["image/png"],
                "layers": ["world"]
            }
        }
        const configPath = writeConf('config_tileset_layer_name.json', config_min)

        await GeoComposer.from({ configPath })

        const layer = Layer.registry.get('world')
        const tileset = Tileset.registry.get('world')
        expect(tileset.layers).toEqual([layer])
        expect(tileset.resolveStyles()).toEqual([layer.style])
    })

    test('memory layer is configured without a declared memory source', async () => {
        config_base.layers['world-mem'] = {
            "title": "World Memory",
            "abstract": "World country boundaries Memory demo layer",
            "layer": "world"
        }
        const configPath = writeConf('config_mem_layer.json', config_base)

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
        expect(Style.registry.has('default')).toBe(true)
        expect(layer.pointProperties).toEqual(Layer.registry.get('world').pointProperties)

        const features = [] as Feature[]
        for await (const feature of layer.stream({})) {
            features.push(feature)
        }
        expect(features.length).toBe(175)

        await app.close()
    })

    test('memory layer can override metadata and non-data rendering hints', async () => {
        config_base.layers['world-mem'] = {
            "title": "World Memory",
            "abstract": "Custom memory layer abstract",
            "layer": "world",
            "extent": [-10, -10, 10, 10],
            "pointProperties": []
        }
        const configPath = writeConf('config_mem_layer_overrides.json', config_base)

        const app = await GeoComposer.from({ configPath })
        await app.open()

        const layer = Layer.registry.get('world-mem')
        expect(layer.title).toBe('World Memory')
        expect(layer.abstract).toBe('Custom memory layer abstract')
        expect(layer.crs).toBe('EPSG:4326')
        expect(layer.extent).toEqual([-10, -10, 10, 10])
        expect(layer.pointProperties).toEqual([])
        expect(Style.registry.has('default')).toBe(true)

        await app.close()
    })

    test('memory layer cannot override provider crs', async () => {
        config_base.layers['world-mem'] = {
            "layer": "world",
            "crs": "EPSG:3857"
        }
        const configPath = writeConf('config_mem_crs_override.json',config_base)

        await expect(GeoComposer.from({ configPath })).rejects.toThrow('cannot override crs')
    })

    test('memory layer cannot override provider dataset', async () => {
        config_base.layers['world-mem'] = {
            "layer": "world",
            "dataset": "other"
        }
        const configPath = writeConf('config_mem_dataset_override.json',config_base)

        await expect(GeoComposer.from({ configPath })).rejects.toThrow()
    })

    test.each([
        ['object', postgis_cnx_long],
        ['string', postgis_cnx_short]
    ])('postgis source accepts %s connection during configuration load', async (name, connection) => {
        config_base.sources.world = {
            type: "postgis",
            connection: connection,
            datasets: world_min_datasets
        }
        const configPath = writeConf(`config_postgis_connection_${name}.json`,config_base)

        await GeoComposer.from({ configPath })
        expect(Source.registry.get('world')).toBeInstanceOf(PostgisSource)
    })

    test.each([
        ['object', oracle_cnx_long, world_min_datasets],
        ['string', oracle_cnx_short, world_min_datasets]
    ])('oracle source accepts %s connection during configuration load', async (name, connection,datasets) => {
        config_base.sources.world = {
            type: "oracle",
            connection: connection,
            datasets: datasets
        }
        const configPath = writeConf(`config_oracle_connection_${name}.json`,config_base)

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
        const configPath = writeConf(`config_${type}.json`,config_base)

        config_base.sources.world.type = type
        config_base.sources.world.title = `Source ${name}`
        config_base.sources.world.abstract = `World country boundaries ${name} demo source`
        config_base.sources.world.path = undefined
        config_base.sources.world.shpPath = undefined
        config_base.sources.world.dbfPath = undefined
        config_base.sources.world.datasets = undefined
        config_base.sources.world.source = undefined

        if ('world-geojson' in config_base.sources) delete config_base.sources['world-geojson']

        if (type === 'shp' && filename) {
            config_base.sources.world.shpPath = `../../data/shapefile/${filename}`
            config_base.sources.world.dbfPath = `../../data/shapefile/${filename.replace(/\.shp$/, '.dbf')}`
        }
        if (['geojson', 'gml', 'gpkg'].includes(type) && filename) {
            config_base.sources.world.path = `../../data/${filename}`
        }
        if (['gpkg'].includes(type)) {
            config_base.sources.world.datasets = world_min_datasets
        }

        if (type === 'postgis') {
            config_base.sources.world = { type , connection: postgis_cnx_short,datasets: world_min_datasets }
        }
        if (type === 'oracle') {
            config_base.sources.world = { type , connection: oracle_cnx_short,datasets: world_min_datasets }
        }
        config_base.sources.world.title = `Source ${name}`
        config_base.sources.world.abstract = `World country boundaries ${name} demo source`
        writeConf(configPath, config_base)
        let app: GeoComposer
        app = await GeoComposer.from({ configPath })
        await app.open()

        expect(Service.registry.has('wms')).toBe(true)
        expect(Service.registry.all.length).toBe(1)
        expect(Source.registry.has('world')).toBe(true)
        expect(Source.registry.get('world').title).toBe(`Source ${name}`)
        expect(Source.registry.get('world').abstract).toBe(`World country boundaries ${name} demo source`)
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
    
    test('basic initialisation', async () => {

        const configPath = writeConf('test-conf.json', config_base)
        const result = await GeoComposer.from({ configPath })
        expect(result).toBeInstanceOf(GeoComposer)
        expect(Service.registry.all.length).toBe(1)

    })

    test('Throws when missing service', async () => {

        config_min.services = {}
        const configPath = writeConf('test-conf.json', config_min)

        await expect(async () => await GeoComposer.from({ configPath }))
            .rejects.toThrow('/services must NOT have fewer than 1 properties')
    })

    test('Throws when missing crs', async () => {

        config_min.crs = {}
        const configPath = writeConf('test-conf.json', config_min)

        await expect(async () => await GeoComposer.from({ configPath }))
            .rejects.toThrow('Layer "world" crs "EPSG:4326" is not declared in crs')
    })

    test('Throws when missing sources', async () => {

        config_min.sources = {}
        const configPath = writeConf('test-conf.json', config_min)

        await expect(async () => await GeoComposer.from({ configPath }))
            .rejects.toThrow('/sources must NOT have fewer than 1 properties')
    })

    test('Throws when missing layers', async () => {
        
        config_min.layers = {}
        const configPath = writeConf('test-conf.json', config_min)

        await expect(async () => await GeoComposer.from({ configPath }))
            .rejects.toThrow('/layers must NOT have fewer than 1 properties')
    })

})
