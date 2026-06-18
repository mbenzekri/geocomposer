import { describe, expect, it } from 'vitest'
import {
    coordinateToPixel,
    createHitContext,
    pixelToCoordinate,
    transformPositionToPixels,
    transformPositionsToPixels
} from '../../src/core/geometry.js'

describe('geometry', () => {
    it('creates a hit context from pixel tolerance', () => {
        const result = createHitContext(2, [0, 0, 100, 50], 100, 50, [10, 20])

        expect(result).toEqual({
            point: [10, 20],
            bbox: [8, 18, 12, 22],
            tolerance: 2,
            toleranceX: 2,
            toleranceY: 2
        })
    })

    it('converts a pixel center to a coordinate', () => {
        expect(pixelToCoordinate([0, 0, 100, 100], 10, 10, 0, 0)).toEqual([5, 95])
    })

    it('converts a coordinate to a pixel position', () => {
        expect(coordinateToPixel(50, 50, [0, 0, 100, 100], 10, 10)).toEqual([5, 5])
    })

    it('preserves extra position dimensions when transforming to pixels', () => {
        expect(transformPositionToPixels([50, 50, 12], [0, 0, 100, 100], 10, 10)).toEqual([5, 5, 12])
    })

    it('transforms multiple positions to pixels', () => {
        expect(transformPositionsToPixels(
            [
                [0, 100],
                [100, 0]
            ],
            [0, 0, 100, 100],
            10,
            10
        )).toEqual([
            [0, 0],
            [10, 10]
        ])
    })
})
