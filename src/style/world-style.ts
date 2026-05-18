import Fill from 'ol/style/Fill.js'
import Stroke from 'ol/style/Stroke.js'
import Style from 'ol/style/Style.js'
import type { StyleFn } from './style-fn.js'

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
