import { beforeEach, describe, expect, it, test } from 'vitest';
import { Layer } from '../../src/layer/layer.js';
import { config_full_path, config_min, init, writeConf } from '../test-tools.js'
import { GeoComposer } from '../../src/geo-composer.js';
import { Source } from '../../src/source/source.js';
import { Style } from '../../src/style/style.js';

describe('Layer', () => {
    beforeEach(() => {
        init()
    })
    test('Layer from minimal config', async () => {
        
        await expect(await GeoComposer.from({ configPath : config_full_path})).toBeInstanceOf(GeoComposer)
        expect(Layer.registry.all.length).toBeGreaterThan(1)
        expect(Layer.registry.get('world')).toBeInstanceOf(Layer)
        expect(Source.registry.get('world')).toBeInstanceOf(Source)
        expect(Layer.registry.get('world').source).toBe(Source.registry.get('world'))
        expect(Style.registry.get('world').style).toBe(Layer.registry.get('world').style)
    })

    test('Layer must have a default style', async () => {
        config_min.layers.world.style = undefined
        const configPath = writeConf('layer_missing_style.json',config_min)
        await expect(await GeoComposer.from({ configPath})).toBeInstanceOf(GeoComposer)
    })


})