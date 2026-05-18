import Style from 'ol/style/Style.js'
import Stroke from 'ol/style/Stroke.js'
import Fill from 'ol/style/Fill.js'
import CircleStyle from 'ol/style/Circle.js'
import type { StyleFn } from './style-fn.js'

const pointStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: new Fill({ color: 'rgba(220, 0, 0, 0.9)' }),
    stroke: new Stroke({ color: '#ffffff', width: 1 })
  })
})

const lineStyle = new Style({
  stroke: new Stroke({
    color: '#0055ff',
    width: 2
  })
})

const polygonStyle = new Style({
  stroke: new Stroke({
    color: '#0055ff',
    width: 1
  }),
  fill: new Fill({
    color: 'rgba(0, 85, 255, 0.15)'
  })
})

export const defaultStyleFn: StyleFn = (feature) => {
  switch (feature.geometry?.type) {
    case 'Point':
    case 'MultiPoint':
      return pointStyle

    case 'LineString':
    case 'MultiLineString':
      return lineStyle

    case 'Polygon':
    case 'MultiPolygon':
      return polygonStyle

    default:
      return null
  }
}
