import { beforeEach, describe, expect, test } from 'vitest'
import type { Feature, SourceRef } from '../../src/core/feature.js'
import type { BBox } from '../../src/core/geometry.js'
import { Crs } from '../../src/core/crs.js'
import { Layer } from '../../src/layer/layer.js'
import { init } from '../test-tools.js'
import { Source, type QueryOptions, type StreamOptions } from '../../src/source/source.js'
import { Style } from '../../src/style/style.js'
import type { StyleFn } from '../../src/style/style-fn.js'

describe('Layer', () => {
    beforeEach(() => {
        init()
    })

    test('builds source-backed and inherited layers in dependency order', async () => {
        const source = setupSource('source-a', [feature('a', [0, 0])], [1, 2, 3, 4])

        const registry = Layer.build({
            child: {
                layer: 'base',
                title: 'Child',
                extent: [2, 1, 4, 3],
                pointProperties: [
                    { x: 'x3857', y: 'y3857', crs: 'EPSG:3857' }
                ]
            },
            base: {
                source: source.id,
                dataset: 'dataset-a',
                title: 'Base',
                abstract: 'Base summary',
                crs: 'EPSG:4326',
                style: 'default',
                pointProperties: [
                    { x: 'x', y: 'y' }
                ]
            }
        })

        const base = registry.get('base')
        const child = registry.get('child')

        expect(base.source).toBe(source)
        expect(base.dataset).toBe('dataset-a')
        expect(base.summary).toBe('Base summary')
        expect(base.pointProperties).toEqual([{ x: 'x', y: 'y', crs: 'EPSG:4326' }])
        expect(child.source.id).toBe('child')
        expect(Source.registry.get('child')).toBe(child.source)
        expect(child.title).toBe('Child')
        expect(child.summary).toBe('Base summary')
        expect(child.dataset).toBeUndefined()
        expect(child.crs).toBe('EPSG:4326')
        expect(child.extent).toEqual([2, 1, 4, 3])
        expect(child.pointProperties).toEqual([{ x: 'x3857', y: 'y3857', crs: 'EPSG:3857' }])
        await expect(child.getExtent()).resolves.toEqual([2, 1, 4, 3])
    })

    test('inherits extent, style, point properties and crs from parent layers', () => {
        setupSource('source-a')
        const base = new Layer('base', {
            source: 'source-a',
            crs: 'EPSG:4326',
            extent: [0, 1, 2, 3],
            style: 'alternate',
            pointProperties: [
                { x: 'label_x', y: 'label_y' }
            ]
        })
        Layer.registry.set(base.id, base)

        const child = new Layer('child', { layer: 'base', crs: 'EPSG:4326' })

        expect(child.crs).toBe(base.crs)
        expect(child.extent).toEqual(base.extent)
        expect(child.style).toBe(alternateStyle)
        expect(child.pointProperties).toEqual(base.pointProperties)
        expect(child.pointProperties).not.toBe(base.pointProperties)
    })

    test('delegates stream, extent and same-crs query options to the source', async () => {
        const source = setupSource('source-a', [
            feature('outside', [10, 10]),
            feature('inside', [1, 1]),
            feature('second', [2, 2])
        ], [7, 8, 9, 10])
        const layer = new Layer('base', { source: source.id, crs: 'EPSG:4326' })
        const signal = new AbortController().signal

        await expect(layer.getExtent()).resolves.toEqual([7, 8, 9, 10])
        expect(await collect(layer.stream({ signal }))).toHaveLength(3)

        const queried = await collect(layer.query({
            bbox: [0, 0, 5, 5],
            properties: ['name'],
            limit: 1,
            offset: 1,
            signal
        }))

        expect(queried.map((item) => item.id)).toEqual(['second'])
        expect(source.streamCalls).toBe(2)
        expect(source.lastQuery).toMatchObject({
            bbox: [0, 0, 5, 5],
            properties: ['name'],
            limit: 1,
            offset: 1,
            signal,
            layer
        })
    })

    test('reprojects query bbox and pages after reprojection for output crs queries', async () => {
        const source = setupSource('source-a', [
            feature('outside', [20, 20]),
            feature('first', [1, 1]),
            feature('second', [2, 2])
        ])
        const layer = new Layer('base', { source: source.id, crs: 'EPSG:4326' })

        const queried = await collect(layer.query({
            crs: 'EPSG:3857',
            bbox: [0, 0, 300_000, 300_000],
            limit: 1,
            offset: 1
        }))

        expect(queried).toHaveLength(1)
        expect(queried[0].id).toBe('second')
        expect(queried[0].crs).toBe('EPSG:3857')
        expect(source.lastQuery?.bbox?.[0]).toBeCloseTo(0)
        expect(source.lastQuery?.bbox?.[1]).toBeCloseTo(0)
        expect(source.lastQuery?.bbox?.[2]).toBeCloseTo(2.6949, 3)
        expect(source.lastQuery?.bbox?.[3]).toBeCloseTo(2.6939, 3)
        expect(source.lastQuery?.limit).toBeUndefined()
        expect(source.lastQuery?.offset).toBeUndefined()

        const allReprojected = await collect(layer.query({ crs: 'EPSG:3857' }))

        expect(allReprojected.map((item) => item.id)).toEqual(['outside', 'first', 'second'])
        expect(source.lastQuery?.bbox).toBeUndefined()
    })

    test('resolves explicit styles and rejects unknown styles', () => {
        setupSource('source-a')
        const layer = new Layer('base', { source: 'source-a', crs: 'EPSG:4326' })

        expect(layer.resolveStyle(undefined)).toBe(defaultStyle)
        expect(layer.resolveStyle('alternate')).toBe(alternateStyle)
        expect(() => layer.resolveStyle('missing')).toThrow('Unknown style "missing"')
        expect(() => new Layer('bad', { source: 'source-a', crs: 'EPSG:4326', style: 'missing' }))
            .toThrow('Unknown style "missing" in layer "bad"')
    })

    test('reports invalid layer data references and unresolved build inputs', () => {
        setupSource('source-a')
        const base = new Layer('base', { source: 'source-a', crs: 'EPSG:4326' })
        Layer.registry.set(base.id, base)

        expect(() => new Layer('bad', { source: 'source-a', layer: 'base', crs: 'EPSG:4326' }))
            .toThrow('Layer "bad" must define either source or layer, not both')
        expect(() => new Layer('bad', { layer: 'base', dataset: 'dataset-a' }))
            .toThrow('Layer "bad" cannot override dataset when it references layer "base"')
        expect(() => new Layer('bad', { crs: 'EPSG:4326' }))
            .toThrow('Layer "bad" must define either source or layer')
        expect(() => Layer.build({ bad: { source: 'missing', crs: 'EPSG:4326' } }))
            .toThrow('Unknown source "missing" in layer "bad"')
        expect(() => Layer.build({ bad: { layer: 'missing' } }))
            .toThrow('Unknown layer "missing" in layer "bad"')
        expect(() => Layer.build({ bad: { crs: 'EPSG:4326' } }))
            .toThrow('Layer "bad" must define either source or layer')
        expect(() => Layer.build({ bad: { source: 'source-a', layer: 'base', crs: 'EPSG:4326' } }))
            .toThrow('Layer "bad" must define either source or layer, not both')
    })

    test('rejects invalid crs and point property declarations', () => {
        setupSource('source-a')
        const base = new Layer('base', { source: 'source-a', crs: 'EPSG:4326' })
        Layer.registry.set(base.id, base)

        expect(() => new Layer('bad', { source: 'source-a' }))
            .toThrow('Layer "bad" must define crs')
        expect(() => new Layer('bad', { source: 'source-a', crs: 'EPSG:9999' }))
            .toThrow('Layer "bad" crs "EPSG:9999" is not declared in projections')
        expect(() => new Layer('bad', { layer: 'base', crs: 'EPSG:3857' }))
            .toThrow('Layer "bad" cannot override crs "EPSG:4326" from layer "base" with "EPSG:3857"')
        expect(() => new Layer('bad', {
            source: 'source-a',
            crs: 'EPSG:4326',
            pointProperties: [{ x: 'coord', y: 'coord' }]
        })).toThrow('Layer "bad" pointProperties must use different x and y properties')
        expect(() => new Layer('bad', {
            source: 'source-a',
            crs: 'EPSG:4326',
            pointProperties: [{ x: 'x', y: 'y', crs: 'EPSG:9999' }]
        })).toThrow('Layer "bad" pointProperties crs "EPSG:9999" is not declared in projections')
    })

    test('rejects memory layer creation when a source already uses the layer name', () => {
        setupSource('source-a')
        const base = new Layer('base', { source: 'source-a', crs: 'EPSG:4326' })
        Layer.registry.set(base.id, base)
        setupSource('child')

        expect(() => new Layer('child', { layer: 'base' }))
            .toThrow('Cannot create memory source for layer "child" because source "child" already exists')
    })

    test('returns the registry if pending entries disappear before error reporting', () => {
        const NativeMap = globalThis.Map

        class EmptyPendingMap<K, V> extends NativeMap<K, V> {
            override get size(): number {
                return 1
            }

            override entries(): MapIterator<[K, V]> {
                return [][Symbol.iterator]() as MapIterator<[K, V]>
            }

            override [Symbol.iterator](): MapIterator<[K, V]> {
                return this.entries()
            }
        }

        try {
            Object.defineProperty(globalThis, 'Map', {
                configurable: true,
                writable: true,
                value: EmptyPendingMap
            })

            expect(Layer.build({ bad: { crs: 'EPSG:4326' } })).toBe(Layer.registry)
        } finally {
            Object.defineProperty(globalThis, 'Map', {
                configurable: true,
                writable: true,
                value: NativeMap
            })
        }
    })
})

