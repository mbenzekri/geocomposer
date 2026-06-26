import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GeoComposer } from '../../src/geo-composer.js'
import type { Feature } from '../../src/core/feature.js'
import { Layer } from '../../src/layer/layer.js'
import { init } from '../test-tools.js'

type DatabaseExample = {
    name: string
    configPath: string
    layerId: string
    expectedProperty: string
}

const databaseExamples: DatabaseExample[] = [
    {
        name: 'PostGIS',
        configPath: 'config/config_postgis.example.json',
        layerId: 'world-postgis',
        expectedProperty: 'name'
    },
    {
        name: 'MSSQL',
        configPath: 'config/config_mssql.example.json',
        layerId: 'world-mssql',
        expectedProperty: 'name'
    },
    {
        name: 'Oracle',
        configPath: 'config/config_oracle.example.json',
        layerId: 'world-oracle',
        expectedProperty: 'NAME'
    }
]

describe('database example configurations', () => {
    beforeEach(() => {
        init()
    })

    afterEach(async () => {
        init()
    })

    test.each(databaseExamples)('$name extended example opens and reads from the database', async (example) => {
        const app = await GeoComposer.from({
            configPath: resolve(example.configPath),
            port: 0
        })

        try {
            await app.open()

            const layer = Layer.registry.get(example.layerId)
            const feature = await readFirst(layer.query({ limit: 1 }))

            expect(feature).not.toBeNull()
            expect(feature?.sourceRef).toEqual(expect.objectContaining({
                storage: 'database'
            }))
            expect(feature?.properties).toHaveProperty(example.expectedProperty)
            await expect(layer.getExtent()).resolves.toEqual([
                expect.any(Number),
                expect.any(Number),
                expect.any(Number),
                expect.any(Number)
            ])
        } finally {
            await app.close()
        }
    }, 60_000)
})

async function readFirst(stream: ReadableStream<Feature>): Promise<Feature | null> {
    const reader = stream.getReader()

    try {
        const result = await reader.read()
        return result.value ?? null
    } finally {
        await reader.cancel().catch(() => undefined)
    }
}
