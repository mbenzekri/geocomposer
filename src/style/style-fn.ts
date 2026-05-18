import type Style from 'ol/style/Style.js'
import type { Feature } from '../geometry/feature.js'

export type StyleFn = (
  feature: Feature,
  resolution: number
) => Style | Style[] | null
