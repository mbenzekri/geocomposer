import { afterEach, describe, expect, it } from 'vitest'
import {
  getTileMatrixSet,
  TileMatrixSet,
  tileMatrixSets,
  type TileMatrixSetJson
} from '../../src/tileset/tile-matrix-set.js'

const customEntry = (overrides: Partial<TileMatrixSetJson> = {}): TileMatrixSetJson => ({
  crs: 'EPSG:3857',
  tileMatrices: [
    {
      scaleDenominator: 1000,
      topLeftCorner: [100, 200],
      tileWidth: 512,
      tileHeight: 256,
      matrixWidth: 3,
      matrixHeight: 2
    }
  ],
  ...overrides
})

describe('TileMatrixSet', () => {
  afterEach(() => {
    TileMatrixSet.build({})
  })

  it('uses explicit matrix dimensions, tile sizes and identifiers', () => {
    const matrixSet = new TileMatrixSet('CustomGrid', {
      title: 'Custom grid',
      crs: 'EPSG:3857',
      tileMatrices: [
        {
          id: 'level-zero',
          scaleDenominator: 1000,
          topLeftCorner: [100, 200],
          tileWidth: 512,
          tileHeight: 256,
          matrixWidth: 3,
          matrixHeight: 2
        },
        {
          id: 'level-one',
          scaleDenominator: 500,
          topLeftCorner: [100, 200],
          tileWidth: 512,
          tileHeight: 256,
          matrixWidth: 6,
          matrixHeight: 4
        }
      ]
    })

    expect(matrixSet.matrixId(1)).toBe('level-one')
    expect(matrixSet.zoomFromMatrixId('CustomGrid:level-one')).toBe(1)
    expect(matrixSet.matrix(0)).toMatchObject({
      tileWidth: 512,
      tileHeight: 256,
      matrixWidth: 3,
      matrixHeight: 2
    })

    expect(matrixSet.bbox(0, 2, 0)).toEqual([
      expect.closeTo(386.72),
      expect.closeTo(128.32),
      expect.closeTo(530.08),
      expect.closeTo(200)
    ])
    expect(() => matrixSet.validateCoord(0, 3, 0)).toThrow('columns 0..2')
    expect(() => matrixSet.validateCoord(0, 0, 2)).toThrow('rows 0..1')
    expect(() => matrixSet.matrix(9)).toThrow('TileMatrixSet "CustomGrid" has no matrix for zoom 9')
    expect(() => matrixSet.zoomFromMatrixId('0')).toThrow('Unknown TILEMATRIX')
  })

  it('normalizes defaults and resolves unqualified matrix identifiers', () => {
    const matrixSet = new TileMatrixSet('DefaultGrid', customEntry({
      crs: 'EPSG:2154'
    }))

    expect(matrixSet.title).toBe('DefaultGrid')
    expect(matrixSet.supportedCrs).toBe('urn:ogc:def:crs:EPSG::2154')
    expect(matrixSet.matrixId(0)).toBe('0')
    expect(matrixSet.zoomFromMatrixId('0')).toBe(0)
    expect(matrixSet.matrix(0)).toMatchObject({
      id: '0',
      cellSize: expect.closeTo(0.28),
      topLeftCorner: [100, 200]
    })
  })

  it('keeps explicit supported CRS values and non EPSG CRS names', () => {
    const explicit = new TileMatrixSet('ExplicitGrid', customEntry({
      supportedCrs: 'urn:custom:grid'
    }))
    const named = new TileMatrixSet('NamedGrid', customEntry({
      crs: 'CRS:84'
    }))

    expect(explicit.supportedCrs).toBe('urn:custom:grid')
    expect(named.supportedCrs).toBe('CRS:84')
  })

  it('builds the registry with builtins and custom matrix sets', () => {
    const registry = TileMatrixSet.build({
      LocalGrid: customEntry({
        crs: 'EPSG:4326'
      })
    })

    expect(registry.get('LocalGrid').crs).toBe('EPSG:4326')
    expect(registry.get('WebMercatorQuad').matrixId(0)).toBe('0')
    expect(tileMatrixSets().map((matrixSet) => matrixSet.id)).toEqual([
      'WebMercatorQuad',
      'GoogleMapsCompatible',
      'WorldCRS84Quad',
      'LocalGrid'
    ])
  })

  it('rejects invalid set definitions', () => {
    expect(() => new TileMatrixSet('', customEntry())).toThrow('TileMatrixSet id must not be empty')
    expect(() => new TileMatrixSet('NoCrs', customEntry({
      crs: ''
    }))).toThrow('TileMatrixSet "NoCrs" must define crs')
    expect(() => new TileMatrixSet('Empty', customEntry({
      tileMatrices: []
    }))).toThrow('TileMatrixSet "Empty" must define at least one tile matrix')
    expect(() => new TileMatrixSet('DuplicateId', customEntry({
      tileMatrices: [
        {
          id: 'same',
          scaleDenominator: 1000,
          topLeftCorner: [0, 0],
          tileWidth: 256,
          tileHeight: 256,
          matrixWidth: 1,
          matrixHeight: 1
        },
        {
          id: 'same',
          scaleDenominator: 500,
          topLeftCorner: [0, 0],
          tileWidth: 256,
          tileHeight: 256,
          matrixWidth: 2,
          matrixHeight: 2
        }
      ]
    }))).toThrow('TileMatrixSet "DuplicateId" has duplicate tile matrix id "same"')
  })

  it('rejects invalid matrix definitions', () => {
    expect(() => new TileMatrixSet('BadTopLeftLength', customEntry({
      tileMatrices: [{
        ...customEntry().tileMatrices[0],
        topLeftCorner: [0, 0, 0]
      }]
    }))).toThrow('TileMatrix at zoom 0 topLeftCorner must contain exactly two numbers')

    expect(() => new TileMatrixSet('BadTopLeftValue', customEntry({
      tileMatrices: [{
        ...customEntry().tileMatrices[0],
        topLeftCorner: [0, Number.NaN]
      }]
    }))).toThrow('TileMatrix at zoom 0 topLeftCorner must contain finite numbers')

    expect(() => new TileMatrixSet('BadScale', customEntry({
      tileMatrices: [{
        ...customEntry().tileMatrices[0],
        scaleDenominator: 0
      }]
    }))).toThrow('TileMatrix "0" scaleDenominator must be a positive number')

    expect(() => new TileMatrixSet('BadCell', customEntry({
      tileMatrices: [{
        ...customEntry().tileMatrices[0],
        cellSize: Number.POSITIVE_INFINITY
      }]
    }))).toThrow('TileMatrix "0" cellSize must be a positive number')

    expect(() => new TileMatrixSet('BadTileWidth', customEntry({
      tileMatrices: [{
        ...customEntry().tileMatrices[0],
        tileWidth: 1.5
      }]
    }))).toThrow('TileMatrix "0" tileWidth must be a positive integer')
  })

  it('registers common builtin tile matrix sets', () => {
    const webMercator = getTileMatrixSet('WebMercatorQuad')
    const googleMapsCompatible = getTileMatrixSet('GoogleMapsCompatible')
    const crs84 = getTileMatrixSet('WorldCRS84Quad')

    expect(googleMapsCompatible.bbox(1, 1, 1)).toEqual(webMercator.bbox(1, 1, 1))
    expect(() => getTileMatrixSet('EPSG:3857')).toThrow('Unknown tile matrix set')
    expect(crs84.crs).toBe('CRS:84')
    expect(crs84.matrix(0)).toMatchObject({
      tileWidth: 256,
      tileHeight: 256,
      matrixWidth: 2,
      matrixHeight: 1
    })
    expect(crs84.bbox(0, 0, 0)).toEqual([
      expect.closeTo(-180),
      expect.closeTo(-90),
      expect.closeTo(0),
      expect.closeTo(90)
    ])
    expect(crs84.bbox(0, 1, 0)).toEqual([
      expect.closeTo(0),
      expect.closeTo(-90),
      expect.closeTo(180),
      expect.closeTo(90)
    ])
  })
})
