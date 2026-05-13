import type Style from 'ol/style/Style.js'
import type { PixelFeature } from '../transform/world-to-pixel-transform.js'

export type StyleResolver = (
  feature: PixelFeature,
  resolution: number
) => Style | Style[] | null
