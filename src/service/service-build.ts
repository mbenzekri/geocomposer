import type { Registry } from '../core/tools.js'
import { OgcFeatures } from './ogc-features.js'
import { Service, type ServicesJson } from './service.js'
import { Wms } from './wms.js'
import { Wmts } from './wmts.js'
import { Xyz } from './xyz.js'

Service.build = function build(services: ServicesJson): Registry<Service> {
    if (services.wms) {
        const wms = Wms.fromConfig(services.wms)
        Service.registry.set('wms', wms)
    }

    if (services.api) {
        const api = OgcFeatures.fromConfig(services.api)
        Service.registry.set('api', api)
    }

    if (services.xyz) {
        const xyz = Xyz.fromConfig(services.xyz)
        Service.registry.set('xyz', xyz)
    }

    if (services.wmts) {
        const wmts = Wmts.fromConfig(services.wmts)
        Service.registry.set('wmts', wmts)
    }
    
    return Service.registry
}
