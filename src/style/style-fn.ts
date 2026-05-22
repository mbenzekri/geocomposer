import type Style from 'ol/style/Style.js'
import type { CrsCode } from '../core/types.js'
import type { Feature } from '../geometry/feature.js'

export type StyleContext = {
  crs?: CrsCode
  resolutionByUnit?: Partial<Record<'m' | 'dd', number>>
  scaleDenominator?: number
}

export type StyleFn = (
  feature: Feature,
  resolution: number,
  context?: StyleContext
) => Style | Style[] | null
