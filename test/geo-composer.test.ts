import { beforeEach, describe, expect, it, test } from 'vitest';
import { GeoComposer } from '../src/geo-composer.js';
import { config_min, config_base, config_full_path, init, writeConf } from './test-tools.js'

describe('GeoComposer', () => {
    beforeEach(() => {
        init()
    })

    test('Start GeoComposer from minimal config', async () => {
        
        const configPath = writeConf('config_min_start.json', config_min)
        await expect(await GeoComposer.from({ configPath })).toBeInstanceOf(GeoComposer)
    })
    test('Start GeoComposer from base config', async () => {
        
        const configPath = writeConf('config_base_start.json', config_base)
        await expect(await GeoComposer.from({ configPath })).toBeInstanceOf(GeoComposer)
    })
    test('Start GeoComposer from full config', async () => {
        await expect(await GeoComposer.from({ configPath: config_full_path })).toBeInstanceOf(GeoComposer)
    })
})