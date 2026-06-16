import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, test } from 'vitest'
import { GeoComposer } from '../../src/geo-composer.js'
import { Service } from '../../src/service/service-build.js'
import { CatalogPage } from '../../src/service/catalog-page.js'
import { Source } from '../../src/source/source-build.js'

describe('configuration and startup', () => {
  test('config_red validates and opens/closes sources without external services', async () => {
    const app = await GeoComposer.from({
      configPath: resolve('config/config_red.json'),
      port: 0
    })

    try {
      await app.open()

      expect(Service.registry.has('wms')).toBe(true)
      expect(Service.registry.has('api')).toBe(true)
      expect(Service.registry.get('api').path).toBe('/api')
      expect(sourceFilePath('world')).toBe(resolve('data/world.geojson'))
      expect(sourceFilePath('capitals')).toBe(resolve('data/capitals.geojson'))

      const catalogResponse = await requestCatalog('/')
      expect(catalogResponse.statusCode).toBe(200)
      expect(catalogResponse.headers.get('content-type')).toContain('text/html')
      expect(catalogResponse.body).toContain("Types d'objets")
      expect(catalogResponse.body).toContain('data-type-id="services"')
      expect(catalogResponse.body).toContain('data-object-id="wms"')
      expect(catalogResponse.body).toContain('class="object-card"')
      expect(catalogResponse.body).toContain('class="copy-button"')
      expect(catalogResponse.body).toContain('URLs exemples')
      expect(catalogResponse.body).toContain('/api/collections')
      expect(catalogResponse.body).toContain('world')
      expect(catalogResponse.body).toContain('World Red')
      expect(catalogResponse.body).toContain('EPSG:4326')
      expect(catalogResponse.body).not.toContain('data/world.geojson')
      expect(catalogResponse.body).not.toContain('data/capitals.geojson')

      const collections = await requestJson('/api/collections')
      expect(collections.collections).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'world' }),
        expect.objectContaining({ id: 'capitals' })
      ]))

      const itemsResponse = await requestApi('/api/collections/world/items?limit=2&offset=1&bbox=-180,-90,180,90')
      expect(itemsResponse.statusCode).toBe(200)
      expect(itemsResponse.headers.get('content-type')).toContain('application/geo+json')
      expect(itemsResponse.headers.get('content-crs')).toBe('<http://www.opengis.net/def/crs/EPSG/0/4326>')

      const items = JSON.parse(itemsResponse.body) as {
        numberReturned: number
        features: Array<Record<string, unknown>>
      }
      expect(items.numberReturned).toBe(2)
      expect(items.features).toHaveLength(2)
      expect(items.features[0]).not.toHaveProperty('layer')
      expect(items.features[0]).not.toHaveProperty('sourceRef')
      expect(items.features[0]).not.toHaveProperty('crs')

      const featureId = String(items.features[0].id)
      const feature = await requestJson(`/api/collections/world/items/${encodeURIComponent(featureId)}`)
      expect(feature).toEqual(expect.objectContaining({
        type: 'Feature',
        id: featureId
      }))
    } finally {
      await app.close()
    }

    expect(app.server.listening).toBe(false)
  })
})

function sourceFilePath(name: string): string {
  const source = Source.registry.get(name) as unknown as { getFiles(): readonly { path: unknown }[] }
  return String(source.getFiles()[0]?.path)
}

async function requestJson(url: string): Promise<Record<string, unknown>> {
  const response = await requestApi(url)
  expect(response.statusCode).toBe(200)
  return JSON.parse(response.body) as Record<string, unknown>
}

async function requestApi(url: string): Promise<TestResponse> {
  const service = Service.registry.get('api')
  const req = {
    method: 'GET',
    url,
    headers: {
      host: 'localhost'
    },
    socket: {}
  } as IncomingMessage
  const res = new TestResponse()

  await service.handle(req, res as unknown as ServerResponse)
  return res
}

async function requestCatalog(url: string, method = 'GET'): Promise<TestResponse> {
  const req = {
    method,
    url,
    headers: {
      host: 'localhost'
    },
    socket: {}
  } as IncomingMessage
  const res = new TestResponse()

  await new CatalogPage().handle(req, res as unknown as ServerResponse)
  return res
}

class TestResponse {
  statusCode = 200
  headersSent = false
  readonly headers = new Map<string, string>()
  body = ''

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
    return this
  }

  end(chunk?: string | Buffer): this {
    this.headersSent = true
    if (chunk !== undefined) {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    }
    return this
  }
}
