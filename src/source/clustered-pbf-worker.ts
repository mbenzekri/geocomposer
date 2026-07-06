import { parentPort, workerData } from 'node:worker_threads'
import { Crs, type CrsJson } from '../core/crs.js'
import { DEFAULT_RTREE_CHUNK_SIZE } from '../index/index-rtree.js'
import { Layer } from '../layer/layer.js'
import { Style } from '../style/style.js'
import { GeoJsonSource } from './geojson-source.js'
import { Source } from './source.js'
import type { ClusteredWorkerSourceConfig, SourceIndexConfig } from './source.js'

type ClusteredWorkerMessage = {
  sourceId: string
  filePath: string
  progressContext: string
  crs: CrsJson & { code: string }
  force: boolean
  source: ClusteredWorkerSourceConfig
}

const message = workerData as ClusteredWorkerMessage

try {
  if (message.source.type !== 'geojson') throw new Error(`Unsupported clustered worker source type "${message.source.type}"`)

  const crs = Crs.fromConfig(message.crs.code, message.crs)
  Crs.registry.set(crs.code, crs)
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
  source.clusteredProgressContext = message.progressContext
  Source.registry.set(source.id, source)
  const layer = new Layer(message.sourceId, {
    source: source.id,
    crs: message.crs.code
  })

  await source.prepareClusteredIndexSource(layer, message.force)
  parentPort?.postMessage({ ok: true })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}
