import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { LoadedConfig } from '../config/config.js'
import { createWmsApp } from '../ogc/wms-server.js'
import { createXyzApp } from '../xyz/xyz-server.js'

export type GeoComposerServer = {
  server: Server
  paths: {
    wms: string
    xyz?: string
  }
  open(): Promise<void>
  close(): Promise<void>
}

export function createGeoComposerServer(loaded: LoadedConfig): GeoComposerServer {
  const wmsPath = normalizePath(loaded.app.path ?? loaded.server.path)
  const xyzPath = loaded.xyz ? normalizePath(loaded.xyz.path ?? '/tiles') : undefined
  const wmsApp = createWmsApp({
    ...loaded.app,
    path: wmsPath
  })
  const xyzApp = loaded.xyz && xyzPath
    ? createXyzApp({
      ...loaded.xyz,
      path: xyzPath
    })
    : undefined

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      sendText(res, 500, message, 'text/plain; charset=utf-8', req.method === 'HEAD')
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === wmsPath) {
      await wmsApp.handle(req, res)
      return
    }

    if (xyzApp && xyzPath && isPathMatch(url.pathname, xyzPath)) {
      await xyzApp.handle(req, res)
      return
    }

    setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', req.method === 'HEAD')
  }

  return {
    server,
    paths: {
      wms: wmsPath,
      ...(xyzPath ? { xyz: xyzPath } : {})
    },

    async open() {},

    async close() {
      await wmsApp.close()
    }
  }
}

function normalizePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized
}

function isPathMatch(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  headOnly = false
): void {
  if (res.headersSent) {
    res.end()
    return
  }

  res.statusCode = statusCode
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(headOnly ? undefined : body)
}
