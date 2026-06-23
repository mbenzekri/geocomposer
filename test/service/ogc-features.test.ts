import { beforeEach, describe, expect, test } from 'vitest'
import { OgcFeatures } from '../../src/service/ogc-features.js'
import { handle, installWorldFixture, json, resetRegistries } from './helpers.js'

beforeEach(() => {
  resetRegistries()
  installWorldFixture()
})

describe('OgcFeatures', () => {
  test('serves landing, OpenAPI, conformance and collections with HEAD support', async () => {
    const api = new OgcFeatures({
      title: 'Features',
      abstract: 'Feature API',
      path: '/api/',
      layers: ['world'],
      supportedCrs: ['EPSG:4326', 'http://www.opengis.net/def/crs/EPSG/0/3857'],
      defaultLimit: 1,
      maxLimit: 3
    })

    expect(api.path).toBe('/api')
    expect(api.matches('/api/collections')).toBe(true)
    expect(api.getSupportedCrs()).toEqual(['EPSG:4326', 'EPSG:3857'])
    expect(json(await handle(api, '/api')).title).toBe('Features')
    expect(json(await handle(api, '/api/api')).openapi).toBe('3.0.3')
    expect(json(await handle(api, '/api/conformance')).conformsTo).toContain('http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core')
    expect((await handle(api, '/api/collections', 'HEAD')).body).toBeUndefined()
  })

  test('serves collection items, feature reads, pagination and CRS/property parameters', async () => {
    const api = new OgcFeatures({ path: '/api', layers: ['world'], defaultLimit: 1, maxLimit: 5 })

    const items = await handle(api, '/api/collections/world/items?limit=1&offset=0&properties=name&bbox=-2,-2,5,5&bbox-crs=EPSG:4326&crs=http://www.opengis.net/def/crs/OGC/1.3/CRS84')
    const body = json(items)
    expect(items.headers.get('content-crs')).toBe('<http://www.opengis.net/def/crs/EPSG/0/4326>')
    expect(body.features).toHaveLength(1)
    expect(body.features[0].properties).toEqual({ name: 'Alpha' })
    expect(body.links.some((link: { rel: string }) => link.rel === 'next')).toBe(true)

    expect(json(await handle(api, '/api/collections/world/items/a?properties=kind')).properties).toEqual({ kind: 'city' })
    expect(json(await handle(api, '/api/collections/world')).extent.spatial.bbox[0]).toEqual([-2, -2, 4, 4])
  })

  test('reports API validation and not-found errors as JSON', async () => {
    const api = new OgcFeatures({ path: '/api', layers: ['world'], defaultLimit: 1, maxLimit: 2, supportedCrs: ['EPSG:4326'] })

    expect((await handle(api, '/other')).statusCode).toBe(404)
    expect((await handle(api, '/api', 'POST')).statusCode).toBe(405)
    expect(json(await handle(api, '/api/unknown')).description).toBe('Unknown API route')
    expect(json(await handle(api, '/api/collections/missing')).description).toContain('Unknown collection')
    expect(json(await handle(api, '/api/collections/world/items?bbox=1,2,3')).description).toContain('bbox must contain')
    expect(json(await handle(api, '/api/collections/world/items?limit=0')).description).toContain('limit must be a positive integer')
    expect(json(await handle(api, '/api/collections/world/items?limit=4')).description).toContain('limit exceeds maximum')
    expect(json(await handle(api, '/api/collections/world/items?offset=-1')).description).toContain('offset must be an integer')
    expect(json(await handle(api, '/api/collections/world/items?crs=EPSG:3857')).description).toContain('crs EPSG:3857 is not supported')
    expect(json(await handle(api, '/api/collections/world/items/missing')).description).toContain('was not found')
    expect(() => new OgcFeatures({ defaultLimit: 3, maxLimit: 2 })).toThrow('defaultLimit must be lower')
    expect(() => new OgcFeatures({ defaultLimit: 0 })).toThrow('defaultLimit must be a positive integer')
    expect(() => new OgcFeatures({ maxLimit: 0 })).toThrow('maxLimit must be a positive integer')
    expect(() => new OgcFeatures({ supportedCrs: ['EPSG:9999'] })).toThrow('API supportedCrs')
  })
})
