import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Layer } from '../layer/layer.js'
import { getMap } from '../ogc/get-map.js'
import { GpkgSource } from '../source/gpkg-source.js'
import {
  WORLD_BBOX_3857,
  worldStyleFn
} from './world-demo-common.js'

await rm('style-smoke/world_gpkg.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new GpkgSource('world-gpkg', 'data/world.gpkg', {
  tableName: 'world',
  geometryColumn: 'geom'
})
const layer = new Layer('world-gpkg', {
  source,
  styles: [{
    name: 'default',
    style: worldStyleFn
  }],
  pointProperties: []
})

await source.open()
try {
  const image = await getMap({
    layers: [layer],
    styles: [],
    bbox: WORLD_BBOX_3857,
    width: 500,
    height: 500,
    crs: 'EPSG:3857'
  })

  await writeFile('style-smoke/world_gpkg.png', image)
} finally {
  await source.close()
}

console.log('style-smoke/world_gpkg.png generated')
