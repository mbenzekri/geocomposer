import { describe, expect, it } from 'vitest'
import { getTileMatrixSet, TileMatrixSet } from '../../src/tileset/tile-matrix-set.js'

describe('TileMatrixSet', () => {
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
    expect(() => matrixSet.zoomFromMatrixId('0')).toThrow('Unknown TILEMATRIX')
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
