import { mkdir, rm, writeFile } from 'node:fs/promises'
import { renderMap } from '../ogc/render-map.js'
import { ShpSource } from '../source/shp-source.js'
import {
  WORLD_BBOX_3857,
  worldStyleFn
} from './world-demo-common.js'

await rm('style-smoke/world_shp.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new ShpSource(
  'world-shp',
  'data/shapefile/world.shp',
  'data/shapefile/world.dbf'
)

await source.open()
try {
  const image = await renderMap({
    source,
    bbox: WORLD_BBOX_3857,
    width: 500,
    height: 500,
    crs: 'EPSG:3857',
    style: worldStyleFn
  })

  await writeFile('style-smoke/world_shp.png', image)
} finally {
  await source.close()
}

console.log('style-smoke/world_shp.png generated')
