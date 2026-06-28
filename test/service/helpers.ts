import type { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Feature } from '../../src/core/feature.js'
import { Crs } from '../../src/core/crs.js'
import { defaultStyleFn } from '../../src/style/default-style.js'
import { Style } from '../../src/style/style.js'
import { Layer } from '../../src/layer/layer.js'
import { Source } from '../../src/source/source.js'
import { MemSource } from '../../src/source/mem-source.js'
import { Tileset } from '../../src/tileset/tileset.js'
import { TileMatrixSet } from '../../src/tileset/tile-matrix-set.js'
import { Service } from '../../src/service/service.js'

export type TestResponse = ServerResponse & {
  body?: Buffer
  ended: boolean
  headers: Map<string, number | string | string[]>
  markHeadersSent(): void
}

export class TestService extends Service {
  constructor(id: string, path: string) {
    super(id, undefined, undefined, path)
  }

  async handle(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    Service.sendText(res, 200, 'ok', 'text/plain')
  }

  logListening(_baseUrl: string): void {}

  protected logHandleParams(_traceId: number, _request: unknown): void {}
}

export function resetRegistries(): void {
  Service.registry.clear()
  Crs.registry.clear()
  Source.registry.clear()
  Layer.registry.clear()
  Style.registry.clear()
  Tileset.registry.clear()
  TileMatrixSet.build({})
}

export function installWorldFixture(): void {
  Crs.registry.set('EPSG:4326', new Crs('EPSG:4326', 'WGS 84', 'WGS 84'))
  Crs.registry.set('EPSG:3857', new Crs('EPSG:3857', 'Web Mercator', 'Web Mercator'))
  Style.registry.set('default', { id: 'default', title: 'Default', style: defaultStyleFn })
  Style.registry.set('alternate', { id: 'alternate', title: 'Alternate', abstract: 'Alternate style', style: defaultStyleFn })

  Source.registry.set('world', new MemSource('world', [
    feature('a', 'Alpha', [0, 0], { kind: 'city', label_x: 0, label_y: 0 }),
    feature('b', 'Beta', [3, 3], { kind: 'town', label_x: 3, label_y: 3 })
  ]))

  Layer.registry.set('world', new Layer('world', {
    title: 'World layer',
    abstract: 'World layer abstract',
    source: 'world',
    crs: 'EPSG:4326',
    extent: [-2, -2, 4, 4],
    style: 'default',
    pointProperties: [{ x: 'label_x', y: 'label_y' }]
  }))

  Tileset.build({
    worldTiles: {
      title: 'World raster tiles',
      formats: ['image/png'],
      minZoom: 0,
      maxZoom: 1,
      cacheControl: 'public, max-age=60',
      layers: ['world']
    },
    vectorTiles: {
      title: 'World vector tiles',
      formats: ['application/geo+json'],
      minZoom: 0,
      maxZoom: 0,
      layers: ['world']
    }
  })
}

export function feature(
  id: string,
  name: string,
  coordinates: [number, number],
  extra: Record<string, unknown>
): Feature {
  return {
    layer: {} as Feature['layer'],
    type: 'Feature',
    id,
    properties: { name, ...extra },
    geometry: {
      type: 'Point',
      coordinates
    }
  }
}

export function request(
  url: string,
  headers: Record<string, string | string[]> = { host: 'localhost' },
  socket: Socket = new Socket(),
  method = 'GET'
): IncomingMessage {
  return {
    method,
    url,
    headers,
    socket
  } as IncomingMessage
}

export function response(): TestResponse {
  const headers = new Map<string, number | string | string[]>()
  const chunks: Buffer[] = []
  let headersSent = false
  return {
    statusCode: 200,
    ended: false,
    headers,
    get headersSent() {
      return headersSent
    },
    markHeadersSent() {
      headersSent = true
    },
    setHeader(name: string, value: number | string | string[]) {
      headers.set(name.toLowerCase(), value)
      return this
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase())
    },
    end(chunk?: string | Buffer) {
      headersSent = true
      this.ended = true
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        this.body = Buffer.concat(chunks)
      }
      return this
    }
  } as TestResponse
}

export async function handle(
  service: { handle(req: IncomingMessage, res: ServerResponse): Promise<void> },
  url: string,
  method = 'GET'
): Promise<TestResponse> {
  const req = request(url, { host: 'localhost' }, new Socket(), method)
  const res = response()
  await service.handle(req, res)
  return res
}

export function json(res: TestResponse): any {
  return JSON.parse(res.body?.toString() ?? '{}')
}