const defaultStyle: StyleFn = () => null
const alternateStyle: StyleFn = () => null

class TestSource extends Source {
    readonly type = 'test'
    readonly storage = 'mem'
    streamCalls = 0
    lastQuery: QueryOptions | undefined

    constructor(
        readonly id: string,
        private readonly features: Feature[] = [],
        private readonly extent: BBox | null = null
    ) {
        super()
    }

    async getExtent(_layer: Layer): Promise<BBox | null> {
        return this.extent
    }

    stream(options: StreamOptions): ReadableStream<Feature> {
        this.streamCalls += 1
        return new ReadableStream<Feature>({
            start: (controller) => {
                for (const feature of this.features) {
                    controller.enqueue({
                        ...feature,
                        layer: options.layer,
                        crs: options.layer.crs
                    })
                }
                controller.close()
            }
        })
    }

    override query(options: QueryOptions): ReadableStream<Feature> {
        this.lastQuery = options
        return super.query(options)
    }

    async read(_sourceRef: SourceRef, _options: StreamOptions): Promise<Feature | null> {
        return null
    }
}

function setupRegistries(): void {
    Crs.registry.set('EPSG:4326', new Crs('EPSG:4326', 'WGS 84', 'WGS 84'))
    Crs.registry.set('EPSG:3857', new Crs('EPSG:3857', 'Web Mercator', 'Web Mercator'))
    Style.registry.set('default', { id: 'default', style: defaultStyle })
    Style.registry.set('alternate', { id: 'alternate', style: alternateStyle })
}

function setupSource(id: string, features: Feature[] = [], extent: BBox | null = null): TestSource {
    setupRegistriesIfNeeded()
    const source = new TestSource(id, features, extent)
    Source.registry.set(id, source)
    return source
}

function setupRegistriesIfNeeded(): void {
    if (!Crs.registry.has('EPSG:4326')) setupRegistries()
}

function feature(id: string, coordinates: [number, number]): Feature {
    return {
        type: 'Feature',
        id,
        properties: { name: id },
        geometry: {
            type: 'Point',
            coordinates
        },
        layer: undefined as unknown as Layer
    }
}

async function collect(stream: ReadableStream<Feature>): Promise<Feature[]> {
    const features: Feature[] = []

    for await (const item of stream) {
        features.push(item)
    }

    return features
}
