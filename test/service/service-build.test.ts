import { beforeEach, describe, expect, test } from 'vitest'
import { OgcFeatures } from '../../src/service/ogc-features.js'
import { Service } from '../../src/service/service-build.js'
import { Wms } from '../../src/service/wms.js'
import { Wmts } from '../../src/service/wmts.js'
import { Xyz } from '../../src/service/xyz.js'
import { installWorldFixture, resetRegistries } from './helpers.js'

beforeEach(() => {
  resetRegistries()
  installWorldFixture()
})

describe('service-build', () => {
  test('builds all configured service types', () => {
    const registry = Service.build({
      wms: { path: '/wms', layers: ['world'] },
      api: { path: '/api', layers: ['world'] },
      xyz: { path: '/xyz', tilesets: ['worldTiles'] },
      wmts: { path: '/wmts', tilesets: ['worldTiles'] }
    })

    expect(registry.get('wms')).toBeInstanceOf(Wms)
    expect(registry.get('api')).toBeInstanceOf(OgcFeatures)
    expect(registry.get('xyz')).toBeInstanceOf(Xyz)
    expect(registry.get('wmts')).toBeInstanceOf(Wmts)
  })
})
