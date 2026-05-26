import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Layer } from '../layer/layer.js'
import { MemSource } from '../source/mem-source.js'
import { renderMap } from '../ogc/render-map.js'
import { defaultStyleFn } from '../style/default-style.js'

const source = new MemSource('demo', 'EPSG:4326', [
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
const layer = new Layer('demo', {
  source,
  styles: [{
    name: 'default',
    style: defaultStyleFn
  }]
})

await rm('style-smoke/map.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const image = await renderMap({
  layer,
  bbox: [-6, 42, 6, 50],
  width: 800,
  height: 600,
  crs: 'EPSG:4326'
})

await writeFile('style-smoke/map.png', image)
console.log('style-smoke/map.png generated')
