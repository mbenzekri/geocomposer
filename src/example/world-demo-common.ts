import type { BBox } from '../core/geometry.js'
import type { StyleFn } from '../style/style-fn.js'
import { createDynamicStyleFn } from '../style/dynamic-style.js'

export const worldStyleFn: StyleFn = await createDynamicStyleFn('world-smoke', {
  cacheKey: 'world-smoke',
  static: {
    country: {
      stroke: {
        color: '#334155',
        width: 0.75
      },
      fill: {
        color: 'rgba(56, 189, 248, 0.18)'
      }
    }
  }
})

const WEB_MERCATOR_MAX = 20037508.342789244

export const WORLD_BBOX_3857: BBox = [
  -WEB_MERCATOR_MAX,
  -WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX
]
