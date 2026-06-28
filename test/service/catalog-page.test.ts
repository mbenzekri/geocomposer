import { beforeEach, describe, expect, test } from 'vitest'
import { Layer } from '../../src/layer/layer.js'
import { Style } from '../../src/style/style.js'
import { CatalogPage } from '../../src/service/catalog-page.js'
import '../../src/service/service-build.js'
import { Service } from '../../src/service/service.js'
import { Wms } from '../../src/service/wms.js'
import { handle, installWorldFixture, request, resetRegistries, TestService } from './helpers.js'

beforeEach(() => {
  resetRegistries()
  installWorldFixture()
})

describe('CatalogPage', () => {
  test('renders services, layers, styles, CRS and tilesets', () => {
    Service.build({
      wms: { path: '/wms', onlineResource: 'https://published.test/wms', layers: ['world'] },
      api: { path: '/api', layers: ['world'] },
      xyz: { path: '/xyz', tilesets: ['worldTiles'] },
      wmts: { path: '/wmts', tilesets: ['worldTiles'] }
    })
    Service.registry.set('custom', new TestService('custom', '/custom'))

    const catalog = new CatalogPage()
    const html = catalog.renderHtml(request('/', { host: 'catalog.test' }))

    expect(catalog.matches('/')).toBe(true)
    expect(catalog.matches('/index.html')).toBe(true)
    expect(catalog.matches('/catalog')).toBe(false)
    expect(html).toContain('Services (5)')
    expect(html).toContain('OnlineResource configuree')
    expect(html).toContain('/custom')
    expect(html).toContain('Layers (1)')
    expect(html).toContain('Styles (2)')
    expect(html).toContain('CRS (2)')
    expect(html).toContain('Tilesets (2)')
    expect(html).toContain('GetFeatureInfo exemple')
    expect(html).toContain('/xyz/worldTiles/1/1/1.png')
    expect(html).toContain('label_x/label_y')
  })

  test('handles HTTP methods and empty/sparse registries', async () => {
    const catalog = new CatalogPage()
    expect((await handle(catalog, '/', 'GET')).headers.get('content-type')).toContain('text/html')
    expect((await handle(catalog, '/index.html', 'HEAD')).body).toBeUndefined()
    expect((await handle(catalog, '/', 'OPTIONS')).statusCode).toBe(204)
    expect((await handle(catalog, '/', 'POST')).statusCode).toBe(405)

    resetRegistries()
    const empty = catalog.renderHtml(request('/'))
    expect(empty).toContain('Aucun objet disponible')
    expect(empty).toContain('Services (0)')

    installWorldFixture()
    Service.registry.set('wms', new Wms({ path: '/wms', layers: [] }))
    Style.registry.clear()
    const sparse = catalog.renderHtml(request('/'))
    expect(sparse).toContain('API non configuree')
    expect(sparse).toContain('Aucun</span>')

    resetRegistries()
    installWorldFixture()
    Layer.registry.set('plain', new Layer('plain', {
      source: 'world',
      crs: 'EPSG:4326',
      style: 'default'
    }))
    expect(catalog.renderHtml(request('/'))).toContain('Aucune</span>')
  })
})
