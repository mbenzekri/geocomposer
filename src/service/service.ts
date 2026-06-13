import { CrsCode } from '../core/geometry.js'
import { Registry } from '../core/tools.js'
import type { Layer } from '../layer/layer.js'
import type { Tileset } from '../tileset/tileset.js'
import { Service } from './service-base.js'
import { Wms, type WmsJson } from './wms.js'
import { Wmts, type WmtsJson } from './wmts.js'
import { Xyz, type XyzJson } from './xyz.js'

export { Service } from './service-base.js'

export type ServicesJson = {
    wms: WmsJson
    xyz?: XyzJson
    wmts?: WmtsJson
}

Service.createAll = function createAll(
    services: ServicesJson,
    baseDir: string,
    crsReg: Registry<CrsCode>,
    lyrReg: Registry<Layer>,
    tsetReg: Registry<Tileset>
): Registry<Service> {
    const svcReg = new Registry<Service>('SERVICES')

    const wms = Wms.fromConfig(services.wms, crsReg.all, lyrReg)

    svcReg.set('wms', wms)
    if (services.xyz) {
        const xyz = Xyz.fromConfig(services.xyz, baseDir, tsetReg)
        svcReg.set('xyz', xyz)
    }

    if (services.wmts) {
        const wmts = Wmts.fromConfig(services.wmts, baseDir, tsetReg)
        svcReg.set('wmts', wmts)
    }
    return svcReg
}
