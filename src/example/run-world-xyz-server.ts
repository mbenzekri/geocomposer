import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { loadConfig } from '../config/config.js'
import { createXyzApp } from '../xyz/xyz-server.js'

const loaded = await loadConfig(resolve(process.cwd(), process.env.CONFIG ?? 'config.json'))
const port = Number.parseInt(process.env.PORT ?? String(loaded.server.port), 10)

if (!loaded.xyz) {
  throw new Error('No "xyz" service is configured in config.json')
}

const app = createXyzApp(loaded.xyz)

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
  const baseUrl = `http://localhost:${port}${loaded.xyz?.path ?? '/tiles'}`
  const sampleLayer = loaded.xyz?.layers[0]?.name ?? 'world'
  const sample = `${baseUrl}/${encodeURIComponent(sampleLayer)}/1/1/1.png`
  const retinaSample = `${baseUrl}/${encodeURIComponent(sampleLayer)}/1/1/1@2x.png`
  console.log(`Config: ${loaded.path}`)
  console.log(`XYZ listening on ${baseUrl}`)
  console.log(`Sample tile: ${sample}`)
  console.log(`Retina sample: ${retinaSample}`)
})

const shutdown = (signal: string) => {
  if (shuttingDown) {
    for (const socket of sockets) {
      socket.destroy()
    }
    process.exit(1)
  }

  shuttingDown = true
  console.log(`Stopping XYZ server (${signal})...`)

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
