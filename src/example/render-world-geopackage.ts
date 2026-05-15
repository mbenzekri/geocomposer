import { mkdir, rm, writeFile } from 'node:fs/promises'
import { renderGetMap } from '../ogc/render-get-map.js'
import { GeoPackageGeoSource } from '../source/geopackage-geo-source.js'
import {
  WORLD_BBOX_3857,
  worldStyleResolver
} from './world-demo-common.js'

await rm('style-smoke/world_gpkg.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const source = new GeoPackageGeoSource('world-gpkg', 'data/world.gpkg', {
  tableName: 'world',
  geometryColumn: 'geom'
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

  await writeFile('style-smoke/world_gpkg.png', image)
} finally {
  await source.close()
}

console.log('style-smoke/world_gpkg.png generated')
