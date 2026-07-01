import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Layer } from '../../src/layer/layer.js'
import { Style } from '../../src/style/style.js'
import { Wms } from '../../src/service/wms.js'
import { getMap } from '../../src/ogc/get-map.js'
import { handle, installWorldFixture, resetRegistries } from './helpers.js'

vi.mock('../../src/ogc/get-map.js', () => ({
  getMap: vi.fn(async () => Buffer.from('png-tile'))
}))

beforeEach(() => {
  vi.mocked(getMap).mockClear()
  resetRegistries()
  installWorldFixture()
})

describe('Wms', () => {
  test('serves capabilities, validates service/method/path and supports HEAD GetMap', async () => {
    const wms = new Wms({
      title: 'World WMS',
      abstract: 'World abstract',
      path: '/wms/',
      onlineResource: 'https://published.test/wms',
      supportedCrs: ['EPSG:4326', 'EPSG:3857'],
      layers: ['world'],
      maxWidth: 512,
      maxHeight: 512
    })

    expect(wms.path).toBe('/wms')
    expect(wms.getLayers().map((layer) => layer.id)).toEqual(['world'])
    expect(wms.getSupportedCrs()).toEqual(['EPSG:4326', 'EPSG:3857'])

    const caps = await handle(wms, '/wms?SERVICE=WMS&REQUEST=GetCapabilities')
    expect(caps.statusCode).toBe(200)
    expect(caps.headers.get('content-type')).toContain('text/xml')
    expect(caps.body?.toString()).toContain('<Name>world</Name>')
    expect(caps.body?.toString()).toContain('<Format>image/jpeg</Format>')
    expect(caps.body?.toString()).toContain('<Format>image/webp</Format>')
    expect(caps.body?.toString()).toContain('https://published.test/wms')

    expect((await handle(wms, '/wms', 'POST')).statusCode).toBe(405)
    expect((await handle(wms, '/other')).statusCode).toBe(404)
    expect((await handle(wms, '/wms?SERVICE=WMTS')).body?.toString()).toContain('SERVICE must be WMS')

    const head = await handle(wms, '/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=world&STYLES=&CRS=EPSG:4326&BBOX=-10,-20,10,20&WIDTH=256&HEIGHT=128&FORMAT=image/png&DPI=180', 'HEAD')
    expect(head.statusCode).toBe(200)
    expect(head.body).toBeUndefined()
    expect(head.headers.get('content-type')).toBe('image/png')
    expect(vi.mocked(getMap)).toHaveBeenCalledWith(expect.objectContaining({
      layers: [Layer.registry.get('world')],
      width: 256,
      height: 128,
      format: 'image/png',
      pixelRatio: 2
    }))
  })

  test('parses GetMap styles and reports invalid map requests as WMS errors', async () => {
    const wms = new Wms({ path: '/wms', layers: ['world'], supportedCrs: ['EPSG:4326'], maxWidth: 100, maxHeight: 100 })

    const ok = await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=alternate&CRS=EPSG:4326&BBOX=-20,-10,20,10&WIDTH=64&HEIGHT=64&FORMAT=image/png&FORMAT_OPTIONS=dpi:135')
    expect(ok.statusCode).toBe(200)
    expect(ok.body?.toString()).toBe('png-tile')
    expect(vi.mocked(getMap)).toHaveBeenLastCalledWith(expect.objectContaining({
      styles: [Style.registry.get('alternate').style],
      format: 'image/png',
      pixelRatio: 1.5
    }))

    const jpeg = await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10&FORMAT=image/jpeg&TRANSPARENT=true')
    expect(jpeg.statusCode).toBe(200)
    expect(jpeg.headers.get('content-type')).toBe('image/jpeg')
    expect(vi.mocked(getMap)).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'image/jpeg'
    }))

    const webp = await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10&FORMAT=image/webp')
    expect(webp.statusCode).toBe(200)
    expect(webp.headers.get('content-type')).toBe('image/webp')
    expect(vi.mocked(getMap)).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'image/webp'
    }))

    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).body?.toString()).toContain('LAYERS is required')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=a,b&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).body?.toString()).toContain('STYLES must include one entry')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10&FORMAT=image/gif')).body?.toString()).toContain('Unsupported FORMAT')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=&CRS=EPSG:3857&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).body?.toString()).toContain('CRS EPSG:3857 is not supported')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).statusCode).toBe(200)
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=missing&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).body?.toString()).toContain('Unknown layer: missing')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).body?.toString()).toContain('CRS is required')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&STYLES=missing&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10')).body?.toString()).toContain('Unknown style &quot;missing&quot;')
    expect((await handle(wms, '/wms?REQUEST=GetMap&LAYERS=world&CRS=EPSG:4326&BBOX=-1,-1,1,1&WIDTH=10&HEIGHT=10&DPI=0')).body?.toString()).toContain('WMS DPI must be a positive number')
    expect((await handle(wms, '/wms', 'OPTIONS')).statusCode).toBe(204)

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    new Wms({ path: '/wms', layers: ['world'], supportedCrs: [] }).logListening('http://localhost')
    expect(log).toHaveBeenCalledWith('[WMS] GetMap : http://localhost/wms?SERVICE=WMS&REQUEST=GetMap')
    log.mockRestore()
  })

  test('serves GetFeatureInfo JSON and validates query layer constraints', async () => {
    const wms = new Wms({ path: '/wms', layers: ['world'] })
    const base = '/wms?REQUEST=GetFeatureInfo&LAYERS=world&STYLES=&CRS=EPSG:4326&BBOX=-5,-5,5,5&WIDTH=100&HEIGHT=100&FORMAT=image/png'

    const info = await handle(wms, `${base}&QUERY_LAYERS=world&I=50&J=50&FEATURE_COUNT=2&BUFFER=4&INFO_FORMAT=application/geo%2Bjson`)
    expect(info.statusCode).toBe(200)
    expect(info.headers.get('content-type')).toContain('application/geo+json')
    expect(info.body?.toString()).toContain('FeatureCollection')

    expect((await handle(wms, `${base}&QUERY_LAYERS=`)).body?.toString()).toContain('QUERY_LAYERS is required')
    expect((await handle(wms, `${base}&QUERY_LAYERS=missing&I=1&J=1`)).body?.toString()).toContain('must also be present in LAYERS')
    expect((await handle(wms, '/wms?REQUEST=DescribeLayer')).body?.toString()).toContain('Unsupported REQUEST')
    expect(() => new Wms({ supportedCrs: ['EPSG:9999'] })).toThrow('WMS supportedCrs')
  })
})
