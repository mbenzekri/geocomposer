import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Xyz } from '../../src/service/xyz.js'
import { getMap } from '../../src/ogc/get-map.js'
import { getVectorTile } from '../../src/tileset/vector-tile.js'
import { testTempPath } from '../test-temp.js'
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

describe('Xyz', () => {
  test('serves raster and vector tiles, validates paths, methods and scale', async () => {
    const xyz = new Xyz({ path: '/xyz/', tilesets: ['worldTiles', 'vectorTiles'], maxScaleFactor: 3 })

    expect(xyz.path).toBe('/xyz')
    expect(xyz.matches('/xyz/worldTiles/0/0/0.png')).toBe(true)
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0@2x.png')).body?.toString()).toBe('png-tile')
    expect(vi.mocked(getMap)).toHaveBeenCalledWith(expect.objectContaining({ width: 512, height: 512, pixelRatio: 2, format: 'image/png' }))
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0.webp')).body?.toString()).toBe('png-tile')
    expect(vi.mocked(getMap)).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'image/webp' }))
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0.png?scale=3', 'HEAD')).body).toBeUndefined()
    expect((await handle(xyz, '/xyz/vectorTiles/0/0/0.geojson')).body?.toString()).toBe('vector-tile')
    expect(vi.mocked(getVectorTile)).toHaveBeenCalledWith(expect.objectContaining({ format: 'application/geo+json' }))

    expect((await handle(xyz, '/wrong')).statusCode).toBe(404)
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0.png', 'DELETE')).statusCode).toBe(405)
    expect((await handle(xyz, '/xyz/worldTiles/0/0')).body?.toString()).toContain('XYZ tile path must be')
    expect((await handle(xyz, '/xyz/missing/0/0/0.png')).body?.toString()).toContain('Unknown XYZ tileset')
    expect((await handle(xyz, '/xyz/worldTiles/z/0/0.png')).body?.toString()).toContain('z must be a non-negative integer')
    expect((await handle(xyz, '/xyz/worldTiles/0/0/nope.png')).body?.toString()).toContain('y must be an integer')
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0.png?scale=0')).body?.toString()).toContain('scale must be a positive number')
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0@4x.png')).body?.toString()).toContain('scale exceeds maximum')
    expect((await handle(xyz, '/xyz/vectorTiles/0/0/0@2x.geojson')).body?.toString()).toContain('Vector XYZ tiles do not support')
    expect(() => new Xyz({ maxScaleFactor: 0 })).toThrow('XYZ maxScaleFactor must be a positive number')
    expect((await handle(xyz, '/xyz', 'OPTIONS')).statusCode).toBe(204)

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    xyz.logListening('http://localhost')
    expect(log).toHaveBeenCalledWith('[XYZ] listening on: http://localhost/xyz')
    expect(log).toHaveBeenCalledWith('[XYZ] Get Tile: http://localhost/xyz/worldTiles/1/1/1.png')
    log.mockRestore()
  })

  test('uses tile cache on repeated raster requests', async () => {
    const xyz = new Xyz({ path: '/xyz', tilesets: ['worldTiles'], cache: testTempPath('xyz-cache') })

    expect((await handle(xyz, '/xyz/worldTiles/0/0/0.png')).body?.toString()).toBe('png-tile')
    expect((await handle(xyz, '/xyz/worldTiles/0/0/0.png')).body?.toString()).toBe('png-tile')
    expect(vi.mocked(getMap)).toHaveBeenCalledTimes(1)
  })
})
