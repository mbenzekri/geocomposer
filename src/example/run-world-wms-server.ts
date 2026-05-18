import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { GeoJsonSource } from '../source/geojson-source.js'
import { createWmsApp } from '../ogc/wms-server.js'
import { worldStyleFn } from './world-demo-common.js'

const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const app = createWmsApp({
  service: {
    title: 'GeoComposer WMS',
    abstract: 'Minimal WMS server backed by the GeoComposer render pipeline.'
  },
  layers: [
    {
      name: 'world',
      title: 'World',
      source: new GeoJsonSource('world', 'data/world.geojson', {
        crs: 'EPSG:4326'
      }),
      style: worldStyleFn
    }
  ]
})

await app.open()

const server = createServer((req, res) => {
  void app.handle(req, res)
})
const sockets = new Set<Socket>()
let shuttingDown = false

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => {
    sockets.delete(socket)
  })
})

server.listen(port, () => {
  const baseUrl = `http://localhost:${port}/wms`
  const capabilitiesUrl = `${baseUrl}?SERVICE=WMS&REQUEST=GetCapabilities`
  const sample = `${baseUrl}?SERVICE=WMS&REQUEST=GetMap&LAYERS=world&CRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=1024&HEIGHT=512&FORMAT=image/png`
  console.log(`WMS listening on ${baseUrl}`)
  console.log(`GetCapabilities: ${capabilitiesUrl}`)
  console.log(`Sample GetMap: ${sample}`)
})

const shutdown = (signal: string) => {
  if (shuttingDown) {
    for (const socket of sockets) {
      socket.destroy()
    }
    process.exit(1)
  }

  shuttingDown = true
  console.log(`Stopping WMS server (${signal})...`)

  const forceClose = setTimeout(() => {
    server.closeAllConnections?.()
    for (const socket of sockets) {
      socket.destroy()
    }
  }, 1000)

  server.close(() => {
    clearTimeout(forceClose)
    void app.close().finally(() => {
      process.exit(0)
    })
  })

  server.closeIdleConnections?.()
  server.closeAllConnections?.()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
