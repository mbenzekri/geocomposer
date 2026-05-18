import type { BBox } from '../core/types.js'
export { worldStyle, worldStyleFn } from '../style/world-style.js'

const WEB_MERCATOR_MAX = 20037508.342789244

export const WORLD_BBOX_3857: BBox = [
  -WEB_MERCATOR_MAX,
  -WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX
]
