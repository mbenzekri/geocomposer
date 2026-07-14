import type Style from 'ol/style/Style.js'
import {
  DEFAULT_DPI,
  getGroundResolutionMeters,
  INCHES_PER_METER,
  METERS_PER_DEGREE,
  type BBox,
  type CrsCode
} from '../core/geometry.js'
import type { Feature } from '../core/feature.js'

export type StyleContext = {
  crs?: CrsCode
  resolutionByUnit?: Partial<Record<'m' | 'dd', number>>
  scaleDenominator?: number
}

export function createStyleContext(
  crs: CrsCode,
  bbox: BBox,
  imageResolution: number,
  pixelRatio: number
): StyleContext {
  const viewResolution = imageResolution * pixelRatio
  const groundResolution = getGroundResolutionMeters(crs, bbox, viewResolution)

  return {
    crs,
    resolutionByUnit: {
      m: groundResolution,
      dd: groundResolution / METERS_PER_DEGREE
    },
    scaleDenominator: groundResolution * INCHES_PER_METER * DEFAULT_DPI
  }
}

export type StyleVisibilityFn = (
  resolution: number,
  context?: StyleContext
) => boolean

export type StyleFn = ((
  feature: Feature,
  resolution: number,
  context?: StyleContext
) => Style | Style[] | null) & {
  visibleAtResolution?: StyleVisibilityFn
}
