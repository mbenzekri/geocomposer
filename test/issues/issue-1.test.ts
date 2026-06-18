import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GeoComposer } from '../../src/geo-composer.js';
import { Service } from '../../src/service/service.js';
import { Singleton } from '../../src/core/tools.js';
import { Config } from '../../src/config/config.js';
import { writeTestConfig } from '../test-temp.js';

function copyAny(val: any): any {
    return JSON.parse(JSON.stringify(val))
}

function writeConf(filename: string, conf: Record<string, unknown>) {
    return writeTestConfig(filename, conf)
}
const baseConf = {
    server: {
        port: 3000,
        logLevel: "LOG"
    },
    services: { },
    sources: { "world": { type: "geojson", path: "../../data/world.geojson" } },
    layers: { "world": { title: "World layer", source: "world", crs: "EPSG:4326" } },
    projections: { "EPSG:4326": { name: "WGS84", title: "WGS84 coordinate system" } },
}


describe('GeoComposer', () => {
    beforeEach(() => {
        Singleton.delete(Config)
        GeoComposer.clear()
    })

    afterEach(() => {
        Singleton.delete(Config)
        GeoComposer.clear()
    })


    it('rejects config with no declared service', async () => {

        const configPath = writeConf('test-conf.json', baseConf)
        await expect(GeoComposer.from({ configPath }))
            .rejects.toThrow('/services must NOT have fewer than 1 properties')
    })

    it('accepts config without wms when another service is declared', async () => {
        const config = copyAny(baseConf)
        config.services = { api: { title: "Feature API" } }

        const configPath = writeConf('test-api-conf.json', config)
        const result = await GeoComposer.from({ configPath })

        expect(result).toBeInstanceOf(GeoComposer)
        expect(Service.registry.all.map((service) => service.name)).toEqual(['API'])
    })

})
