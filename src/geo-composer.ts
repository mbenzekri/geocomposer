import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { loadConfig } from './config/config.js'
import { createGeoComposerServer } from './server/geo-composer-server.js'

const loaded = await loadConfig(resolve(process.cwd(), process.env.CONFIG ?? 'config.json'))
const port = parsePort(process.env.PORT, loaded.server.port)
const app = createGeoComposerServer(loaded)

await app.open()

const sockets = new Set<Socket>()
let shuttingDown = false

app.server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => {
    sockets.delete(socket)
  })
})

app.server.listen(port, () => {
  const baseUrl = `http://localhost:${port}`
  console.log(`Config: ${loaded.path}`)
  console.log(`WMS listening on ${baseUrl}${app.paths.wms}`)
  console.log(`GetCapabilities: ${baseUrl}${app.paths.wms}?SERVICE=WMS&REQUEST=GetCapabilities`)

  if (app.paths.xyz && loaded.xyz) {
    console.log(`XYZ listening on ${baseUrl}${app.paths.xyz}`)

    const sampleLayer = loaded.xyz.layers[0]?.name
    if (sampleLayer) {
      console.log(`Sample tile: ${baseUrl}${app.paths.xyz}/${encodeURIComponent(sampleLayer)}/1/1/1.png`)
      console.log(`Retina sample: ${baseUrl}${app.paths.xyz}/${encodeURIComponent(sampleLayer)}/1/1/1@2x.png`)
    }
  }
})

const shutdown = (signal: string) => {
  if (shuttingDown) {
    for (const socket of sockets) {
      socket.destroy()
    }
    process.exit(1)
  }

  shuttingDown = true
  console.log(`Stopping GeoComposer server (${signal})...`)

  const forceClose = setTimeout(() => {
    app.server.closeAllConnections?.()
    for (const socket of sockets) {
      socket.destroy()
    }
  }, 1000)

  app.server.close(() => {
    clearTimeout(forceClose)
    void app.close().finally(() => {
      process.exit(0)
    })
  })

  app.server.closeIdleConnections?.()
  app.server.closeAllConnections?.()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback

  const port = Number.parseInt(value, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`)
  }

  return port
}
