import { parentPort, workerData } from 'node:worker_threads'
import { Crs } from '../core/crs.js'
import { DEFAULT_RTREE_CHUNK_SIZE } from '../index/index-rtree.js'
import { Layer } from '../layer/layer.js'
import { Style } from '../style/style.js'
import { GeoJsonSource } from './geojson-source.js'
import { Source } from './source.js'
import type { ClusteredWorkerSourceConfig, SourceIndexConfig } from './source.js'

type ClusteredWorkerMessage = {
  sourceId: string
  filePath: string
  crs: string
  force: boolean
  source: ClusteredWorkerSourceConfig
}

const message = workerData as ClusteredWorkerMessage

try {
  if (message.source.type !== 'geojson') throw new Error(`Unsupported clustered worker source type "${message.source.type}"`)

  Crs.registry.set(message.crs, new Crs(message.crs, message.crs, message.crs))
  Style.registry.set('default', { id: 'default', style: () => null })

  const indexes: SourceIndexConfig = {
    rtree: {
      chunkSize: DEFAULT_RTREE_CHUNK_SIZE,
      clustered: true
    }
  }
  const source = new GeoJsonSource(
    message.sourceId,
    message.filePath,
    message.source.encoding,
    message.source.highWaterMark,
    undefined,
    { gzip: true, indexes }
  )
  Source.registry.set(source.id, source)
  const layer = new Layer(message.sourceId, {
    source: source.id,
    crs: message.crs
  })

  await source.prepareClusteredIndexSource(layer, message.force)
  parentPort?.postMessage({ ok: true })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}
