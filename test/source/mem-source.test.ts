import { describe, expect, test } from 'vitest'
import type { Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import { MemSource } from '../../src/source/mem-source.js'
import { Source, type StreamOptions } from '../../src/source/source.js'

describe('MemSource', () => {
  test('loads features through the referenced layer stream', async () => {
    const source = new CountingSource()
    let layerStreamCalls = 0

    const providerLayer = {
      id: 'provider',
      crs: 'EPSG:4326',
      source,
      stream: () => {
        layerStreamCalls += 1
        return featureStream(feature(providerLayer))
      }
    } as unknown as Layer

    const mem = new MemSource('mem', providerLayer)
    const consumerLayer = {
      id: 'consumer',
      crs: 'EPSG:4326',
      source: mem
    } as unknown as Layer

    const features = await collect(mem.stream({ layer: consumerLayer }))

    expect(features).toHaveLength(1)
    expect(features[0].layer).toBe(consumerLayer)
    expect(layerStreamCalls).toBe(1)
    expect(source.streamCalls).toBe(0)
  })
})

class CountingSource extends Source {
  readonly type = 'counting'
  readonly storage = 'mem'
  streamCalls = 0

  constructor() {
    super('counting')
  }

  async getExtent(_layer: Layer): Promise<BBox | null> {
    return null
  }

  stream(options: StreamOptions): ReadableStream<Feature> {
    this.streamCalls += 1
    return featureStream(feature(options.layer))
  }

  async read(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
    return null
  }
}

function feature(layer: Layer): Feature {
  return {
    type: 'Feature',
    layer,
    properties: {},
    geometry: null
  }
}

function featureStream(item: Feature): ReadableStream<Feature> {
  return new ReadableStream<Feature>({
    start(controller) {
      controller.enqueue(item)
      controller.close()
    }
  })
}

async function collect(stream: ReadableStream<Feature>): Promise<Feature[]> {
  const features: Feature[] = []

  for await (const feature of stream) {
    features.push(feature)
  }

  return features
}
