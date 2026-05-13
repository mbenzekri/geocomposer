import type Style from 'ol/style/Style.js'
import type { GeoFeature } from '../geometry/geo-feature.js'

export type StyleResolver = (
  feature: GeoFeature,
  resolution: number
) => Style | Style[] | null
