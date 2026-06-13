import type { Registry } from '../core/tools.js'
import { Service } from './service.js'
import { Wms, type WmsJson } from './wms.js'
import { Wmts, type WmtsJson } from './wmts.js'
import { Xyz, type XyzJson } from './xyz.js'

export { Service } from './service.js'

export type ServicesJson = {
    wms: WmsJson
    xyz?: XyzJson
    wmts?: WmtsJson
}

Service.createAll = function createAll(services: ServicesJson,baseDir: string): Registry<Service> {

    const wms = Wms.fromConfig(services.wms)
    Service.registry.set('wms', wms)

    if (services.xyz) {
        const xyz = Xyz.fromConfig(services.xyz, baseDir)
        Service.registry.set('xyz', xyz)
    }

    if (services.wmts) {
        const wmts = Wmts.fromConfig(services.wmts, baseDir)
        Service.registry.set('wmts', wmts)
    }
    
    return Service.registry
}
