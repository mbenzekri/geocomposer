import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Crs } from '../core/crs.js'
import { Layer } from '../layer/layer.js'
import { MemSource } from '../source/mem-source.js'
import { Source } from '../source/source-build.js'
import { getMap } from '../ogc/get-map.js'
import { createDynamicStyleFn } from '../style/dynamic-style.js'
import { Style } from '../style/style.js'

const source = new MemSource('demo', (layer) => [
  {
    layer,
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
    layer,
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
    layer,
    type: 'Feature',
    id: 3,
    properties: { name: 'point' },
    geometry: {
      type: 'Point',
      coordinates: [2.35, 48.85]
    }
  }
])
const style = await createDynamicStyleFn('demo', {
  cacheKey: "=> F.geometry?.type ?? 'unknown'",
  static: {
    point: {
      when: "=> ['Point', 'MultiPoint'].includes(F.geometry?.type ?? '')",
      image: {
        type: 'Circle',
        radius: 4,
        fill: { color: 'rgba(220, 0, 0, 0.9)' },
        stroke: { color: '#ffffff', width: 1 }
      }
    },
    line: {
      when: "=> ['LineString', 'MultiLineString'].includes(F.geometry?.type ?? '')",
      stroke: {
        color: '#0055ff',
        width: 2
      }
    },
    polygon: {
      when: "=> ['Polygon', 'MultiPolygon'].includes(F.geometry?.type ?? '')",
      stroke: {
        color: '#0055ff',
        width: 1
      },
      fill: {
        color: 'rgba(0, 85, 255, 0.15)'
      }
    }
  }
})
registerLayerDependencies('demo', source, 'demo-style', style)

const layer = new Layer('demo', {
  source: 'demo',
  crs: 'EPSG:4326',
  style: 'demo-style'
})

await rm('style-smoke/map.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const image = await getMap({
  layers: [layer],
  styles: [],
  bbox: [-6, 42, 6, 50],
  width: 800,
  height: 600,
  crs: 'EPSG:4326'
})

await writeFile('style-smoke/map.png', image)
console.log('style-smoke/map.png generated')

function registerLayerDependencies(
  sourceName: string,
  source: Source,
  styleName: string,
  style: Awaited<ReturnType<typeof createDynamicStyleFn>>
): void {
  if (!Crs.registry.has('EPSG:4326')) {
    Crs.registry.set('EPSG:4326', new Crs('EPSG:4326', 'WGS 84', 'WGS 84'))
  }

  Source.registry.set(sourceName, source)
  Style.registry.set(styleName, { name: styleName, style })
}
