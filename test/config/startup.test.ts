import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { GeoComposer } from '../../src/geo-composer.js'
import { Service } from '../../src/service/service-build.js'

describe('configuration and startup', () => {
  test('config_red validates and opens/closes sources without external services', async () => {
    const app = await GeoComposer.from({
      configPath: resolve('config/config_red.json'),
      port: 0
    })

    try {
      await app.open()

      expect(Service.registry.has('wms')).toBe(true)
    } finally {
      await app.close()
    }

    expect(app.server.listening).toBe(false)
  })
})
