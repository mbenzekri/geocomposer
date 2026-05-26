import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { loadConfig } from '../config/config.js'
import { Wms } from '../ogc/wms.js'

const loaded = await loadConfig(resolve(process.cwd(), process.env.CONFIG ?? 'config.json'))
const port = Number.parseInt(process.env.PORT ?? String(loaded.server.port), 10)
const service = new Wms(loaded.wms)

await service.open()

const server = createServer((req, res) => {
  void service.handle(req, res)
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
  const baseUrl = `http://localhost:${port}${service.path}`
  const capabilitiesUrl = `${baseUrl}?SERVICE=WMS&REQUEST=GetCapabilities`
  const sample = `${baseUrl}?SERVICE=WMS&REQUEST=GetMap&LAYERS=world&STYLES=world&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=1024&HEIGHT=512&FORMAT=image/png`
  console.log(`Config: ${loaded.path}`)
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
    void service.close().finally(() => {
      process.exit(0)
    })
  })

  server.closeIdleConnections?.()
  server.closeAllConnections?.()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
