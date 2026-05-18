import { mkdir, rm, writeFile } from 'node:fs/promises'
import { renderMap } from '../ogc/render-map.js'
import { GmlSource } from '../source/gml-source.js'
import {
  WORLD_BBOX_3857,
  worldStyleFn
} from './world-demo-common.js'

await rm('style-smoke/world_gml.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new GmlSource('world-gml', 'data/world.gml', {
  crs: 'EPSG:4326',
  axisOrder: 'auto'
})

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

  await writeFile('style-smoke/world_gml.png', image)
} finally {
  await source.close()
}

console.log('style-smoke/world_gml.png generated')
