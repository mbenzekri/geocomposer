import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Wmts } from '../../src/service/wmts.js'
import { getMap } from '../../src/ogc/get-map.js'
import { getVectorTile } from '../../src/tileset/vector-tile.js'
import { handle, installWorldFixture, resetRegistries } from './helpers.js'

vi.mock('../../src/ogc/get-map.js', () => ({
  getMap: vi.fn(async () => Buffer.from('png-tile'))
}))

vi.mock('../../src/tileset/vector-tile.js', () => ({
  getVectorTile: vi.fn(async () => Buffer.from('vector-tile'))
}))

beforeEach(() => {
  vi.mocked(getMap).mockClear()
  vi.mocked(getVectorTile).mockClear()
  resetRegistries()
  installWorldFixture()
})

describe('Wmts', () => {
  test('serves capabilities and tiles with validation errors', async () => {
    const wmts = new Wmts({
      title: 'Tiles',
      path: '/wmts/',
      onlineResource: 'https://published.test/wmts',
      tilesets: ['worldTiles', 'vectorTiles']
    })

    expect(wmts.path).toBe('/wmts')
    expect(wmts.tilesets.map((tileset) => tileset.id)).toEqual(['worldTiles', 'vectorTiles'])
    expect((await handle(wmts, '/wmts?SERVICE=WMTS&REQUEST=GetCapabilities')).body?.toString()).toContain('<ows:Identifier>worldTiles</ows:Identifier>')
    expect((await handle(wmts, '/wmts?REQUEST=GetCapabilities', 'HEAD')).body).toBeUndefined()
    expect((await handle(wmts, '/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=worldTiles&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX=0&TILEROW=0&TILECOL=0&FORMAT=image/png')).body?.toString()).toBe('png-tile')
    expect((await handle(wmts, '/wmts?REQUEST=GetTile&LAYER=vectorTiles&STYLE=default&TILEMATRIXSET=WebMercatorQuad&TILEMATRIX=0&TILEROW=0&TILECOL=0&FORMAT=application/geo%2Bjson')).body?.toString()).toBe('vector-tile')

    expect((await handle(wmts, '/wrong')).statusCode).toBe(404)
    expect((await handle(wmts, '/wmts', 'PATCH')).statusCode).toBe(405)
    expect((await handle(wmts, '/wmts?SERVICE=WMS')).body?.toString()).toContain('SERVICE must be WMTS')
    expect((await handle(wmts, '/wmts?REQUEST=Unknown')).body?.toString()).toContain('Unsupported REQUEST')
    expect((await handle(wmts, '/wmts?REQUEST=GetTile')).body?.toString()).toContain('Missing required parameter LAYER')
    expect((await handle(wmts, '/wmts?REQUEST=GetTile&LAYER=missing')).body?.toString()).toContain('Unknown WMTS layer')
    expect((await handle(wmts, '/wmts?REQUEST=GetTile&LAYER=worldTiles&VERSION=2.0.0')).body?.toString()).toContain('VERSION must be 1.0.0')
    expect((await handle(wmts, '/wmts?REQUEST=GetTile&LAYER=worldTiles&STYLE=night')).body?.toString()).toContain('STYLE must be default')
    expect((await handle(wmts, '/wmts?REQUEST=GetTile&LAYER=worldTiles&STYLE=default&TILEMATRIXSET=Other')).body?.toString()).toContain('TILEMATRIXSET must be WebMercatorQuad')
    expect(() => new Wmts({ tilesets: ['missing'] })).toThrow('Unknown tileset "missing"')
  })
})
