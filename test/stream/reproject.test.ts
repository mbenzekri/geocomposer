import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { Point } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import { Reproject } from '../../src/stream/reproject.js'

describe('Reproject', () => {
  test('sets target crs without changing geometry when no transformation is needed', async () => {
    const feature = pointFeature('same-crs', [2, 49], layer())

    await expect(collect([feature], 'EPSG:4326', 'EPSG:4326')).resolves.toMatchObject([{
      id: 'same-crs',
      crs: 'EPSG:4326',
      geometry: {
        type: 'Point',
        coordinates: [2, 49]
      },
      properties: { name: 'same-crs' }
    }])
  })

  test('reprojects geometry and recalculates bbox', async () => {
    const feature = pointFeature('projected', [2, 49], layer())
    const [projected] = await collect([feature], 'EPSG:4326', 'EPSG:3857')

    expect(projected.crs).toBe('EPSG:3857')
    expect(projected.geometry).toMatchObject({ type: 'Point' })
    const geometry = projected.geometry as Point
    expect(geometry.coordinates[0]).toBeCloseTo(222638.98, 1)
    expect(geometry.coordinates[1]).toBeCloseTo(6274861.39, 1)
    expect(projected.bbox?.[0]).toBeCloseTo(geometry.coordinates[0])
    expect(projected.bbox?.[1]).toBeCloseTo(geometry.coordinates[1])
  })

  test('reprojects configured point properties independently from geometry', async () => {
    const sourceLayer = layer([{
      x: 'labelX',
      y: 'labelY',
      crs: 'EPSG:4326'
    }, {
      x: 'targetX',
      y: 'targetY',
      crs: 'EPSG:3857'
    }])
    const feature = {
      ...pointFeature('labels', [0, 0], sourceLayer),
      properties: {
        labelX: 2,
        labelY: 49,
        targetX: 100,
        targetY: 200,
        name: 'Paris label'
      }
    }
    const [projected] = await collect([feature], 'EPSG:3857', 'EPSG:3857')

    expect(projected.geometry).toEqual(feature.geometry)
    expect(projected.properties?.labelX).toBeCloseTo(222638.98, 1)
    expect(projected.properties?.labelY).toBeCloseTo(6274861.39, 1)
    expect(projected.properties?.targetX).toBe(100)
    expect(projected.properties?.targetY).toBe(200)
    expect(projected.properties?.name).toBe('Paris label')
  })

  test('keeps null geometry and null properties', async () => {
    const sourceLayer = layer([{
      x: 'labelX',
      y: 'labelY',
      crs: 'EPSG:4326'
    }])
    const feature: Feature = {
      type: 'Feature',
      id: 'nulls',
      properties: null,
      layer: sourceLayer,
      bbox: [1, 2, 3, 4],
      geometry: null
    }

    await expect(collect([feature], 'EPSG:4326', 'EPSG:3857')).resolves.toMatchObject([{
      id: 'nulls',
      crs: 'EPSG:3857',
      properties: null,
      bbox: [1, 2, 3, 4],
      geometry: null
    }])
  })

  test('keeps undefined bbox for null geometry without source bbox', async () => {
    const feature: Feature = {
      type: 'Feature',
      id: 'null-geometry-no-bbox',
      properties: { labelX: 2, labelY: 49 },
      layer: layer([{
        x: 'labelX',
        y: 'labelY',
        crs: 'EPSG:4326'
      }]),
      geometry: null
    }

    const [projected] = await collect([feature], 'EPSG:4326', 'EPSG:3857')

    expect(projected.bbox).toBeUndefined()
    expect(projected.geometry).toBeNull()
    expect(projected.properties?.labelX).toBeCloseTo(222638.98, 1)
  })
})

async function collect(features: Feature[], inputCrs: string, targetCrs: string): Promise<Feature[]> {
  const reader = new ReadableStream<Feature>({
    start(controller) {
      for (const feature of features) controller.enqueue(feature)
      controller.close()
    }
  })
    .pipeThrough(new Reproject(inputCrs, targetCrs))
    .getReader()
  const result: Feature[] = []

  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return result
      result.push(item.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function layer(pointProperties: Layer['pointProperties'] = []): Layer {
  return {
    id: 'test-layer',
    pointProperties
  } as unknown as Layer
}

function pointFeature(id: string, coordinates: [number, number], featureLayer: Layer): Feature {
  return {
    type: 'Feature',
    id,
    properties: { name: id },
    layer: featureLayer,
    geometry: {
      type: 'Point',
      coordinates
    }
  }
}
