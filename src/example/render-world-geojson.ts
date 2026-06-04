import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Layer } from '../layer/layer.js'
import { getMap } from '../ogc/get-map.js'
import { GeoJsonSource } from '../source/geojson-source.js'
import {
  WORLD_BBOX_3857,
  worldStyleFn
} from './world-demo-common.js'

await rm('style-smoke/world.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new GeoJsonSource('world', 'data/world.geojson', {
  crs: 'EPSG:4326'
})
const layer = new Layer('world', {
  source,
  styles: [{
    name: 'default',
    style: worldStyleFn
  }],
  pointProperties: []
})

const image = await getMap({
  layers: [layer],
  styles: [],
  bbox: WORLD_BBOX_3857,
  width: 500,
  height: 500,
  crs: 'EPSG:3857'
})

await writeFile('style-smoke/world.png', image)

console.log('style-smoke/world.png generated')
