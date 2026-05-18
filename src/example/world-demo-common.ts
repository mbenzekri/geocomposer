import Fill from 'ol/style/Fill.js'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import type { BBox } from '../core/types.js'
import type { StyleFn } from '../style/style-fn.js'

const WEB_MERCATOR_MAX = 20037508.342789244

export const WORLD_BBOX_3857: BBox = [
  -WEB_MERCATOR_MAX,
  -WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX,
  WEB_MERCATOR_MAX
]

export const worldStyle = new Style({
  stroke: new Stroke({
    color: '#334155',
    width: 0.75
  }),
  fill: new Fill({
    color: 'rgba(56, 189, 248, 0.18)'
  })
})

export const worldStyleFn: StyleFn = () => worldStyle
