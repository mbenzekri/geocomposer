import { mkdir, rm, writeFile } from 'node:fs/promises'
import { MemoryGeoSource } from '../source/memory-geo-source.js'
import { renderGetMap } from '../ogc/render-get-map.js'
import { defaultStyleResolver } from '../style/default-style-resolver.js'

const source = new MemoryGeoSource('demo', 'EPSG:4326', [
  {
    type: 'Feature',
    id: 1,
    properties: { name: 'line' },
    geometry: {
      type: 'LineString',
      coordinates: [
        [-5, 43],
        [0, 46],
        [5, 48]
      ]
    }
  },
  {
    type: 'Feature',
    id: 2,
    properties: { name: 'polygon' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-3, 44],
          [3, 44],
          [3, 47],
          [-3, 47],
          [-3, 44]
        ]
      ]
    }
  },
  {
    type: 'Feature',
    id: 3,
    properties: { name: 'point' },
    geometry: {
      type: 'Point',
      coordinates: [2.35, 48.85]
    }
  }
])

await rm('style-smoke/map.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const image = await renderGetMap({
  source,
  bbox: [-6, 42, 6, 50],
  width: 800,
  height: 600,
  crs: 'EPSG:4326',
  styleResolver: defaultStyleResolver
})

await writeFile('style-smoke/map.png', image)
console.log('style-smoke/map.png generated')
