import { describe, expect, it } from 'vitest'
import type { Feature } from '../../src/core/feature.js'
import type { HitContext } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import { HitFilter } from '../../src/stream/hit-filter.js'

const layer = {} as Layer

async function pipeFeatures(
    features: Feature[],
    context: HitContext
): Promise<Feature[]> {
    const input = new ReadableStream<Feature>({
        start(controller) {
            for (const feature of features) {
                controller.enqueue(feature)
            }

            controller.close()
        }
    })

    const output = input.pipeThrough(new HitFilter(context))
    const reader = output.getReader()
    const result: Feature[] = []

    try {
        for (;;) {
            const item = await reader.read()
            if (item.done) return result
            result.push(item.value)
        }
    } finally {
        reader.releaseLock()
    }
}

describe('HitFilter', () => {
    const context: HitContext = {
        point: [5, 5],
        bbox: [4, 4, 6, 6],
        tolerance: 1,
        toleranceX: 1,
        toleranceY: 1
    }

    it('keeps features that hit the point', async () => {
        const feature = {
            type: 'Feature',
            layer,
            properties: {},
            geometry: {
                type: 'Point',
                coordinates: [5, 5]
            }
        } as Feature

        await expect(pipeFeatures([feature], context)).resolves.toEqual([
            feature
        ])
    })

    it('filters out features that do not hit the point', async () => {
        const hit = {
            type: 'Feature',
            layer,
            properties: {},
            geometry: {
                type: 'Point',
                coordinates: [5, 5]
            }
        } as Feature

        const miss = {
            type: 'Feature',
            layer,
            properties: {},
            geometry: {
                type: 'Point',
                coordinates: [20, 20]
            }
        } as Feature

        await expect(pipeFeatures([hit, miss], context)).resolves.toEqual([
            hit
        ])
    })
})
