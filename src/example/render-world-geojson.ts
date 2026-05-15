import { mkdir, rm, writeFile } from 'node:fs/promises'
import { renderGetMap } from '../ogc/render-get-map.js'
import { GeoJsonGeoSource } from '../source/geojson-geo-source.js'
import {
  WORLD_BBOX_3857,
  worldStyleResolver
} from './world-demo-common.js'

await rm('style-smoke/world.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new GeoJsonGeoSource('world', 'data/world.geojson', {
  crs: 'EPSG:4326'
})

await source.open()
try {
  const image = await renderGetMap({
    source,
    bbox: WORLD_BBOX_3857,
    width: 500,
    height: 500,
    crs: 'EPSG:3857',
    styleResolver: worldStyleResolver
  })

  await writeFile('style-smoke/world.png', image)
} finally {
  await source.close()
}

console.log('style-smoke/world.png generated')
