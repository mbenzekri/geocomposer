import { describe, expect, it, vi } from 'vitest'
import type { Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import type { Layer } from '../../src/layer/layer.js'
import { MemSource } from '../../src/source/mem-source.js'
import { Source, type StreamOptions } from '../../src/source/source.js'

const layer = {
    id: 'target-layer',
    crs: 'EPSG:4326'
} as Layer

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader()
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

function feature(id: string, coordinates: [number, number], featureLayer: Layer = layer): Feature {
    return {
        type: 'Feature',
        id,
        properties: {
            name: id
        },
        geometry: {
            type: 'Point',
            coordinates
        },
        layer: featureLayer
    }
}

describe('MemSource', () => {
    it('streams initial features with mem sourceRef', async () => {
        const source = new MemSource('mem', [
            feature('a', [1, 2]),
            feature('b', [3, 4])
        ])

        const result = await readAll(source.stream({ layer }))

        expect(result).toEqual([
            expect.objectContaining({
                id: 'a',
                layer,
                crs: 'EPSG:4326',
                sourceRef: {
                    storage: 'mem',
                    sourceId: 'mem',
                    featureIndex: 0,
                    recordIndex: 0
                }
            }),
            expect.objectContaining({
                id: 'b',
                layer,
                crs: 'EPSG:4326',
                sourceRef: {
                    storage: 'mem',
                    sourceId: 'mem',
                    featureIndex: 1,
                    recordIndex: 1
                }
            })
        ])
    })

    it('loads features from provider only once until close', async () => {
        const provider = vi.fn().mockResolvedValue([
            feature('a', [1, 2])
        ])

        const source = new MemSource('mem', provider)

        expect(await readAll(source.stream({ layer }))).toHaveLength(1)
        expect(await readAll(source.stream({ layer }))).toHaveLength(1)
        expect(provider).toHaveBeenCalledTimes(1)

        await source.close()

        expect(await readAll(source.stream({ layer }))).toHaveLength(1)
        expect(provider).toHaveBeenCalledTimes(2)
    })

    it('computes extent from feature geometries', async () => {
        const source = new MemSource('mem', [
            feature('a', [1, 2]),
            feature('b', [5, 6])
        ])

        await expect(source.getExtent(layer)).resolves.toEqual([1, 2, 5, 6])
    })

    it('uses feature bbox when available', async () => {
        const source = new MemSource('mem', [
            {
                ...feature('a', [100, 100]),
                bbox: [1, 2, 3, 4]
            },
            {
                ...feature('b', [10, 20]),
                bbox: [0, 1, 5, 6]
            }
        ])

        await expect(source.getExtent(layer)).resolves.toEqual([0, 1, 5, 6])
    })

    it('returns null extent when no feature has geometry or bbox', async () => {
        const source = new MemSource('mem', [
            {
                type: 'Feature',
                properties: {},
                geometry: null,
                layer
            }
        ])

        await expect(source.getExtent(layer)).resolves.toBeNull()
    })

    it('reads feature by mem sourceRef', async () => {
        const source = new MemSource('mem', [
            feature('a', [1, 2])
        ])

        await expect(source.read({
            storage: 'mem',
            sourceId: 'mem',
            featureIndex: 0
        }, { layer })).resolves.toMatchObject({
            id: 'a',
            sourceRef: {
                storage: 'mem',
                sourceId: 'mem',
                featureIndex: 0,
                recordIndex: 0
            }
        })
    })

    it('returns null when reading missing feature index', async () => {
        const source = new MemSource('mem', [])

        await expect(source.read({
            storage: 'mem',
            sourceId: 'mem',
            featureIndex: 999
        }, { layer })).resolves.toBeNull()
    })

    it('preserves related sourceRef from wrapped features', async () => {
        const originalRef = {
            storage: 'file',
            sourceId: 'file-source',
            offset: 10,
            byteLength: 20
        } as SourceRef

        const source = new MemSource('mem', [
            {
                ...feature('a', [1, 2]),
                sourceRef: originalRef
            }
        ])

        const [result] = await readAll(source.stream({ layer }))

        expect(result.sourceRef).toEqual({
            storage: 'mem',
            sourceId: 'mem',
            featureIndex: 0,
            recordIndex: 0,
            related: {
                source: originalRef
            }
        })
    })

    it('throws when sourceRef belongs to another source', async () => {
        const source = new MemSource('mem', [])

        await expect(source.read({
            storage: 'mem',
            sourceId: 'other',
            featureIndex: 0
        }, { layer })).rejects.toThrow(
            'Mem sourceRef belongs to "other", expected "mem"'
        )
    })

    it('throws when sourceRef does not use mem storage', async () => {
        const source = new MemSource('mem', [])

        await expect(source.read({
            storage: 'file',
            sourceId: 'mem',
            featureIndex: 0
        } as unknown as SourceRef, { layer })).rejects.toThrow(
            'Mem sourceRef must use mem storage'
        )
    })

    it('throws when sourceRef has no featureIndex', async () => {
        const source = new MemSource('mem', [])

        await expect(source.read({
            storage: 'mem',
            sourceId: 'mem'
        } as SourceRef, { layer })).rejects.toThrow(
            'Mem sourceRef must include featureIndex'
        )
    })

    it('errors stream when signal is already aborted', async () => {
        const controller = new AbortController()
        controller.abort('aborted')

        const source = new MemSource('mem', [
            feature('a', [1, 2])
        ])

        const reader = source.stream({
            layer,
            signal: controller.signal
        }).getReader()

        await expect(reader.read()).rejects.toBe('aborted')
    })

    it('errors stream when provider fails', async () => {
        const source = new MemSource('mem', vi.fn().mockRejectedValue(new Error('provider failed')))
        const reader = source.stream({ layer }).getReader()

        await expect(reader.read()).rejects.toThrow('provider failed')
    })

    it('loads features from a wrapped layer source', async () => {
        const wrappedFeature = feature('wrapped', [7, 8])

        const wrappedLayer = {
            id: 'wrapped-layer',
            crs: 'EPSG:3857',
            source: {},
            stream: vi.fn(() =>
                new ReadableStream<Feature>({
                    start(controller) {
                        controller.enqueue(wrappedFeature)
                        controller.close()
                    }
                })
            )
        } as unknown as Layer

        const source = new MemSource('mem', wrappedLayer)
        const result = await readAll(source.stream({ layer }))

        expect(wrappedLayer.stream).toHaveBeenCalled()
        expect(result).toEqual([
            expect.objectContaining({
                id: 'wrapped',
                layer,
                crs: 'EPSG:4326',
                sourceRef: {
                    storage: 'mem',
                    sourceId: 'mem',
                    featureIndex: 0,
                    recordIndex: 0
                }
            })
        ])
    })

    it('loads features through the referenced layer stream without querying the wrapped source directly', async () => {
        const wrappedSource = new CountingSource()
        let layerStreamCalls = 0

        const providerLayer = {
            id: 'provider',
            crs: 'EPSG:4326',
            source: wrappedSource,
            stream: () => {
                layerStreamCalls += 1
                return featureStream(feature('provider-feature', [1, 2], providerLayer))
            }
        } as unknown as Layer

        const source = new MemSource('mem', providerLayer)
        const consumerLayer = {
            id: 'consumer',
            crs: 'EPSG:4326',
            source
        } as unknown as Layer

        const features = await readAll(source.stream({ layer: consumerLayer }))

        expect(features).toHaveLength(1)
        expect(features[0].layer).toBe(consumerLayer)
        expect(layerStreamCalls).toBe(1)
        expect(wrappedSource.streamCalls).toBe(0)
    })

    it('waits for an opening operation before close completes', async () => {
        let resolveProvider!: (features: Feature[]) => void
        let providerStarted!: () => void
        const providerStartedPromise = new Promise<void>((resolve) => {
            providerStarted = resolve
        })

        const provider = vi.fn(() =>
            new Promise<Feature[]>((resolve) => {
                resolveProvider = resolve
                providerStarted()
            })
        )

        const source = new MemSource('mem', provider)

        const extentPromise = source.getExtent(layer)
        await providerStartedPromise

        let closeResolved = false
        const closePromise = source.close()
            .then(() => {
                closeResolved = true
            })

        await Promise.resolve()
        expect(closeResolved).toBe(false)

        resolveProvider([
            feature('a', [1, 2])
        ])

        await expect(extentPromise).resolves.toEqual([1, 2, 1, 2])
        await expect(closePromise).resolves.toBeUndefined()
        expect(closeResolved).toBe(true)
        expect(provider).toHaveBeenCalledTimes(1)
    })

    it('propagates layer stream errors', async () => {
        const wrappedLayer = {
            id: 'wrapped-layer',
            crs: 'EPSG:3857',
            source: {},
            stream: vi.fn(() =>
                new ReadableStream<Feature>({
                    start(controller) {
                        controller.error(new Error('layer stream failed'))
                    }
                })
            )
        } as unknown as Layer

        const source = new MemSource('mem', wrappedLayer)
        const reader = source.stream({ layer }).getReader()

        await expect(reader.read()).rejects.toThrow('layer stream failed')
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
        return featureStream(feature('counted', [1, 2], options.layer))
    }

    async read(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
        return null
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
