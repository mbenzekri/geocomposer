import { beforeEach, describe, expect, test } from 'vitest'
import { Crs } from '../../src/core/crs.js'
import { init } from '../test-tools.js'

beforeEach(() => {
  init()
})

describe('Crs', () => {
  test('requires a code and defaults name/title to the code', () => {
    expect(() => new Crs('')).toThrow('CRS code is required')

    const crs = new Crs('EPSG:4326')

    expect(crs.code).toBe('EPSG:4326')
    expect(crs.name).toBe('EPSG:4326')
    expect(crs.title).toBe('EPSG:4326')
    expect(crs.toString()).toBe('EPSG:4326')
  })

  test('builds configured CRS definitions', () => {
    const registry = Crs.build({
      'EPSG:4326': {
        name: 'WGS 84',
        title: 'World Geodetic System 1984'
      },
      'EPSG:3857': {
        title: 'Web Mercator',
        proj4: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
      }
    })

    expect(registry.get('EPSG:4326')).toMatchObject({
      code: 'EPSG:4326',
      name: 'WGS 84',
      title: 'World Geodetic System 1984'
    })
    expect(registry.get('EPSG:3857').proj).toBeDefined()
    expect(registry.get('EPSG:4326').coordinatePrecision).toBe(8)
    expect(registry.get('EPSG:3857').coordinatePrecision).toBe(2)
  })

  test('supports explicit coordinate precision overrides', () => {
    const registry = Crs.build({
      'EPSG:2154': {
        title: 'Lambert-93',
        proj4: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs +type=crs',
        precision: 1
      }
    })

    expect(registry.get('EPSG:2154').coordinatePrecision).toBe(1)
    expect(() => Crs.build({
      BAD: {
        title: 'Bad',
        precision: -1
      }
    })).toThrow('CRS "BAD" precision must be a non-negative integer')
  })
})
