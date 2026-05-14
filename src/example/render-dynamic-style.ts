import { mkdir, rm, writeFile } from 'node:fs/promises'
import { renderGetMap } from '../ogc/render-get-map.js'
import { MemoryGeoSource } from '../source/memory-geo-source.js'
import { createDynamicStyleResolver } from '../style/dynamic-style-resolver.js'

const source = new MemoryGeoSource('dynamic-style-demo', 'EPSG:4326', [
  {
    type: 'Feature',
    id: 1,
    properties: { kind: 'area', name: 'Zone' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-4, 43],
        [4, 43],
        [4, 48],
        [-4, 48],
        [-4, 43]
      ]]
    }
  },
  {
    type: 'Feature',
    id: 2,
    properties: { kind: 'route', name: 'Axe' },
    geometry: {
      type: 'LineString',
      coordinates: [
        [-5, 44],
        [-1, 46],
        [5, 47]
      ]
    }
  },
  {
    type: 'Feature',
    id: 3,
    properties: { kind: 'city', name: 'Paris' },
    geometry: {
      type: 'Point',
      coordinates: [2.35, 48.85]
    }
  }
])

const styleResolver = await createDynamicStyleResolver('dynamic-demo', {
  constants: {
    colors: {
      area: 'rgba(22, 163, 74, 0.22)',
      route: '#2563eb',
      city: '#dc2626'
    }
  },
  definitions: {
    kind: "=> F.get('kind') ?? '?'",
    label: "=> F.get('name') ?? ''",
    color: "=> C.colors[D.kind] ?? '#334155'",
    pointLabel: {
      type: 'Text',
      font: 'bold 15px sans-serif',
      offsetY: -20,
      fill: { type: 'Fill', color: '#111827' },
      stroke: { type: 'Stroke', color: '#ffffff', width: 3 }
    }
  },
  scales: [0, 100000000],
  cacheKey: '=> [F.geometry?.type, D.kind]',
  static: {
    polygon: {
      when: "=> F.geometry?.type === 'Polygon'",
      fill: { type: 'Fill', color: '=> D.color' },
      stroke: { type: 'Stroke', color: '#166534', width: 2 }
    },
    line: {
      when: "=> F.geometry?.type === 'LineString'",
      stroke: { type: 'Stroke', color: '=> D.color', width: 4 }
    },
    point: {
      when: "=> F.geometry?.type === 'Point'",
      image: {
        type: 'Circle',
        radius: 9,
        fill: { type: 'Fill', color: '=> D.color' },
        stroke: { type: 'Stroke', color: '#ffffff', width: 2 }
      },
      text: '=> D.pointLabel'
    }
  },
  dynamic: [
    { pointer: '#/*/text/text', value: '=> D.label' }
  ]
})

await rm('style-smoke/dynamic-style.png', { force: true })
await mkdir('style-smoke', { recursive: true })

const image = await renderGetMap({
  source,
  bbox: [-6, 42, 6, 50],
  width: 800,
  height: 600,
  crs: 'EPSG:4326',
  styleResolver
})

await writeFile('style-smoke/dynamic-style.png', image)
console.log('style-smoke/dynamic-style.png generated')
