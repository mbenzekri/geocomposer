import { describe, expect, test } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import {
  PropertyFilter,
  comparePropertyValues,
  matchesPropertyFilter,
  toComparablePropertyValue
} from '../../src/stream/property-filter.js'

describe('PropertyFilter', () => {
  test('matches equality and range criteria for comparable values', async () => {
    const features = [
      feature({ rank: 1 }),
      feature({ rank: 5 }),
      feature({ rank: 9 }),
      feature({ rank: Number.NaN }),
      feature(null)
    ]

    expect(matchesPropertyFilter(features[1], { property: 'rank', op: '==', value: 5 })).toBe(true)
    expect(matchesPropertyFilter(features[1], { property: 'rank', op: '<', value: 6 })).toBe(true)
    expect(matchesPropertyFilter(features[1], { property: 'rank', op: '>', value: 6 })).toBe(false)
    expect(matchesPropertyFilter(features[3], { property: 'rank', op: '==', value: Number.NaN })).toBe(false)
    expect(matchesPropertyFilter(features[4], { property: 'rank', op: '==', value: 1 })).toBe(false)
    expect(comparePropertyValues('1', 1)).toBeNull()
    expect(toComparablePropertyValue({})).toBeNull()

    await expect(collect(stream(features).pipeThrough(new PropertyFilter({
      property: 'rank',
      op: '>',
      value: 1
    })))).resolves.toEqual([features[1], features[2]])
  })
})

function feature(properties: Feature['properties']): Feature {
  return {
    type: 'Feature',
    layer: {} as Feature['layer'],
    properties,
    geometry: null
  }
}

function stream(features: Feature[]): ReadableStream<Feature> {
  return new ReadableStream({
    start(controller) {
      for (const feature of features) controller.enqueue(feature)
      controller.close()
    }
  })
}

async function collect<T>(input: ReadableStream<T>): Promise<T[]> {
  const reader = input.getReader()
  const values: T[] = []

  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return values
      values.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
}
