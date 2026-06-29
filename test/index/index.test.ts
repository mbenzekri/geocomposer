import { beforeEach, describe, expect, it } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import { Crs } from '../../src/core/crs.js'
import { Index } from '../../src/index/index.js'
import { Layer } from '../../src/layer/layer.js'
import { MemSource } from '../../src/source/mem-source.js'
import { Source } from '../../src/source/source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'
import { init } from '../test-tools.js'

beforeEach(() => {
  init()
  setupRegistries()
})

describe('Index', () => {
  it('returns null when get reads an empty stream', async () => {
    const source = registerSource(new MemSource('empty-index-source', []))
    const layer = new Layer('empty-index-layer', { source: source.id, crs: 'EPSG:4326' })
    const index = new EmptyIndex(layer)

    await expect(index.get()).resolves.toBeNull()
  })
})

function registerSource<T extends Source>(source: T): T {
  Source.registry.set(source.id, source)
  return source
}

const defaultStyle: StyleFn = () => null

function setupRegistries(): void {
  Crs.registry.set('EPSG:4326', new Crs('EPSG:4326', 'WGS 84', 'WGS 84'))
  Style.registry.set('default', { id: 'default', style: defaultStyle })
}

class EmptyIndex extends Index<void> {
  constructor(layer: Layer) {
    super('empty', layer)
  }

  stream(): ReadableStream<Feature> {
    return new ReadableStream({
      start(controller) {
        controller.close()
      }
    })
  }
}
